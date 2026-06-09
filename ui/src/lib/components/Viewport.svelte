<script lang="ts">
  import "@xterm/xterm/css/xterm.css";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { WebLinksAddon } from "@xterm/addon-web-links";
  import type { GitState, Issue, Leftover, Session, SessionUsage, UsageLimits } from "$lib/types";
  import { STATUS_COLOR, statusLabel, formatTokens, canResume } from "$lib/format";
  import { projectIcons } from "$lib/projectIcons.svelte";
  import { hotterGauge } from "./usage-gauges";
  import { connectPty, type PtyConn } from "$lib/pty";
  import { theme, xtermTheme, xtermMinContrast } from "$lib/theme.svelte";
  import { tick } from "svelte";
  import {
    getSessionUsage,
    uploadImage,
    resumeSession as apiResumeSession,
    renameSession,
    getLeftovers,
    setSessionAutopilot,
  } from "$lib/api";
  import { imageFilesFromItems } from "$lib/clipboard";
  import { composeKeystrokes } from "$lib/compose";
  import { shouldForwardEscape } from "$lib/terminalEscape";
  import { detectNotesKey } from "$lib/notesAffordance";
  import { isScrolledAwayFromBottom } from "$lib/scrollAffordance";
  import TodoPanel from "$lib/components/TodoPanel.svelte";
  import IssuesPanel from "$lib/components/IssuesPanel.svelte";
  import ActivityFeed from "$lib/components/ActivityFeed.svelte";
  import DiffPanel from "$lib/components/DiffPanel.svelte";
  import ControlBar from "$lib/components/ControlBar.svelte";
  import { enterKey } from "$lib/controlKeys";
  import { lockAxis, paneSwipeAction, isSwipeUp, type Axis } from "./swipe";
  import ComposeBar from "$lib/components/ComposeBar.svelte";
  import GitRail from "$lib/components/GitRail.svelte";
  import ReadyToggle from "$lib/components/ReadyToggle.svelte";
  import AutopilotBadge from "$lib/components/AutopilotBadge.svelte";
  import { reviews, repoConfig } from "$lib/reviews.svelte";
  import { toasts } from "$lib/toasts.svelte";
  import SteerBar from "$lib/components/SteerBar.svelte";
  import LeftoverDialog from "$lib/components/LeftoverDialog.svelte";
  import BuildQueuePanel from "$lib/components/BuildQueuePanel.svelte";
  import type { BuildQueue } from "$lib/types";
  import { m } from "$lib/paraglide/messages";

  // Enter pinned in the thumb zone — locale-reactive for its accessible name.
  const enter = $derived(enterKey());

  let {
    session,
    onnewtask,
    onquick,
    onarchive,
    onback,
    onnextneedsyou,
    nextNeedsYou = 0,
    onbroadcast,
    mobile = false,
    touch = false,
    queue = [],
    switchOrder = [],
    onnavigate,
    limits = null,
    connected = true,
    git = null,
    previewPort = null,
    openPreviewTick = 0,
    buildQueue = null,
    onSeedBuildQueue,
  }: {
    session: Session;
    onnewtask?: (repoPath: string, issue: Issue) => void;
    onquick?: (repoPath: string, issue: Issue) => void;
    onarchive?: (id: string, reap?: string[]) => void;
    onback?: () => void;
    /** Jump to the next session waiting for a reply (header shortcut). */
    onnextneedsyou?: () => void;
    /** How many *other* sessions are waiting on the operator; gates the button. */
    nextNeedsYou?: number;
    onbroadcast?: () => void;
    mobile?: boolean;
    touch?: boolean;
    // ordered ids of sessions currently waiting on the operator ("needs you"),
    // so the console can page through that queue without a trip back to the list
    queue?: string[];
    // ordered ids of *all* live sessions (list order) for swipe-to-switch paging,
    // distinct from `queue` (needs-you only) which drives the ‹/› header buttons
    switchOrder?: string[];
    onnavigate?: (id: string) => void;
    // phone-only header extras: the merged header subsumes the (now hidden) top bar,
    // so it surfaces the usage gauge (only when hot) and the connection state itself
    limits?: UsageLimits | null;
    connected?: boolean;
    // PR/git state for this session; once a PR exists the work is effectively done,
    // so the header promotes its decommission button into a "ready to clean up" nudge
    git?: GitState | null;
    /** Live preview-listener port for this session (server-driven). Non-null → the
     *  Preview tab + pane are available; the iframe URL is built from window.location. */
    previewPort?: number | null;
    /** Monotonic tick bumped by a row's Preview-badge click → switch to the Preview tab. */
    openPreviewTick?: number;
    /** Current build queue for this session; updated live by WS queue:update events. */
    buildQueue?: BuildQueue | null;
    /** Called when the panel bootstrap-GETs or mutates a queue, to seed the store. */
    onSeedBuildQueue?: (q: BuildQueue) => void;
  } = $props();

  let el: HTMLDivElement | undefined = $state();
  // root element + live signed offset (px) for the phone horizontal swipe gesture:
  // negative pages to the next queued agent, positive to the previous / back to list
  let viewportEl: HTMLDivElement | undefined = $state();
  let swipeX = $state(0);
  let swiping = $state(false);
  let tab = $state<"term" | "todo" | "issues" | "activity" | "diff" | "preview">("term");
  // desktop only: reveals the git rail (PR / merge / critic / ready / verdict) as a
  // second header row, so the primary strip stays uncrowded until the operator asks
  let gitOpen = $state(false);
  // mobile/compact only: folds the secondary header chrome (tabs + git rail +
  // build queue) into the first identity line so the terminal reclaims the
  // vertical space. Persisted globally → restored to the operator's last choice.
  const COLLAPSE_KEY = "shepherd-vp-header-collapsed";
  let headerCollapsed = $state(
    typeof localStorage !== "undefined" &&
      (() => {
        try {
          return localStorage.getItem(COLLAPSE_KEY) === "1";
        } catch {
          return false;
        }
      })(),
  );
  $effect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, headerCollapsed ? "1" : "0");
    } catch {
      /* localStorage unavailable (private mode) — fold stays in-memory only */
    }
  });
  let conn = $state<PtyConn | undefined>();
  // true when another device took over this terminal — show a take-over prompt
  let parked = $state(false);
  // true once the connection stopped for good — show a recovery prompt. endReason
  // splits the two cases: "gone" = the agent exited (offer claude --resume),
  // "unreachable" = herdr itself is down (offer a plain re-attach).
  let ended = $state(false);
  let endReason = $state<"gone" | "unreachable">("gone");
  let resuming = $state(false);
  let resumeFailed = $state(false);
  // bumped on a successful resume to tear down the dead terminal + re-attach to the
  // freshly-spawned herdr agent (the terminal effect keys on it alongside the unit id)
  let resumeEpoch = $state(0);
  // mirror the live terminal so the theme effect can repaint it without
  // recreating it (recreating would tear down the PTY socket)
  let termRef = $state<Terminal | undefined>();
  // true when the user has scrolled up away from the latest output → show a
  // jump-to-bottom affordance bottom-right of the terminal. Two regimes
  // (see `agentOwnsScroll`):
  //  • xterm owns the scrollback (plain shell, mouse-tracking off): read its
  //    viewport offset directly.
  //  • the agent owns the scroll (alternate screen, or mouse-tracking on the
  //    normal buffer like Claude Code): it grabs the wheel and repaints its own
  //    scrolled view, so xterm's viewport never moves and we can't read a
  //    position. We approximate it with a wheel/gesture accumulator (scrollDepth)
  //    and jump back with the app's own Ctrl+End shortcut instead of moving xterm.
  let scrolledUp = $state(false);
  // px-ish accumulator of net upward scrolling while the agent owns the scroll;
  // plain (non-reactive) — only `scrolledUp` drives the UI. Reset on re-attach,
  // buffer switch, and a jump-to-bottom.
  let scrollDepth = 0;
  // agent-owned regime only: new output landed while the reader was scrolled up
  // (any amount). xterm's viewport stays pinned there, so a sub-threshold nudge
  // followed by fresh agent output — common while the pane is backgrounded —
  // would otherwise never surface the jump-to-bottom button. Plain (non-reactive)
  // like scrollDepth; cleared when the reader is back at the bottom or jumps down.
  let contentBelowScroll = false;
  let dragging = $state(false);
  // The key to press for Claude's "add notes" prompt option, scraped live from
  // the painted screen (null when the prompt isn't offering it). On a phone
  // there's no keyboard to press it, so we surface a tappable control row button.
  let notesKey = $state<string | null>(null);
  let uploading = $state(false);
  let uploadFailed = $state(false);
  let fileInput = $state<HTMLInputElement>();
  // platform-correct modifier for the "force local selection" hint: xterm uses
  // Shift on Linux/Windows, Option (⌥) on macOS while the agent holds the mouse.
  // Guarded for SSR (no navigator) → renders the Shift glyph, corrects on hydrate.
  const isMac = $derived(
    typeof navigator !== "undefined" &&
      /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent),
  );

  // compact header: narrow mobile OR a touch device on the desktop layout (unfolded
  // foldables). Drops secondary fields + wraps so the decommission button never clips.
  const compact = $derived(mobile || touch);
  // the fold only applies on the compact layout (it's the mobile space-saver);
  // desktop keeps its own git-actions disclosure untouched.
  const headerFolded = $derived(compact && headerCollapsed);

  // a parked (idle/done) session with a pinned claude id can be brought back —
  // surface a header Resume button so the user isn't stranded at a bare shell with
  // no affordance (the in-terminal overlay only shows once the PTY closes for good).
  const resumable = $derived(canResume(session));
  // a11y: the fold button's aria-controls points at the tab switcher — the always-
  // mounted primary region it collapses (the git rail + build queue come and go with
  // the fold, so they can't carry a stable controlled-region id). Per-session id so
  // it stays unique if ever more than one viewport mounts.
  const foldRegionId = $derived(`vp-fold-region-${session.id}`);

  function toggleFold() {
    headerCollapsed = !headerCollapsed;
    // folding hides the tab switcher, so a non-terminal tab would be stranded with no
    // way back except unfolding — and its panel would keep filling the body, reclaiming
    // nothing. Land on the terminal (the view this fold exists to enlarge).
    if (headerCollapsed) tab = "term";
  }

  // phone merged header: the repo + session that used to live in the top bar
  const repoName = $derived(session.repoPath.split("/").filter(Boolean).at(-1) ?? "");
  const repoIcon = $derived(projectIcons.iconFor(session.repoPath));

  // alert-by-exception: a *saturated* tint fires only when the agent wants the
  // operator (blocked / done) so the tint stays a signal, not noise. The exact
  // status still reaches assistive tech via .vp-status-sr.
  const tintColor = $derived(
    mobile && (session.status === "blocked" || session.status === "done")
      ? STATUS_COLOR[session.status]
      : null,
  );
  // The header background uses a per-theme wash token (--wash-blocked / -done)
  // rather than mixing the status colour inline: a 24% red→head srgb blend that
  // reads as a deep alarm bezel on the dark ground muddies into a dusty pink in
  // light, so the light theme retunes the blocked wash in OKLCH (see app.css).
  const tintWash = $derived(tintColor ? `var(--wash-${session.status})` : null);
  // Non-hue partner to the tint: a leading shape mark so blocked (!) vs done (✓)
  // never rests on colour alone (WCAG 1.4.1) — mirrors the StatusPip glyphs. Same
  // blocked/done-on-phone gate as the tint.
  const statusGlyph = $derived(!tintColor ? null : session.status === "blocked" ? "!" : "✓");

  // ...but a busy agent shouldn't read as idle either: running gets a faint,
  // gently-pulsing amber edge (CSS .working) — ambient enough to distinguish
  // "churning" from "idle" at a glance without competing with the alert states.
  const working = $derived(mobile && session.status === "running");

  // phone: the usage gauge only mounts once the hotter window runs hot (≥70%),
  // i.e. exactly when the remaining token budget starts to matter mid-session
  const hotGauge = $derived.by(() => {
    const h = hotterGauge(limits);
    return h && h.w.pct >= 70 ? h : null;
  });
  function gaugeColor(pct: number): string {
    if (pct >= 90) return "var(--color-red)";
    if (pct >= 70) return "var(--color-amber)";
    return "var(--color-green)";
  }

  // "needs you" queue paging: only on compact layouts (the list isn't visible there),
  // and only when more than one session waits. Wraps around so ‹/› always advance.
  const queueIdx = $derived(queue.indexOf(session.id));
  const showQueueNav = $derived(compact && queue.length > 1 && !!onnavigate);
  function gotoQueue(step: number) {
    if (queue.length === 0) return;
    const base = queueIdx === -1 ? (step > 0 ? -1 : 0) : queueIdx;
    const next = (base + step + queue.length) % queue.length;
    onnavigate?.(queue[next]);
  }

  // Swipe-to-switch pages through *all* live agents in list order, not just the
  // needs-you queue above — the operator wants to flick between any running agents
  // without a detour back to the list. Wraps around like gotoQueue.
  const switchIdx = $derived(switchOrder.indexOf(session.id));
  const canSwitch = $derived(switchOrder.length > 1 && !!onnavigate);
  function gotoSwitch(step: number) {
    if (switchOrder.length === 0) return;
    const base = switchIdx === -1 ? (step > 0 ? -1 : 0) : switchIdx;
    const next = (base + step + switchOrder.length) % switchOrder.length;
    onnavigate?.(switchOrder[next]);
  }

  // null model = claude's own default (shepherd passed no --model flag)
  const modelLabel = $derived(session.model ?? "default");

  // session:status events replace the Session object on every state change of the
  // running unit, so the `session` prop reference churns while its id stays put.
  // Derive the id: a $derived only notifies dependents when its *value* changes,
  // so effects keyed on it re-run on an actual unit switch — not on status churn.
  const unitId = $derived(session.id);

  // Live preview availability is purely server-driven: a non-null port means the
  // server bound a reverse-proxy listener for this session's dev server. Single
  // source of truth for both the tab and the pane — no iframe-load inference.
  const hasPreview = $derived(previewPort != null);
  // Build the URL from how the operator actually connected (Tailscale https host
  // or localhost dev) + the assigned port — a distinct origin, so the app is
  // same-origin to its own backend (the frame keeps `allow-same-origin`; see the
  // sandbox note on the iframe). SSR-guarded.
  const previewUrl = $derived(
    hasPreview && typeof location !== "undefined"
      ? `${location.protocol}//${location.hostname}:${previewPort}/`
      : null,
  );

  // per-session token usage from ~/.claude JSONL; refresh on select + every 5s
  let usage = $state<SessionUsage | null>(null);
  $effect(() => {
    const id = session.id;
    usage = null;
    let alive = true;
    const load = () =>
      getSessionUsage(id)
        .then((u) => alive && (usage = u))
        .catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  });

  // once a PR exists (open or merged) the session has delivered its work — surface
  // the decommission button as a bright "ready to clean up the worktree" nudge so the
  // operator can wrap the session without hunting for the otherwise-faint ✕.
  const prReady = $derived(git?.state === "open" || git?.state === "merged");

  // The PR disclosure toggle's hue tracks merge-readiness — NOT mere PR existence
  // (that's prReady above, which still drives the decommission nudge). This toggle is a
  // single rolled-up verdict for the collapsed rail, so amber = "needs you" deliberately
  // folds BOTH CI failure and critic changes_requested into one attention hue. That
  // diverges from PrBadge on purpose: PrBadge has room for granular per-check dots, so it
  // keeps red for CI failure and amber for pending/changes_requested — red stays exclusive
  // to those dots, never the rolled-up toggle. Green = CI green & critic clear, i.e. ready
  // to merge — where "clear" means only changes_requested blocks green; approved,
  // commented, and no-review-yet all pass. Pending / merged / closed / none stay neutral.
  // Known limitation: there is no critic-pending field, so prClear goes green on CI
  // success even before the critic posts (latestReview undefined) — "ready to merge" can
  // show a beat early, and stays green when the critic is disabled (no gate to wait on).
  const prAttention = $derived(
    git?.state === "open" &&
      (git.checks === "failure" || git.latestReview?.state === "changes_requested") &&
      !reviews.isReviewing(session.id),
  );
  const prClear = $derived(
    git?.state === "open" &&
      git.checks === "success" &&
      git.latestReview?.state !== "changes_requested",
  );
  // Localized status word folded into the toggle's title/aria so the hue isn't the only
  // signal — color-only status fails colorblind users and screen readers.
  const gitToggleState = $derived(
    prClear
      ? m.viewport_git_actions_state_clear()
      : prAttention
        ? m.viewport_git_actions_state_attention()
        : "",
  );

  // desktop parity for the rail's Ready toggle: #188 moved the git rail behind the
  // "Git actions" disclosure, hiding ready-to-merge on desktop while mobile (always-on
  // rail) still showed it. Surface just this one high-frequency control in the primary
  // row. Gate mirrors GitRail's own ({git open || already ready} & not running/blocked),
  // desktop-only — on compact the rail itself still owns the toggle (see showReady below).
  const readyVisible = $derived(
    !compact &&
      (git?.state === "open" || session.readyToMerge) &&
      session.status !== "running" &&
      session.status !== "blocked",
  );

  // desktop: per-session autopilot toggle — always visible on desktop when not
  // compact; mirrors readyVisible's placement pattern in the primary header row.
  const autopilotToggleVisible = $derived(!compact);

  // Effective autopilot state: the session override when set, otherwise the repo default.
  // The button must reflect THIS (not `=== true`) — a null-override session under an
  // autopilot-on repo is actually running, and showing it as "off" would mislead.
  const autopilotEffective = $derived(
    session.autopilotEnabled ?? repoConfig.isAutopilotEnabled(session.repoPath),
  );

  async function toggleSessionAutopilot() {
    // Flip the effective state to an explicit override (this never restores `null`/inherit —
    // an accepted limitation; clearing back to inherit isn't exposed in the UI). The button
    // reflects server-confirmed state via the session:autopilot WS event, so there's no local
    // optimistic state to revert — on failure it simply won't move; surface a toast so the
    // operator knows the click didn't take.
    try {
      await setSessionAutopilot(session.id, !autopilotEffective);
    } catch {
      toasts.info(m.session_autopilot_toggle_failed());
    }
  }

  // two-step decommission: first click arms, second (within 3s) fires; disarms on unit change
  let armed = $state(false);
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  // leftover subprocesses still running from this session — populated on the
  // confirming click; a non-empty list pops the dialog instead of closing outright.
  let leftovers = $state<Leftover[]>([]);
  $effect(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- touch reactive dep
    unitId; // on unit switch: disarm decommission + default back to terminal tab
    armed = false;
    leftovers = [];
    tab = "term";
    ended = false;
    resumeFailed = false;
    renaming = false; // close a half-open rename editor when switching units
    renameError = null;
    gitOpen = false; // collapse the PR-actions disclosure on unit switch
  });
  // A row's Preview badge was clicked (tick bumped) → open the Preview tab. Defined
  // AFTER the unit-switch reset above so that when a click both selects a new unit
  // (resetting tab→term) and bumps the tick in one update, this effect runs last in
  // the flush and wins. Keyed only on the tick, so re-running it never depends on
  // unitId; the leading `> 0` skips the initial mount (tick starts at 0).
  let lastPreviewTick = -1;
  $effect(() => {
    if (openPreviewTick > 0 && openPreviewTick !== lastPreviewTick && hasPreview) {
      tab = "preview";
    }
    lastPreviewTick = openPreviewTick;
  });
  // The preview listener can vanish (dev server stopped / session archived) while
  // the Preview tab is open → server-driven availability drops, so fall back to the
  // terminal rather than stranding a dead iframe.
  $effect(() => {
    if (!hasPreview && tab === "preview") tab = "term";
  });
  $effect(() => () => clearTimeout(armTimer));
  async function decommission() {
    if (!armed) {
      armed = true;
      clearTimeout(armTimer);
      armTimer = setTimeout(() => (armed = false), 3000);
      return;
    }
    clearTimeout(armTimer);
    armed = false;
    // only interrupt the close with the dialog when something is actually still
    // running; a probe failure must never block decommission, so fall through to close.
    const found = await getLeftovers(session.id).catch(() => [] as Leftover[]);
    if (found.length === 0) {
      onarchive?.(session.id);
      return;
    }
    leftovers = found;
  }

  // ── rename: one click opens an inline editor; Enter/blur commits, Esc cancels ──
  let renaming = $state(false);
  let renameDraft = $state("");
  let renameError = $state<string | null>(null);
  let renameSaving = $state(false);
  let renameNote = $state<string | null>(null);
  let renameInput = $state<HTMLInputElement | undefined>();
  let renameNoteTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => () => clearTimeout(renameNoteTimer));

  async function startRename() {
    renameDraft = session.name;
    renameError = null;
    renaming = true;
    await tick();
    renameInput?.select();
  }
  function cancelRename() {
    renaming = false;
    renameError = null;
  }
  async function commitRename() {
    if (!renaming || renameSaving) return;
    const name = renameDraft.trim();
    if (!name || name === session.name) return cancelRename();
    renameSaving = true;
    renameError = null;
    try {
      const res = await renameSession(session.id, name);
      renaming = false;
      // open PR on a host that can't retarget → display-only; tell the user the branch stayed
      if (session.branch && !res.branchRenamed) {
        renameNote = m.viewport_rename_branch_kept();
        clearTimeout(renameNoteTimer);
        renameNoteTimer = setTimeout(() => (renameNote = null), 6000);
      }
    } catch (e) {
      renameError =
        e instanceof Error && e.message === "name_taken"
          ? m.viewport_rename_name_taken()
          : m.viewport_rename_failed();
    } finally {
      renameSaving = false;
    }
  }
  function onRenameKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      void commitRename();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelRename();
    }
  }

  // upload image(s) into this session's worktree, then inject their paths into
  // the PTY — the user adds wording and presses Enter themselves. The path is
  // wrapped in bracketed-paste markers (ESC[200~ … ESC[201~) so the TUI ingests
  // it as one atomic paste; injecting it as a fast raw-keystroke burst drops
  // characters (notably on mobile, racing with resize events).
  async function attachImages(files: FileList | File[]) {
    const imgs = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (imgs.length === 0 || !conn) return;
    uploading = true;
    uploadFailed = false;
    try {
      for (const f of imgs) {
        const path = await uploadImage(f, session.id);
        conn.send(` \x1b[200~${path}\x1b[201~ `);
      }
    } catch {
      // surface failure on the button; never inject into the PTY (would pollute the prompt)
      uploadFailed = true;
    } finally {
      uploading = false;
    }
  }

  function onTermDrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    if (e.dataTransfer?.files?.length) attachImages(e.dataTransfer.files);
  }

  function takeover() {
    parked = false;
    conn?.takeover();
  }

  // The agent owns the scroll whenever it drives a full-screen view and pins
  // xterm's viewport at the bottom: either the alternate screen (classic TUI) or
  // mouse-tracking on the normal buffer. Claude Code does the latter — it stays
  // on the normal buffer (keeping scrollback) but grabs the wheel and repaints
  // its own scrolled view, so xterm's viewport never moves. In both regimes we
  // can't read a scroll position from xterm; we lean on the gesture accumulator
  // (scrollDepth) and jump back with the app's own shortcut instead.
  const agentOwnsScroll = (term: Terminal): boolean =>
    term.buffer.active.type === "alternate" || term.modes.mouseTrackingMode !== "none";

  function scrollToBottom() {
    const term = termRef;
    if (!term) return;
    if (agentOwnsScroll(term)) {
      // The agent owns the scroll; xterm can't move it. Ctrl+End is Claude's
      // documented "jump to latest + re-enable auto-follow" shortcut and is
      // never interpreted as prompt text.
      conn?.send("\x1b[1;5F");
    } else {
      term.scrollToBottom();
    }
    scrollDepth = 0;
    contentBelowScroll = false;
    scrolledUp = false;
  }

  // bring a finished session back: ask the server to respawn `claude --resume` in
  // the worktree, then bump the epoch so the terminal effect rebuilds and attaches
  // to the fresh agent (the old PtyConn stopped for good on the ended-close).
  // force=true (header button) tears down a surviving husk shell and respawns
  // claude; force=false (the agent-gone overlay) just respawns into the empty tab.
  async function resumeSession(force = false) {
    if (resuming) return;
    resuming = true;
    resumeFailed = false;
    try {
      await apiResumeSession(session.id, force);
      ended = false;
      resumeEpoch++; // rebuild the terminal + attach to the fresh agent
    } catch {
      resumeFailed = true;
    } finally {
      resuming = false;
    }
  }

  // herdr was unreachable (not the agent quitting) — there's nothing to respawn,
  // the live agent is still there once herdr is back. Just rebuild the terminal so
  // it re-attaches. If herdr is still down the fast-fail loop re-surfaces this.
  function reattach() {
    ended = false;
    resumeFailed = false;
    resumeEpoch++;
  }

  // mobile compose bar submit. Routing the composed line through here (as an
  // atomic bracketed paste) instead of xterm's textarea sidesteps the Android
  // IME duplication bug. See composeKeystrokes for the byte mapping.
  function sendComposed(text: string) {
    conn?.send(composeKeystrokes(text));
  }

  // the compose overlay is summoned on demand (swipe-up from the ctrl-row gutter,
  // or the ✎ chip), reclaiming the row the old always-on input bar occupied.
  // composeDictate opens the sheet already listening — the one-tap 🎤 chip sets
  // it; the compose-first entries (✎, swipe-up) leave it false so the keyboard
  // comes up to type.
  let composeOpen = $state(false);
  let composeDictate = $state(false);
  let ctrlRowEl: HTMLDivElement | undefined = $state();
  function openCompose() {
    composeDictate = false; // compose-first; the 🎤 lives inside the sheet too
    composeOpen = true;
  }
  // one-tap dictate: opens the sheet already listening (preserves Kai's original
  // affordance), a peer of the ✎ compose entry rather than a step inside it.
  // Gated on Web Speech support so the chip never becomes a dead end where it's
  // unavailable (e.g. an iOS home-screen PWA); the sheet's own 🎤 toggle hides
  // itself there the same way.
  const speechSupported =
    typeof window !== "undefined" &&
    !!(
      (window as { SpeechRecognition?: unknown }).SpeechRecognition ??
      (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition
    );
  function openDictate() {
    composeDictate = true;
    composeOpen = true;
  }
  // Swipe up from the ctrl-row gutter to summon the compose sheet — a bottom-edge
  // gesture, so it never competes with the terminal's vertical scrollback (which
  // lives above the row). isSwipeUp ignores chip taps and horizontal pane swipes.
  // Listeners are bound in JS (not inline on the markup) so the row stays a plain
  // static container — the chips remain the interactive elements.
  $effect(() => {
    const row = ctrlRowEl;
    if (!row) return;
    let sx = 0;
    let sy = 0;
    let dx = 0;
    let dy = 0;
    const start = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      sx = e.touches[0].clientX;
      sy = e.touches[0].clientY;
      dx = dy = 0;
    };
    const move = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      dx = e.touches[0].clientX - sx;
      dy = e.touches[0].clientY - sy;
    };
    const end = () => {
      if (isSwipeUp(dx, dy, 36)) openCompose();
      dx = dy = 0;
    };
    row.addEventListener("touchstart", start, { passive: true });
    row.addEventListener("touchmove", move, { passive: true });
    row.addEventListener("touchend", end);
    return () => {
      row.removeEventListener("touchstart", start);
      row.removeEventListener("touchmove", move);
      row.removeEventListener("touchend", end);
    };
  });

  $effect(() => {
    const id = unitId;
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- reactive dep
    resumeEpoch; // a resume bumps this → rebuild the terminal + re-attach to the new agent
    if (!el) return;
    parked = false; // fresh attach for this unit
    scrolledUp = false; // fresh terminal starts pinned to the bottom
    scrollDepth = 0;
    contentBelowScroll = false;
    notesKey = null; // no prompt scraped yet on this fresh terminal

    // initial palette: non-reactive DOM read so this effect doesn't depend on
    // theme.resolved (which would recreate the whole terminal — and its PTY —
    // on every theme switch). Live updates are handled by the effect below.
    const initialTheme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: mobile || touch ? 11 : 12.5,
      theme: xtermTheme(initialTheme),
      minimumContrastRatio: xtermMinContrast(initialTheme),
      cursorBlink: true,
      // Mirror terminal output into xterm's hidden ARIA live region so screen
      // readers can follow the live agent session (the .term-mount region label
      // alone names the area but exposes none of its scrolling content).
      screenReaderMode: true,
      // Claude Code runs as a TUI with mouse tracking on, which hands mouse drags
      // to the app instead of selecting text. xterm lets a modifier force local
      // selection anyway — Shift on Linux/Windows, Option (⌥) on macOS — but the
      // macOS path only works when this option is enabled (default off). Without
      // it, Mac users can't select terminal text at all while an agent is running.
      macOptionClickForcesSelection: true,
    });
    termRef = term;

    const fit = new FitAddon();
    term.loadAddon(fit);
    // Linkify URLs in the terminal so they're tappable — on a phone a plain-text
    // URL can't be opened at all (no text-selection affordance inside xterm's
    // canvas), and even on desktop a click beats copy-paste. Plain tap/click
    // opens in a new tab; noopener so the opened page can't reach back via
    // window.opener.
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        window.open(uri, "_blank", "noopener,noreferrer");
      }),
    );
    term.open(el);
    fit.fit();

    // assign the local first; reading the `conn` $state back inside this effect
    // would make the effect depend on a value it writes → infinite update loop
    const c = connectPty(
      id,
      term.cols,
      term.rows,
      (d) => term.write(d),
      // reconnected (e.g. after a mobile app-switch dropped the socket): refit in
      // case the layout changed while away, then resize to repaint the attach
      () => {
        refit();
      },
      // another device took over this terminal — park and offer to take it back
      () => {
        parked = true;
      },
      // the connection stopped for good — note it in the buffer + surface a
      // recovery prompt. "gone" → claude exited (status badge already flipped to
      // "done" via session:status); "unreachable" → herdr is down, just re-attach.
      (reason) => {
        endReason = reason;
        term.write(
          `\r\n\x1b[2m${reason === "unreachable" ? m.viewport_herdr_unreachable() : m.viewport_session_ended()}\x1b[0m\r\n`,
        );
        ended = true;
      },
    );
    conn = c;
    term.onData((d) => c.send(d));

    // Fit + push the size to the PTY — but only while the mount is actually
    // visible. A hidden (To-Do/Issues tab → display:none) or mid-layout mount
    // has zero width, where FitAddon clamps to its 2-col minimum; resizing the
    // PTY to 2 cols makes Claude reflow its transcript at 2 cols and permanently
    // poisons the scrollback with 2-char-wide wrapping. offsetParent===null
    // catches display:none; the client-size checks catch transient collapses.
    const refit = () => {
      if (!el || el.offsetParent === null || el.clientWidth === 0 || el.clientHeight === 0) return;
      fit.fit();
      c.resize(term.cols, term.rows);
    };

    // Shift+Enter → newline: xterm emits a bare CR for both Enter and
    // Shift+Enter, so Claude Code can't tell them apart and submits. Returning
    // false alone is insufficient — xterm then skips its own preventDefault and
    // the browser's Enter keypress still makes xterm emit \r. We must call
    // e.preventDefault() to suppress that keypress, then send a line feed
    // (0x0A, same byte as Ctrl+J / chat:newline) instead. keydown-only so the
    // keyup doesn't double-send.
    term.attachCustomKeyEventHandler((e) => {
      if (
        e.type === "keydown" &&
        e.key === "Enter" &&
        e.shiftKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey
      ) {
        e.preventDefault();
        c.send("\n");
        return false;
      }
      // Ctrl+Shift+C: explicit copy. Ctrl+C in a focused terminal sends SIGINT to
      // the agent rather than copying; this gives users an explicit copy shortcut.
      // Read the selection before returning false — xterm hasn't cleared it yet.
      if (e.type === "keydown" && e.ctrlKey && e.shiftKey && (e.key === "C" || e.key === "c")) {
        const sel = term.getSelection();
        if (sel) {
          e.preventDefault();
          navigator.clipboard?.writeText(sel)?.catch((err) => {
            console.warn("ctrl+shift+c: clipboard write failed", err);
          });
          return false;
        }
      }
      return true;
    });

    // Desktop Escape rescue. xterm only emits the Escape byte while its hidden
    // textarea is focused, but on desktop the keyboard often isn't there: focus
    // drifts onto <body> (clicking header chrome, a re-attach, the browser's own
    // focus handling — Arc was the reported case), and even with the textarea
    // focused a browser quirk can swallow it. The window still gets the keydown,
    // so whenever the terminal owns the keyboard we route a bare Escape into the
    // PTY ourselves, suppress xterm's own handling (capture phase +
    // stopImmediatePropagation) so the agent gets exactly one Escape, and
    // reclaim focus for the next keystrokes. The guards in shouldForwardEscape
    // keep us off a dialog or a sibling input. Touch layouts already have the
    // on-screen Esc button, so this is desktop-only.
    const onWindowKeydown = (e: KeyboardEvent) => {
      // Cheap event-only gate before touching the DOM: skip the querySelector +
      // activeElement read on every non-Escape keystroke, and stand down during
      // IME composition (Escape there cancels the candidate, not ours).
      if (e.key !== "Escape" || e.isComposing) return;
      if (
        !shouldForwardEscape({
          key: e.key,
          composing: e.isComposing,
          ctrlKey: e.ctrlKey,
          altKey: e.altKey,
          metaKey: e.metaKey,
          desktopKeyboard: !mobile && !touch,
          termTabActive: tab === "term",
          live: !parked && !ended,
          overlayOpen: !!document.querySelector(".overlay, .drawer"),
          active: document.activeElement,
          body: document.body,
          terminalEl: el ?? null,
        })
      )
        return;
      e.preventDefault();
      e.stopImmediatePropagation();
      c.send("\x1b");
      term.focus();
    };
    window.addEventListener("keydown", onWindowKeydown, true);

    // mobile freezes backgrounded tabs and drops the WS; nudge a reconnect when
    // the tab returns. pageshow+persisted covers iOS Safari's bfcache restore,
    // which doesn't always fire visibilitychange.
    const onVisible = () => {
      if (document.visibilityState === "visible") c.poke();
    };
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) c.poke();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onPageShow);

    // tap-to-focus opens the mobile keyboard — skip when the tap was a scroll drag
    let dragged = false;
    const onTap = () => {
      if (!dragged) term.focus();
    };
    el.addEventListener("click", onTap);

    // copy-on-select: Ctrl+C in a focused terminal sends SIGINT to the agent
    // rather than copying, so copy the xterm selection to the clipboard when a
    // drag-select finishes. xterm tracks the drag with document-level listeners,
    // so the pointer can be released outside the terminal element — listen for
    // mouseup on the document (gated to drags that began in the terminal) rather
    // than on el, so those releases still copy. The mousedown gate is capture-
    // phase: xterm stops the mousedown from bubbling to el, so a bubble-phase
    // listener never sees it — capture fires top-down before xterm can swallow
    // it. A plain click clears xterm's selection first, so getSelection() is
    // empty → no spurious copy.
    let selectingInTerm = false;
    const onTermMouseDown = () => {
      selectingInTerm = true;
    };
    const onDocMouseUp = () => {
      if (!selectingInTerm) return;
      selectingInTerm = false;
      const sel = term.getSelection();
      if (sel) {
        navigator.clipboard?.writeText(sel)?.catch((err) => {
          console.warn("copy-on-select: clipboard write failed", err);
        });
      }
    };
    el.addEventListener("mousedown", onTermMouseDown, true);
    document.addEventListener("mouseup", onDocMouseUp);

    // Cmd/Ctrl+V of an image: xterm only pastes text, so a copied screenshot is
    // silently dropped. Intercept in the capture phase (before xterm's textarea
    // handler), upload any image like a drag-drop, and inject its path. A plain
    // text paste matches no image item, so it falls through to xterm untouched.
    const onPaste = (e: ClipboardEvent) => {
      const imgs = imageFilesFromItems(e.clipboardData?.items);
      if (imgs.length === 0) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      attachImages(imgs);
    };
    el.addEventListener("paste", onPaste, true);

    // Claude Code runs as a full-screen TUI with mouse tracking on (it stays on
    // the normal buffer, keeping scrollback, but grabs the wheel): scrolling
    // means sending wheel input to the app, which is what the mouse wheel does on
    // desktop. Touch emits no wheel events, so translate one-finger drags into
    // wheel events on xterm's screen — xterm then forwards them per the active
    // mode (to the app when mouse-tracking, otherwise its own scrollback).
    // Matches desktop in both.
    let lastY: number | null = null;
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      lastY = e.touches[0].clientY;
      dragged = false;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (lastY === null || e.touches.length !== 1) return;
      const y = e.touches[0].clientY;
      const dy = lastY - y; // drag down → wheel up (reveal older), natural scroll
      lastY = y;
      if (Math.abs(dy) > 2) dragged = true;
      // when the agent owns the scroll xterm's viewport never moves (onScroll
      // won't fire), so track the gesture directly: dy<0 = scrolling up → grow
      // the depth.
      if (agentOwnsScroll(term)) {
        scrollDepth = Math.max(0, scrollDepth - dy);
      }
      recomputeScrolled();
      const target = el!.querySelector<HTMLElement>(".xterm-screen") ?? el!;
      target.dispatchEvent(
        new WheelEvent("wheel", { deltaY: dy, deltaMode: 0, bubbles: true, cancelable: true }),
      );
      e.preventDefault();
    };
    const onTouchEnd = () => {
      lastY = null;
    };
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);

    // refit after layout settles (mount may start hidden during mobile nav)
    requestAnimationFrame(() => {
      refit();
      // desktop: selecting a unit hands the keyboard straight to its terminal —
      // clicking a sidebar card otherwise leaves focus on the card button, so
      // typing goes nowhere. Mobile keeps tap-to-focus so the soft keyboard
      // doesn't pop open on every selection.
      if (!mobile && !touch && tab === "term") term.focus();
    });

    const ro = new ResizeObserver(() => {
      refit();
    });
    ro.observe(el);

    // track scroll position so we can offer a jump-to-bottom button. The two
    // regimes (gesture accumulator vs. xterm viewport offset) and why content
    // arrival matters are documented in `isScrolledAwayFromBottom`.
    const recomputeScrolled = () => {
      const b = term.buffer.active;
      if (scrollDepth === 0) contentBelowScroll = false; // back at the bottom → re-arm
      scrolledUp = isScrolledAwayFromBottom({
        agentOwnsScroll: agentOwnsScroll(term),
        scrollDepth,
        contentBelowScroll,
        viewportOffsetLines: b.baseY - b.viewportY,
      });
    };
    const scrollSub = term.onScroll(recomputeScrolled);
    const bufSub = term.buffer.onBufferChange(() => {
      scrollDepth = 0;
      recomputeScrolled();
    });
    // When the agent owns the scroll xterm's viewport never moves, so onScroll
    // can't tell us the reader fell behind a fresh burst of agent output. Watch
    // the write stream: if content lands while they're scrolled up at all (even a
    // sub-threshold nudge), surface the jump-to-bottom button. This also fires
    // while the term tab is backgrounded, so the button is already armed when the
    // reader switches back. Agent-owned regime only — xterm-owned scroll already
    // tracks writes via onScroll.
    const writeSub = term.onWriteParsed(() => {
      if (agentOwnsScroll(term) && scrollDepth > 0 && !contentBelowScroll) {
        contentBelowScroll = true;
        recomputeScrolled();
      }
    });

    // Surface Claude Code's "press n to add notes" prompt option as a tappable
    // control-row key — on a phone there's no keyboard to press it, so the
    // dialog's notes branch is otherwise unreachable. The hint lives only in the
    // painted screen, so re-scan the visible rows on each render (cheap: bounded
    // by term.rows, and onRender already coalesces a write burst into one frame).
    // Visible viewport only, so a prompt scrolled out of view stops lighting it.
    const scanNotesAffordance = () => {
      if (!(mobile || touch)) return; // the button only exists in the touch row
      const b = term.buffer.active;
      let text = "";
      for (let i = 0; i < term.rows; i++) {
        text += (b.getLine(b.viewportY + i)?.translateToString(true) ?? "") + "\n";
      }
      notesKey = detectNotesKey(text);
    };
    const renderSub = term.onRender(scanNotesAffordance);

    // desktop wheel observer for when the agent owns the scroll, where onScroll
    // never fires. Touch is tracked directly in onTouchMove, so ignore the
    // synthetic wheels it dispatches (isTrusted=false) to avoid double-counting;
    // only real wheels here. deltaY<0 = scrolling up (reveal older) → grow depth;
    // >0 = toward latest.
    const onWheelTrack = (e: WheelEvent) => {
      if (!e.isTrusted || !agentOwnsScroll(term)) return;
      scrollDepth = Math.max(0, scrollDepth - e.deltaY);
      recomputeScrolled();
    };
    el.addEventListener("wheel", onWheelTrack, { passive: true, capture: true });

    return () => {
      window.removeEventListener("keydown", onWindowKeydown, true);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onPageShow);
      el?.removeEventListener("click", onTap);
      el?.removeEventListener("mousedown", onTermMouseDown, true);
      document.removeEventListener("mouseup", onDocMouseUp);
      el?.removeEventListener("paste", onPaste, true);
      el?.removeEventListener("touchstart", onTouchStart);
      el?.removeEventListener("touchmove", onTouchMove);
      el?.removeEventListener("touchend", onTouchEnd);
      el?.removeEventListener("wheel", onWheelTrack, { capture: true });
      scrollSub.dispose();
      bufSub.dispose();
      writeSub.dispose();
      renderSub.dispose();
      ro.disconnect();
      c.close();
      conn = undefined;
      termRef = undefined;
      term.dispose();
    };
  });

  // repaint the live terminal when the active theme changes (no recreation)
  $effect(() => {
    const resolved = theme.resolved;
    const highContrast = theme.contrast;
    const term = termRef;
    if (!term) return;
    term.options.theme = xtermTheme(resolved);
    term.options.minimumContrastRatio = xtermMinContrast(resolved, highContrast);
    term.refresh(0, Math.max(0, term.rows - 1));
  });

  // Phone: horizontal swipe over the pane pages through *all* live agents —
  // left = next agent, right = previous — so the operator never has to detour back
  // through the list to reach another running agent. At the list's start (or for a
  // session not in the list) a rightward swipe instead returns to the session list,
  // preserving the original swipe-back affordance. Capture-phase so a recognised
  // horizontal drag can stop the terminal's own touch-scroll handler (on a
  // descendant) from also firing; we only lock + suppress once the gesture is
  // clearly horizontal *and* actionable, so vertical scrolling — and any horizontal
  // drag with nowhere to go — falls through to the terminal untouched. The slop/axis
  // decision reuses lockAxis() from the decommission-swipe util (one source for the
  // commitment threshold across every swipe gesture).
  $effect(() => {
    const root = viewportEl;
    // read switchOrder/onnavigate here (via canSwitch) so the listeners re-bind when
    // switching (un)becomes available; switchIdx/gotoSwitch read fresh at commit time.
    if (!root || !mobile || (!onback && !canSwitch)) return;
    let startX = 0;
    let startY = 0;
    let armed = false; // a single-finger touch is in progress and eligible
    let axis: Axis = null; // resolved gesture axis once movement clears slop
    let locked = false; // recognised as an actionable horizontal swipe
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      // don't hijack text selection / cursor placement in editable fields, nor the
      // horizontally-scrollable bottom bars (steer chips, control keys, compose) —
      // those overflow off-screen on a phone and the operator scrolls them sideways
      // to reach a hidden button; only the terminal pane itself pages between agents.
      if (
        (e.target as Element | null)?.closest(
          "input, textarea, [contenteditable], [data-swipe-ignore]",
        )
      )
        return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      armed = true;
      axis = null;
      locked = false;
      swiping = false;
    };
    const onMove = (e: TouchEvent) => {
      if (!armed || e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      if (!locked) {
        if (axis === null) axis = lockAxis(dx, dy);
        if (axis === null) return; // still within slop — keep waiting
        // leftward needs a queue to page; rightward acts if it can page OR fall
        // back to the list. Non-actionable horizontal drags stay with the terminal.
        const actionable = axis === "x" && (dx > 0 ? canSwitch || !!onback : canSwitch);
        if (actionable) {
          locked = true;
          swiping = true;
        } else {
          armed = false; // vertical, or horizontal with nowhere to go
          return;
        }
      }
      e.preventDefault();
      e.stopPropagation();
      swipeX = dx; // signed: positive = rightward, negative = leftward
    };
    const onEnd = () => {
      if (locked) {
        const threshold = Math.min(120, root.clientWidth * 0.33);
        const action = paneSwipeAction(swipeX, threshold, canSwitch, switchIdx);
        swiping = false;
        swipeX = 0;
        if (action === "next")
          gotoSwitch(1); // leftward: next agent (wraps)
        else if (action === "prev")
          gotoSwitch(-1); // rightward: previous agent
        else if (action === "back") onback?.(); // rightward at the start: to list
        if (action !== "none") return;
      }
      armed = false;
      locked = false;
    };
    root.addEventListener("touchstart", onStart, { passive: true });
    root.addEventListener("touchmove", onMove, { passive: false, capture: true });
    root.addEventListener("touchend", onEnd);
    root.addEventListener("touchcancel", onEnd);
    return () => {
      root.removeEventListener("touchstart", onStart);
      root.removeEventListener("touchmove", onMove, { capture: true });
      root.removeEventListener("touchend", onEnd);
      root.removeEventListener("touchcancel", onEnd);
    };
  });
</script>

<div
  class="viewport"
  class:swiping
  bind:this={viewportEl}
  style:transform={swipeX ? `translateX(${swipeX}px)` : undefined}
>
  {#snippet metaPop()}
    <span class="desig-pop" role="tooltip">
      <span class="dp-row">
        <span class="dp-k">{m.viewport_profile_label()}</span>
        <span class="dp-v">{modelLabel}</span>
      </span>
      {#if usage && usage.total > 0}
        <span class="dp-row">
          <span class="dp-k">{m.viewport_tokens_meta_label()}</span>
          <span
            class="dp-v"
            title={m.viewport_usage_title({
              input: usage.input.toLocaleString(),
              output: usage.output.toLocaleString(),
              cacheRead: usage.cacheRead.toLocaleString(),
              cacheWrite: usage.cacheWrite.toLocaleString(),
            })}>{m.viewport_tokens_label({ tokens: formatTokens(usage.total) })}</span
          >
        </span>
      {/if}
    </span>
  {/snippet}
  {#snippet renameControl()}
    {#if renaming}
      <span class="rename-edit">
        <input
          bind:this={renameInput}
          class="rename-input"
          class:err={renameError}
          bind:value={renameDraft}
          placeholder={m.viewport_rename_placeholder()}
          aria-label={m.viewport_rename_aria()}
          onkeydown={onRenameKey}
          onblur={commitRename}
        />
        {#if renameError}<span class="rename-err" title={renameError}>{renameError}</span>{/if}
      </span>
    {:else}
      <button
        class="rename-btn"
        type="button"
        onclick={startRename}
        title={m.viewport_rename_aria()}
        aria-label={m.viewport_rename_aria()}>✎</button
      >
      {#if renameNote}<span class="rename-note">{renameNote}</span>{/if}
    {/if}
  {/snippet}
  <!-- header -->
  <div
    class="vp-head"
    class:mobile={compact}
    class:phone={mobile}
    class:working={working && !tintColor}
    style:background={tintWash ?? undefined}
  >
    {#if onback}
      <button class="back" type="button" onclick={onback} aria-label={m.viewport_back_aria()}
        >{mobile ? "‹" : m.viewport_back_button()}</button
      >
    {/if}
    {#if onnextneedsyou && nextNeedsYou > 0}
      <button
        class="next-yu"
        class:compact
        type="button"
        onclick={onnextneedsyou}
        aria-label={m.viewport_next_needs_you_aria()}
      >
        {#if compact}
          <span class="ny-icon" aria-hidden="true">!</span><span class="ny-n">{nextNeedsYou}</span>
        {:else}
          {m.viewport_next_needs_you({ count: nextNeedsYou })}
        {/if}
        <span class="nyu-arrow" aria-hidden="true">›</span>
      </button>
    {/if}
    {#if showQueueNav}
      <div class="queue-nav" role="group" aria-label={m.common_needs_you({ count: queue.length })}>
        <button
          type="button"
          onclick={() => gotoQueue(-1)}
          aria-label={m.viewport_queue_prev_aria()}>‹</button
        >
        {#if queueIdx >= 0}
          <span class="queue-pos"
            >{m.viewport_queue_position({ idx: queueIdx + 1, total: queue.length })}</span
          >
        {/if}
        <button type="button" onclick={() => gotoQueue(1)} aria-label={m.viewport_queue_next_aria()}
          >›</button
        >
      </div>
    {/if}
    {#if statusGlyph}
      <!-- phone: shape mark partnering the header tint so blocked/done read
           without colour. The word is on .vp-status-sr for assistive tech. -->
      <span class="vp-status-glyph" style="color:{tintColor}" aria-hidden="true">{statusGlyph}</span
      >
    {/if}
    {#if mobile}
      <!-- phone: the merged header carries repo · session (the top bar is hidden
           here), and the session name doubles as the profile/token meta trigger -->
      <span class="desig-wrap ctx">
        <span
          class="ctx-trigger"
          role="button"
          tabindex="0"
          aria-label={m.topbar_detail_context_aria({ repo: repoName, name: session.name })}
        >
          <span class="ctx-glyph" class:emoji={repoIcon} aria-hidden="true">{repoIcon ?? "▣"}</span>
          <span class="ctx-repo">{repoName}</span>
          <span class="ctx-sep">·</span>
          <span class="ctx-name">{session.name}</span>
        </span>
        {@render metaPop()}
      </span>
    {:else}
      <!-- TASK-XX: hover/focus reveals the secondary meta (profile + token usage)
           that used to sit inline in the header, reclaiming horizontal space -->
      <span class="desig-wrap">
        <span class="desig" role="button" tabindex="0" aria-label={m.viewport_meta_aria()}
          >{session.desig}</span
        >
        {@render metaPop()}
      </span>
      {#if compact}
        <!-- foldable/touch desktop only: surfaces the full name the desig can't carry -->
        <span class="vp-name" title={session.name}>{session.name}</span>
      {/if}
    {/if}
    {#if !compact}
      <span class="sep">·</span>
      <span class="branch">{session.branch ?? session.worktreePath}</span>
      <!-- desktop: rename affordance sits right after the identity, next to the
           task name (compact/phone keeps it in the trailing .vp-actions cluster) -->
      {@render renameControl()}
    {/if}
    <div class="spacer"></div>
    <div id={foldRegionId} class="tab-group" class:mobile={compact} class:folded={headerFolded}>
      <button class="tab-btn" class:active={tab === "term"} onclick={() => (tab = "term")}
        >{m.viewport_terminal_tab()}</button
      >
      <button class="tab-btn" class:active={tab === "todo"} onclick={() => (tab = "todo")}
        >{m.viewport_todo_tab()}</button
      >
      <button class="tab-btn" class:active={tab === "issues"} onclick={() => (tab = "issues")}
        >{m.viewport_issues_tab()}</button
      >
      <button class="tab-btn" class:active={tab === "activity"} onclick={() => (tab = "activity")}
        >{m.viewport_activity_tab()}</button
      >
      <button class="tab-btn" class:active={tab === "diff"} onclick={() => (tab = "diff")}
        >{m.viewport_diff_tab()}</button
      >
      {#if hasPreview}
        <!-- only while the server reports a bound preview listener (single source of
             truth: the live port). Disappears when the dev server stops. -->
        <button
          class="tab-btn preview-tab"
          class:active={tab === "preview"}
          onclick={() => (tab = "preview")}>{m.viewport_preview_tab()}</button
        >
      {/if}
    </div>
    {#if !compact}
      <span class="sep">·</span>
    {/if}
    {#if mobile}
      <!-- connection state, alert-by-exception: a lone red dot only when dropped -->
      {#if !connected}
        <span
          class="vp-offline"
          title={m.topbar_clock_tip_disconnected()}
          aria-label={m.topbar_clock_tip_disconnected()}>●</span
        >
      {/if}
      {#if hotGauge}
        <span
          class="vp-gauge"
          aria-label={m.topbar_gauge_toggle_aria({ period: hotGauge.label, pct: hotGauge.w.pct })}
        >
          <span class="g-bar"
            ><span
              class="g-fill"
              style="transform:scaleX({Math.min(Math.max(hotGauge.w.pct, 0), 100) /
                100});background:{gaugeColor(hotGauge.w.pct)}"
            ></span></span
          >
        </span>
      {/if}
      <!-- sighted users read status from the header tint + leading shape glyph;
           keep the word for assistive tech -->
      <span class="vp-status-sr">{statusLabel(session.status)}</span>
    {:else}
      <span
        class="status-badge"
        style="color:{STATUS_COLOR[session.status]};border-color:{STATUS_COLOR[session.status]}"
      >
        {#if session.status === "running"}⠿{/if}
        {statusLabel(session.status)}
      </span>
    {/if}
    {#if !compact}
      <!-- desktop: the full git rail (PR / CI / merge / critic / ready / verdict)
           used to crowd this strip. It now lives one disclosure away — this toggle
           reveals it as a second header row (.vp-git-strip), keeping the primary
           line down to identity + tabs + status + decommission. -->
      <button
        class="git-toggle"
        class:open={gitOpen}
        class:attention={prAttention}
        class:clear={prClear}
        type="button"
        aria-expanded={gitOpen}
        onclick={() => (gitOpen = !gitOpen)}
        title={gitToggleState
          ? m.viewport_git_actions_title_state({ state: gitToggleState })
          : m.viewport_git_actions_title()}
        aria-label={gitToggleState
          ? m.viewport_git_actions_aria_state({ state: gitToggleState })
          : m.viewport_git_actions_aria()}
      >
        <span class="gt-dot" aria-hidden="true"></span>
        <span class="gt-label">{m.viewport_git_actions()}</span>
        <span class="gt-caret" aria-hidden="true">{gitOpen ? "▴" : "▾"}</span>
      </button>
      {#if readyVisible}
        <!-- desktop: the ready-to-merge toggle graduates out of the git-actions
             disclosure into the always-visible primary row (mobile shows it in the
             rail unconditionally via GitRail). Shared component → no drift. -->
        <ReadyToggle sessionId={session.id} ready={session.readyToMerge} variant="bar" />
      {/if}
      {#if autopilotToggleVisible}
        <!-- desktop: per-session autopilot override toggle. Reflects the EFFECTIVE state
             (session override, else repo default) so a null-override session isn't shown
             as off while the repo default has it running. -->
        <button
          class="ap-toggle"
          class:on={autopilotEffective}
          type="button"
          aria-pressed={autopilotEffective}
          aria-label={m.session_autopilot_toggle_aria()}
          title={autopilotEffective
            ? m.session_autopilot_on_label()
            : m.session_autopilot_off_label()}
          onclick={toggleSessionAutopilot}
        >
          {autopilotEffective ? m.session_autopilot_on_label() : m.session_autopilot_off_label()}
        </button>
        <AutopilotBadge {session} />
      {/if}
    {/if}
    <!-- trailing controls: on compact/phone they group + wrap together as a
         right-aligned cluster so the close button never orphans to its own row -->
    <div class="vp-actions">
      {#if compact}
        {@render renameControl()}
        <!-- mobile space-saver: folds the tabs + PR rail + build queue away so the
             terminal claims the freed height. State persists across sessions. -->
        <button
          class="vp-fold"
          type="button"
          aria-expanded={!headerCollapsed}
          aria-controls={foldRegionId}
          aria-label={headerCollapsed ? m.viewport_unfold_aria() : m.viewport_fold_aria()}
          title={headerCollapsed ? m.viewport_unfold_aria() : m.viewport_fold_aria()}
          onclick={toggleFold}
        >
          <!-- chevron points the way the secondary chrome moves, per the user's
               explicit "Pfeil nach unten" request: ▾ while expanded (tap to fold it
               down/away), ▴ once folded (tap to bring it back up). This intentionally
               inverts the desktop git-toggle's disclosure caret, which is a separate
               control that never co-renders with this one. -->
          <span aria-hidden="true">{headerCollapsed ? "▴" : "▾"}</span>
        </button>
      {/if}
      {#if resumable}
        <!-- bring claude back when the session is parked (idle/done) — e.g. claude
             exited to a shell after a herdr restart. Forces a fresh claude --resume. -->
        <button
          class="vp-resume"
          type="button"
          onclick={() => resumeSession(true)}
          disabled={resuming}
          title={m.viewport_resume_title()}
          aria-label={m.viewport_resume_title()}
        >
          <span class="vp-resume-icon" aria-hidden="true">{resuming ? "⏳" : "↻"}</span>
          {#if !compact}<span>{m.cardmenu_resume_short()}</span>{/if}
        </button>
      {/if}
      <button
        class="decom"
        class:armed
        class:ready={prReady && !armed}
        type="button"
        onclick={decommission}
        title={prReady ? m.viewport_decommission_ready_title() : m.viewport_decommission_title()}
        aria-label={prReady ? m.viewport_decommission_ready_aria() : m.viewport_decommission_aria()}
      >
        {#if compact}
          {armed ? "✓" : "✕"}
        {:else}
          {armed ? m.viewport_confirm_decommission() : m.viewport_decommission()}
        {/if}
      </button>
    </div>
  </div>

  <!-- the git rail gets its own strip when there's no room for it inline:
       always on compact layouts (mobile + unfolded fold, where the header wraps),
       and on desktop only while the PR disclosure toggle is open. -->
  {#if (compact && !headerCollapsed) || gitOpen}
    <div class="vp-git-strip">
      <GitRail
        sessionId={session.id}
        repoPath={session.repoPath}
        name={session.name}
        prompt={session.prompt}
        ready={session.readyToMerge}
        status={session.status}
        showReady={compact}
        planPhase={session.planPhase}
        isolated={session.isolated}
        baseBranch={session.baseBranch}
        mobile
      />
    </div>
  {/if}

  <!-- build queue panel: shown when the flag is on OR a queue already exists for this
       session — folded away with the rest of the secondary chrome on mobile -->
  {#if !headerFolded}
    <BuildQueuePanel
      sessionId={session.id}
      enabled={repoConfig.flags(session.repoPath).buildQueue}
      queue={buildQueue ?? null}
      onbootstrap={(q) => onSeedBuildQueue?.(q)}
    />
  {/if}

  <!-- scan overlay + terminal (terminal stays mounted across tab switches) -->
  <div class="vp-body">
    <div class="scan" aria-hidden="true"></div>
    <div
      class="term-mount"
      class:dragging
      role="region"
      aria-label={m.viewport_terminal_tab()}
      bind:this={el}
      style:display={tab === "term" ? undefined : "none"}
      ondragover={(e) => {
        e.preventDefault();
        dragging = true;
      }}
      ondragleave={(e) => {
        if (e.target === e.currentTarget) dragging = false;
      }}
      ondrop={onTermDrop}
    ></div>
    {#if tab === "term" && scrolledUp && !parked}
      <button
        class="scroll-bottom"
        type="button"
        onclick={scrollToBottom}
        title={m.viewport_scroll_to_bottom()}
        aria-label={m.viewport_scroll_to_bottom()}
      >
        <span aria-hidden="true">↓</span>
      </button>
    {/if}
    {#if parked && tab === "term"}
      <button class="parked" type="button" onclick={takeover}>
        <span class="parked-icon" aria-hidden="true">▶</span>
        <span class="parked-title">{m.viewport_parked_title()}</span>
        <span class="parked-sub">{m.viewport_parked_sub()}</span>
      </button>
    {/if}
    {#if ended && !parked && tab === "term" && endReason === "unreachable"}
      <!-- herdr is down, not the agent — re-attach (no claudeSessionId needed) -->
      <button class="parked resume" type="button" onclick={reattach}>
        <span class="parked-icon" aria-hidden="true">↻</span>
        <span class="parked-title">{m.viewport_reconnect_title()}</span>
        <span class="parked-sub">{m.viewport_reconnect_sub()}</span>
      </button>
    {:else if ended && !parked && tab === "term" && session.claudeSessionId}
      <button
        class="parked resume"
        type="button"
        onclick={() => resumeSession()}
        disabled={resuming}
      >
        <span class="parked-icon" aria-hidden="true">{resuming ? "⏳" : "↻"}</span>
        <span class="parked-title"
          >{resumeFailed ? m.viewport_resume_failed() : m.viewport_resume_title()}</span
        >
        <span class="parked-sub">{resuming ? m.common_loading() : m.viewport_resume_sub()}</span>
      </button>
    {/if}
    {#if tab === "todo"}
      <div class="panel-wrap">
        <TodoPanel repoPath={session.repoPath} />
      </div>
    {/if}
    {#if tab === "issues"}
      <div class="panel-wrap">
        <IssuesPanel
          repoPath={session.repoPath}
          onnewtask={(issue) => onnewtask?.(session.repoPath, issue)}
          onquick={onquick ? (issue) => onquick(session.repoPath, issue) : undefined}
        />
      </div>
    {/if}
    {#if tab === "activity"}
      <div class="panel-wrap">
        <ActivityFeed sessionId={session.id} />
      </div>
    {/if}
    {#if tab === "diff"}
      <div class="panel-wrap">
        <DiffPanel sessionId={session.id} />
      </div>
    {/if}
    {#if tab === "preview" && previewUrl}
      <div class="panel-wrap preview-pane">
        <!-- Cross-origin iframe: the previewed app runs on its own origin:port, so
             that distinct origin IS the trust boundary (it can't script the HUD).
             The sandbox keeps `allow-same-origin` so the app stays at its REAL origin
             and its own fetches/storage/HMR keep working (omitting it would force an
             opaque origin and break them); it deliberately withholds every
             `allow-top-navigation*` token so untrusted agent JS can't redirect the
             operator's HUD tab on a user gesture. We never infer load success from
             onload/onerror (a cross-origin frame gives no reliable signal);
             availability is the server-driven port above. -->
        <iframe
          class="preview-frame"
          src={previewUrl}
          title={m.viewport_preview_tab()}
          referrerpolicy="no-referrer"
          sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals allow-downloads"
        ></iframe>
        <div class="preview-foot">
          <!-- Persistent static setup hint (NOT an auto-detected error): a blank
               frame usually means the preview port isn't tailscale-served yet, or the
               app refuses to frame via in-HTML CSP — both handled by open-in-new-tab. -->
          <span class="preview-hint">{m.viewport_preview_setup_hint()}</span>
          <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external preview origin (distinct port), not an app route -->
          <a class="preview-open" href={previewUrl} target="_blank" rel="noopener"
            >{m.viewport_preview_open_new_tab()}</a
          >
        </div>
      </div>
    {/if}
  </div>

  {#if tab === "term"}
    <SteerBar focusedId={session.id} onbroadcast={() => onbroadcast?.()} />
  {/if}

  <!-- control-key bar: any touch device (incl. unfolded foldables wider than the
       mobile breakpoint) gets it, since there's no hardware keyboard to steer with -->
  {#if (mobile || touch) && tab === "term"}
    <div class="ctrl-row" bind:this={ctrlRowEl} data-swipe-ignore>
      <!-- Esc frozen on the left edge; Tab/Space + arrows + ^-keys scroll in the
           middle; attach/dictate/Enter frozen on the right. Tab/Space ride along
           in the scroll well so the frozen edge stays one button wide — on a
           portrait phone a wider frozen cluster squeezed the scroll window to ~2
           keys. There's no compose chip — swipe up from this row to summon the
           compose sheet. -->
      <ControlBar onkey={(seq) => conn?.send(seq)} include={["cancel"]} scroll={false} />
      <ControlBar onkey={(seq) => conn?.send(seq)} include={["edit", "nav", "signal"]} />
      <!-- only while Claude's prompt offers it: a pulsing "add notes" key. There's
           no keyboard on a phone to press the letter, so this is the sole way into
           the dialog's notes branch; it pulses to catch the eye and vanishes once
           the prompt does -->
      {#if notesKey}
        <button
          type="button"
          class="notes"
          aria-label={m.viewport_notes_aria({ key: notesKey })}
          onpointerup={(e) => {
            e.preventDefault();
            if (notesKey) conn?.send(notesKey);
          }}>📝 {notesKey.toUpperCase()}</button
        >
      {/if}
      <button
        type="button"
        class="attach"
        class:failed={uploadFailed}
        title={uploadFailed ? m.viewport_upload_failed() : m.viewport_attach_image()}
        onclick={() => fileInput?.click()}
        aria-label={m.viewport_attach_image()}
      >
        {uploading ? "⏳" : uploadFailed ? "⚠" : "📎"}
      </button>
      {#if speechSupported}
        <button
          type="button"
          class="dictate"
          title={m.composebar_dictate_aria()}
          aria-label={m.composebar_dictate_aria()}
          onpointerdown={(e) => {
            e.preventDefault();
            openDictate();
          }}>{m.composebar_dictate()}</button
        >
      {/if}
      <button
        type="button"
        class="enter"
        aria-label={enter.aria}
        onpointerup={(e) => {
          e.preventDefault();
          conn?.send(enter.seq);
        }}>{enter.label}</button
      >
    </div>
    {#if composeOpen}
      <ComposeBar
        onsend={sendComposed}
        onclose={() => (composeOpen = false)}
        repoPath={session.repoPath}
        startDictation={composeDictate}
      />
    {/if}
    <input
      bind:this={fileInput}
      type="file"
      accept="image/*"
      multiple
      hidden
      onchange={(e) => {
        const t = e.currentTarget;
        if (t.files) attachImages(t.files);
        t.value = "";
      }}
    />
  {/if}

  <!-- footer: keyboard-affordance hints — true desktop only (mouse + hardware
       keyboard). Any coarse-pointer device (phone OR unfolded foldable) has no
       Tab key, so the hints are pure overhead; dropping it hands the height back
       to the terminal AND keeps the ctrl-row the bottom-most element, so the
       swipe-up-from-the-bottom-edge compose gesture lands on it (the footer would
       otherwise sit below the row and swallow the gesture's start on foldables). -->
  {#if !compact}
    <div class="vp-foot">
      <span>{m.viewport_type_steer_hint()}</span>
      <span class="sep">·</span>
      <span>{m.viewport_detach_hint()}</span>
      <span class="sep">·</span>
      <span>{m.viewport_select_hint({ key: isMac ? "⌥" : "⇧" })}</span>
    </div>
  {/if}
</div>

{#if leftovers.length > 0}
  <LeftoverDialog
    {leftovers}
    onclose={() => {
      leftovers = [];
      onarchive?.(session.id);
    }}
    onconfirm={(keys) => {
      leftovers = [];
      onarchive?.(session.id, keys);
    }}
  />
{/if}

<style>
  .viewport {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    overflow: hidden;
    /* snap back after a released horizontal swipe; suppressed while finger-dragging */
    transition: transform 0.2s ease;
  }

  .viewport.swiping {
    transition: none;
  }

  .vp-head {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 6px 12px;
    background: var(--color-head);
    border-bottom: 1px solid var(--color-line);
    font-size: var(--fs-meta);
    flex-shrink: 0;
    white-space: nowrap;
    /* not overflow:hidden — the Open-PR popover drops below the header and must
       escape it; long content is still clipped by .viewport's overflow */
    overflow: visible;
  }

  /* running: a faint amber wash that slowly breathes in intensity. Lower
     chroma than the saturated blocked/done tint so it reads as ambient
     "still busy", never as an alert. Only applies when no saturated tint is
     present. Status is carried by the background tint alone — no side stripe. */
  .vp-head.working {
    background: color-mix(in srgb, var(--color-amber) 4%, var(--color-head));
    animation: vp-working-pulse 2.4s ease-in-out infinite;
  }
  @keyframes vp-working-pulse {
    0%,
    100% {
      background: color-mix(in srgb, var(--color-amber) 4%, var(--color-head));
    }
    50% {
      background: color-mix(in srgb, var(--color-amber) 9%, var(--color-head));
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .vp-head.working {
      animation: none;
      background: color-mix(in srgb, var(--color-amber) 7%, var(--color-head));
    }
  }

  .desig-wrap {
    position: relative;
    flex-shrink: 0;
    display: inline-flex;
  }

  .desig {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
    flex-shrink: 0;
    cursor: default;
    border-bottom: 1px dotted var(--color-line);
  }
  .desig-wrap:hover .desig {
    color: var(--color-ink);
  }
  /* keyboard focus — flat inset amber ring, distinct from the hover color shift */
  .desig:focus-visible {
    color: var(--color-ink);
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }

  /* secondary meta popover (profile + tokens), revealed on hover/focus of the desig */
  .desig-pop {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 20;
    display: none;
    flex-direction: column;
    gap: 3px;
    padding: 6px 9px;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
    white-space: nowrap;
    text-transform: none;
    letter-spacing: normal;
  }
  .desig-wrap:hover .desig-pop,
  .desig-wrap:focus-within .desig-pop {
    display: flex;
  }
  .dp-row {
    display: flex;
    gap: 10px;
    justify-content: space-between;
    font-size: var(--fs-meta);
  }
  .dp-k {
    color: var(--color-muted);
  }
  .dp-v {
    color: var(--color-ink);
    font-variant-numeric: tabular-nums;
  }

  /* full task name — surfaced in compact headers where the session list is
     hidden, so the desig number alone can't identify the session */
  .vp-name {
    color: var(--color-ink);
    font-size: var(--fs-base);
    /* flex-basis 0 (not auto) so the name's content width doesn't drive the
       wrap calc on mobile — otherwise a long name reserves the whole row and
       pushes the decommission button onto the next line. It absorbs the slack
       and ellipsizes instead. */
    min-width: 0;
    flex: 1 1 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .branch {
    color: var(--color-ink);
    font-size: var(--fs-base);
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 22ch;
  }

  .sep {
    color: var(--color-faint);
  }

  .spacer {
    flex: 1;
  }

  /* desktop: transparent to layout — rename + decom flow inline as before.
     compact/phone override (see .vp-head.mobile .vp-actions) turns this into a
     real flex cluster so the two trailing controls wrap together. */
  .vp-actions {
    display: contents;
  }

  /* mobile fold toggle: a bare chevron in the trailing actions cluster that
     hides/shows the secondary header chrome. Mirrors the .decom ghost styling
     so the two trailing controls read as a set. */
  .vp-fold {
    flex-shrink: 0;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 2px;
    color: var(--color-faint);
    font-family: var(--font-mono);
    font-size: var(--fs-base);
    line-height: 1;
    padding: 2px 7px;
    cursor: pointer;
    transition:
      color 0.12s,
      border-color 0.12s,
      background 0.12s;
  }
  .vp-fold:hover {
    color: var(--color-ink);
    border-color: var(--color-line-bright);
  }
  /* folded tabs are display:none rather than removed from the DOM so the active
     tab + terminal mount survive the toggle (no remount, no PTY teardown) */
  .tab-group.folded {
    display: none;
  }

  .status-badge {
    font-size: var(--fs-micro);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    padding: 2px 7px;
    border: 1px solid;
    border-radius: 2px;
    flex-shrink: 0;
  }

  /* desktop disclosure for the git rail — a ghost chip that toggles the second
     header row. Stays neutral until the PR has an actionable verdict, then takes a
     hue: green = CI green & critic clear (ready to merge), amber = needs you (CI
     failed or critic requested changes). Pending / merged / closed stay neutral. */
  .git-toggle {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    flex-shrink: 0;
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 2px 7px;
    cursor: pointer;
    transition:
      color 0.12s,
      border-color 0.12s,
      background 0.12s;
  }
  .git-toggle:hover {
    color: var(--color-ink);
  }
  .git-toggle.open {
    color: var(--color-ink-bright);
    background: var(--color-inset);
  }
  .git-toggle.attention {
    color: var(--color-amber);
    border-color: color-mix(in srgb, var(--color-amber) 55%, transparent);
    box-shadow: inset 0 0 18px -10px var(--color-amber);
  }
  .git-toggle.clear {
    color: var(--color-green);
    border-color: color-mix(in srgb, var(--color-green) 55%, transparent);
    box-shadow: inset 0 0 18px -10px var(--color-green);
  }
  .gt-dot {
    flex: 0 0 auto;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-faint);
  }
  .git-toggle.attention .gt-dot {
    background: var(--color-amber);
  }
  .git-toggle.clear .gt-dot {
    background: var(--color-green);
  }
  .gt-caret {
    color: var(--color-faint);
    font-size: var(--fs-micro);
    line-height: 1;
  }
  .git-toggle.open .gt-caret,
  .git-toggle.attention .gt-caret,
  .git-toggle.clear .gt-caret {
    color: currentColor;
  }

  /* per-session autopilot toggle: matches .git-toggle sizing + .ready-toggle.bar style */
  .ap-toggle {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 2px 7px;
    cursor: pointer;
    transition:
      color 0.12s,
      border-color 0.12s;
  }
  .ap-toggle:hover {
    color: var(--color-ink);
  }
  .ap-toggle.on {
    color: var(--color-green);
    border-color: color-mix(in srgb, var(--color-green) 55%, transparent);
  }

  /* phone merged header: repo · session (subsumes the now-hidden top bar) */
  .desig-wrap.ctx {
    min-width: 0;
    flex: 0 1 auto;
  }
  .ctx-trigger {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    cursor: default;
  }
  .ctx-glyph {
    color: var(--color-amber);
    font-size: var(--fs-meta);
    flex-shrink: 0;
  }
  .ctx-glyph.emoji {
    font-size: var(--fs-lg);
  }
  .ctx-repo {
    color: var(--color-ink-bright);
    font-weight: 600;
    font-size: var(--fs-base);
    letter-spacing: 0.02em;
    white-space: nowrap;
    flex-shrink: 0;
    max-width: 38vw;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ctx-sep {
    color: var(--color-faint);
    flex-shrink: 0;
  }
  .ctx-name {
    color: var(--color-ink);
    font-size: var(--fs-base);
    min-width: 0;
    /* ellipsize well before the row fills, ceding width to the close button */
    max-width: 34vw;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* phone: collapsed usage gauge — only mounted when the hotter window runs hot */
  .vp-gauge {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
  }
  .vp-gauge .g-bar {
    width: 26px;
    height: 5px;
    background: var(--color-line);
    border: 1px solid var(--color-line-bright);
    overflow: hidden;
  }
  .vp-gauge .g-fill {
    display: block;
    height: 100%;
    width: 100%;
    transform-origin: left;
  }

  /* phone: connection lost — a lone red dot (alert by exception) */
  .vp-offline {
    color: var(--color-red);
    font-size: var(--fs-micro);
    flex-shrink: 0;
  }

  /* leading shape mark (! blocked / ✓ done) — the non-hue partner to the header
     tint so the two alert states never rest on colour alone */
  .vp-status-glyph {
    flex-shrink: 0;
    font-weight: 700;
    font-size: var(--fs-base);
    line-height: 1;
    margin-right: 1px;
  }

  /* status word for assistive tech only; sighted users read it from the tint +
     the leading shape glyph (blocked/done) */
  .vp-status-sr {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .decom {
    flex-shrink: 0;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 2px;
    color: var(--color-faint);
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 2px 7px;
    cursor: pointer;
    transition:
      color 0.12s,
      border-color 0.12s,
      background 0.12s;
  }

  /* Resume: a quiet neutral action (not destructive, not "ready-complete" → no
     green/red), brightening to ink on hover. Sits left of the decommission ✕. */
  .vp-resume {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 2px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 2px 7px;
    cursor: pointer;
    transition:
      color 0.12s,
      border-color 0.12s;
  }
  .vp-resume:hover {
    color: var(--color-ink-bright);
    border-color: var(--color-line-bright);
  }
  .vp-resume:disabled {
    cursor: default;
    opacity: 0.6;
  }
  .vp-resume-icon {
    font-size: var(--fs-meta);
  }

  /* PR delivered → the work is done. Lift the otherwise-faint ✕ into a bright,
     gently pulsing green call-to-action so wrapping up the session reads as the
     obvious next step. Hover/armed below still override it red (destructive confirm). */
  .decom.ready {
    color: var(--color-green);
    border-color: color-mix(in srgb, var(--color-green) 40%, transparent);
    background: color-mix(in srgb, var(--color-green) 10%, transparent);
    animation: decom-ready-pulse 2.4s ease-in-out infinite;
  }

  @keyframes decom-ready-pulse {
    0%,
    100% {
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-green) 30%, transparent);
    }
    50% {
      box-shadow: 0 0 6px 1px color-mix(in srgb, var(--color-green) 35%, transparent);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .decom.ready {
      animation: none;
    }
  }

  .decom:hover {
    color: var(--color-red);
    border-color: color-mix(in srgb, var(--color-red) 45%, transparent);
  }

  /* hovering the ready button means the operator is about to act on it — drop the
     green pulse so the red destructive-confirm affordance reads cleanly */
  .decom.ready:hover {
    background: transparent;
    animation: none;
    box-shadow: none;
  }

  .decom.armed {
    color: var(--color-red);
    border-color: var(--color-red);
    background: color-mix(in srgb, var(--color-red) 12%, transparent);
  }

  /* rename: pencil affordance + inline editor — next to the task name on desktop,
     in the trailing cluster (left of decommission) on compact/phone */
  .rename-btn {
    flex-shrink: 0;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 2px;
    color: var(--color-faint);
    font-size: var(--fs-meta);
    line-height: 1;
    padding: 2px 6px;
    cursor: pointer;
    transition:
      color 0.12s,
      border-color 0.12s;
  }
  .rename-btn:hover {
    color: var(--color-ink);
    border-color: color-mix(in srgb, var(--color-ink) 30%, transparent);
  }

  .rename-edit {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }
  .rename-input {
    background: var(--color-bg);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-ink-bright);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    padding: 2px 6px;
    width: 14ch;
    max-width: 40vw;
  }
  .rename-input:focus {
    outline: none;
    border-color: var(--color-line-bright);
  }
  .rename-input.err {
    border-color: var(--color-red);
  }
  .rename-err {
    color: var(--color-red);
    font-size: var(--fs-micro);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 18ch;
  }
  .rename-note {
    color: var(--color-faint);
    font-size: var(--fs-micro);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 22ch;
  }

  .vp-body {
    position: relative;
    flex: 1;
    overflow: hidden;
  }

  /* faint amber scan line: full-height layer with a 70px amber band at its top,
     swept top→bottom via translateY (compositor-only) instead of animating top */
  .scan {
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    height: 100%;
    background-image: linear-gradient(
      to bottom,
      transparent,
      color-mix(in srgb, var(--color-amber) 4%, transparent),
      transparent
    );
    background-repeat: no-repeat;
    background-size: 100% 70px;
    background-position: 0 0;
    pointer-events: none;
    z-index: 1;
    will-change: transform;
    animation: scan 8s linear infinite;
  }

  .term-mount {
    width: 100%;
    height: 100%;
    overflow: hidden;
    /* we drive vertical scroll via touch handlers; keep the browser out of it */
    touch-action: none;
  }

  /* parked: this terminal is live on another device — tap to take it back */
  .parked {
    position: absolute;
    inset: 0;
    z-index: 3;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    background: color-mix(in srgb, var(--color-bg) 78%, transparent);
    backdrop-filter: blur(1.5px);
    border: 0;
    cursor: pointer;
    font: inherit;
    color: var(--color-ink);
  }
  .parked-icon {
    color: var(--color-amber);
    font-size: var(--fs-2xl);
    line-height: 1;
  }
  .parked-title {
    color: var(--color-ink-bright);
    letter-spacing: 0.08em;
    font-size: var(--fs-base);
  }
  .parked-sub {
    color: var(--color-muted);
    font-size: var(--fs-meta);
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }
  .parked.resume:disabled {
    cursor: progress;
    opacity: 0.7;
  }

  /* jump-to-bottom: small round affordance, bottom-right of the terminal body.
     sits above xterm content (z-index 2) but below the parked/resume overlays (3) */
  .scroll-bottom {
    position: absolute;
    bottom: 12px;
    right: 14px;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    border-radius: 50%;
    border: 1px solid var(--color-line-bright);
    background: color-mix(in srgb, var(--color-head) 90%, transparent);
    backdrop-filter: blur(2px);
    color: var(--color-ink);
    font-size: var(--fs-lg);
    line-height: 1;
    cursor: pointer;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
    transition:
      background 0.12s ease,
      color 0.12s ease,
      transform 0.12s ease;
    animation: scroll-bottom-in 0.14s ease;
  }
  .scroll-bottom:hover {
    background: var(--color-hover);
    color: var(--color-ink-bright);
    transform: translateY(-1px);
  }
  /* Coarse pointers (touch): grow the free-floating affordance to a ≥44px tap
     target. It sits in the terminal corner with room to spare, so enlarging the
     element itself is simplest — stays round, stays flat. Desktop (fine pointer)
     keeps the dense 30px glyph. */
  @media (pointer: coarse) {
    .scroll-bottom {
      min-width: 44px;
      min-height: 44px;
    }
  }
  @keyframes scroll-bottom-in {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  /* let xterm fill the mount */
  .term-mount :global(.xterm) {
    height: 100%;
  }

  /* xterm v6 renders its own scrollbar (vscode scrollable element) */
  .term-mount :global(.xterm-scrollable-element .scrollbar .slider) {
    background: var(--color-faint);
    border-radius: 2px;
  }

  .tab-group {
    display: flex;
    gap: 2px;
  }

  .back {
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 4px 9px;
    cursor: pointer;
    flex-shrink: 0;
  }
  .back:hover {
    background: var(--color-hover);
  }
  /* red highlight: mirrors the TopBar "needs you" badge — jumps to the next session
     actively waiting on the operator. */
  .next-yu {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: color-mix(in srgb, var(--color-red) 18%, transparent);
    border: 1px solid var(--color-red);
    color: var(--color-red);
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.14em;
    padding: 4px 9px;
    cursor: pointer;
    flex-shrink: 0;
    white-space: nowrap;
  }
  .next-yu:hover {
    background: color-mix(in srgb, var(--color-red) 28%, transparent);
  }
  .nyu-arrow {
    font-size: var(--fs-base);
    line-height: 1;
    letter-spacing: 0;
  }
  /* phone/touch: collapse to an icon+count chip (full label drops to the aria-label),
     matching the TopBar compact badge instead of carrying the full word. */
  .next-yu.compact {
    justify-content: center;
    gap: 4px;
    min-width: 40px;
    letter-spacing: 0;
    font-variant-numeric: tabular-nums;
  }
  .next-yu.compact .ny-icon {
    font-weight: 700;
    line-height: 1;
  }
  .next-yu.compact .ny-n {
    font-weight: 600;
  }

  /* ‹ n/total › paging through the "needs you" queue — compact layouts only */
  .queue-nav {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }
  .queue-nav button {
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-lg);
    line-height: 1;
    min-width: 40px;
    min-height: 40px;
    cursor: pointer;
  }
  .queue-nav button:active {
    background: var(--color-line-bright);
  }
  .queue-pos {
    color: var(--color-amber);
    font-variant-numeric: tabular-nums;
    font-size: var(--fs-meta);
    min-width: 28px;
    text-align: center;
  }

  /* dedicated git-rail strip for compact layouts (mobile + unfolded fold) */
  .vp-git-strip {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 6px;
    padding: 6px 10px;
    background: var(--color-head);
    border-bottom: 1px solid var(--color-line);
    flex-shrink: 0;
    min-height: 44px;
  }

  .vp-head.mobile {
    flex-wrap: wrap;
    row-gap: 6px;
    padding: 8px 10px;
  }
  /* group the trailing controls (rename ✎ + close ✕) into one cluster that
     wraps as a unit and stays right-aligned — margin-left:auto pins it to the
     right edge of whichever row it lands on, so the close button can no longer
     orphan to the left of its own line when the identity row gets crowded */
  .vp-head.mobile .vp-actions {
    display: flex;
    align-items: center;
    gap: 7px;
    margin-left: auto;
    flex-shrink: 0;
  }
  /* let the task name claim the free space instead of splitting it with the
     spacer; its flex-grow still pushes the status badge + decom to the right */
  .vp-head.mobile .spacer {
    display: none;
  }
  /* phone: the identity cluster (back · ✓ · repo · title) MUST stay on one line.
     The repo·title block becomes the row's grower (flex-basis:0 → its hypothetical
     width is 0, so flex line-breaking never overflows and wraps the trailing
     actions — or the title itself — onto a second row). It fills the gap to the
     pinned-right actions and the title ellipsizes inside whatever width is left,
     instead of forcing a wrap when repo + title get long. */
  .vp-head.phone .desig-wrap.ctx {
    flex: 1 1 0;
    min-width: 0;
  }
  .vp-head.phone .ctx-name {
    flex: 1 1 auto;
    min-width: 0;
    /* drop the fixed vw cap on phone — flex + ellipsis size it to the free space */
    max-width: none;
  }
  /* the ctx block is now the sole grower pinning the actions right; the standalone
     spacer would otherwise split the free space and starve the title's width */
  .vp-head.phone .spacer {
    display: block;
    flex: 0;
  }
  .tab-group.mobile {
    order: 10;
    flex-basis: 100%;
    gap: 4px;
  }
  .vp-head.mobile .tab-btn {
    flex: 1;
    text-align: center;
    padding: 10px 6px;
    font-size: var(--fs-meta);
  }
  /* finger-sized header controls on touch layouts (≥40px) */
  .vp-head.mobile .back,
  .vp-head.mobile .next-yu,
  .vp-head.mobile .vp-fold,
  .vp-head.mobile .decom {
    min-height: 40px;
    padding: 8px 12px;
    font-size: var(--fs-base);
  }
  /* phone: the back control is a bare chevron — size it up to read as an icon */
  .vp-head.phone .back {
    font-size: var(--fs-xl);
    line-height: 1;
    padding: 6px 12px;
  }

  .tab-btn {
    background: transparent;
    border: 1px solid transparent;
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.1em;
    padding: 2px 8px;
    cursor: pointer;
    transition:
      color 0.12s,
      border-color 0.12s;
  }

  .tab-btn:hover {
    color: var(--color-ink);
  }

  .tab-btn.active {
    color: var(--color-ink-bright);
    border-color: var(--color-line-bright);
    background: var(--color-inset);
  }

  .panel-wrap {
    position: absolute;
    inset: 0;
    overflow: hidden;
  }

  /* live preview pane: the iframe fills the body; a thin footer carries the
     always-visible setup hint + the open-in-new-tab fallback. */
  .preview-pane {
    display: flex;
    flex-direction: column;
    background: var(--color-bg);
  }
  .preview-frame {
    flex: 1 1 auto;
    width: 100%;
    border: 0;
    background: var(--color-bg);
  }
  .preview-foot {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 5px 12px;
    background: var(--color-head);
    border-top: 1px solid var(--color-line);
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .preview-hint {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .preview-open {
    margin-left: auto;
    flex: none;
    color: var(--color-blue);
    text-decoration: none;
    letter-spacing: 0.04em;
  }
  .preview-open:hover,
  .preview-open:focus-visible {
    text-decoration: underline;
  }
  /* preview tab marker: the non-reserved blue accent ties it to the row badge */
  .tab-btn.preview-tab.active {
    border-color: var(--color-blue);
    color: var(--color-blue);
  }

  .vp-foot {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 12px;
    background: var(--color-head);
    border-top: 1px solid var(--color-line);
    font-size: var(--fs-meta);
    color: var(--color-muted);
    flex-shrink: 0;
  }

  .term-mount.dragging {
    outline: 2px dashed var(--color-amber);
    outline-offset: -4px;
  }
  /* one unified bar across the whole row (scroll palette + pinned actions) */
  .ctrl-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding-right: 10px;
    background: var(--color-head);
    border-top: 1px solid var(--color-line);
  }
  .ctrl-row .dictate,
  .ctrl-row .attach,
  .ctrl-row .enter {
    flex: 0 0 auto;
    min-width: 44px;
    height: 44px;
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    font-size: var(--fs-lg);
    cursor: pointer;
    touch-action: manipulation;
    user-select: none;
    transition:
      background 0.08s,
      border-color 0.08s;
  }
  .ctrl-row .dictate:active,
  .ctrl-row .attach:active,
  .ctrl-row .enter:active {
    background: var(--color-line-bright);
    border-color: var(--color-ink);
  }
  .ctrl-row .attach.failed {
    border-color: var(--color-red);
    color: var(--color-red);
  }
  /* Enter — the single affirmative "do it" key, the only filled accent in the
     row so it reads as the primary action */
  .ctrl-row .enter {
    font-family: var(--font-mono);
    font-size: var(--fs-xl);
    color: var(--color-green);
    border-color: color-mix(in srgb, var(--color-green) 60%, var(--color-line-bright));
    background: color-mix(in srgb, var(--color-green) 18%, var(--color-inset));
  }
  .ctrl-row .enter:active {
    background: color-mix(in srgb, var(--color-green) 34%, var(--color-inset));
    border-color: var(--color-green);
  }
  /* "add notes" affordance — only mounted while Claude's prompt offers it. Amber
     (the same attention hue as the running pip) plus a soft halo pulse so it's
     noticed on a phone where there's no keyboard to press the key directly. The
     global prefers-reduced-motion guard stills the animation. */
  .ctrl-row .notes {
    flex: 0 0 auto;
    min-width: 44px;
    height: 44px;
    padding: 0 10px;
    border-radius: 2px;
    font-family: var(--font-mono);
    font-size: var(--fs-lg);
    letter-spacing: 0.04em;
    white-space: nowrap;
    cursor: pointer;
    touch-action: manipulation;
    user-select: none;
    color: var(--color-amber);
    border: 1px solid color-mix(in srgb, var(--color-amber) 60%, var(--color-line-bright));
    background: color-mix(in srgb, var(--color-amber) 16%, var(--color-inset));
    animation: notes-pulse 1.5s ease-in-out infinite;
    transition:
      background 0.08s,
      border-color 0.08s;
  }
  .ctrl-row .notes:active {
    background: color-mix(in srgb, var(--color-amber) 32%, var(--color-inset));
    border-color: var(--color-amber);
  }
  @keyframes notes-pulse {
    0%,
    100% {
      box-shadow: 0 0 0 0 transparent;
    }
    50% {
      box-shadow: 0 0 0 4px color-mix(in srgb, var(--color-amber) 30%, transparent);
    }
  }
</style>
