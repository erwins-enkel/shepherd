<script lang="ts">
  import "@xterm/xterm/css/xterm.css";
  import { Terminal, type IBufferLine, type IBufferCell } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { WebLinksAddon } from "@xterm/addon-web-links";
  import { WebglAddon } from "@xterm/addon-webgl";
  import type {
    DrainStatus,
    GitState,
    Leftover,
    Session,
    SessionActivity,
    SessionStatus,
    SessionUsage,
    SubagentEntry,
    UsageLimits,
  } from "$lib/types";
  import { STATUS_COLOR, statusLabel, formatTokens, canResume } from "$lib/format";
  import { displayStatus } from "$lib/display-status";
  import { projectIcons } from "$lib/projectIcons.svelte";
  import { hotterGauge, gaugeColor } from "./usage-gauges";
  import { connectPty, type PtyConn } from "$lib/pty";
  import { theme, xtermTheme, xtermMinContrast } from "$lib/theme.svelte";
  import { terminalFontSize, FONT_MIN, FONT_MAX } from "$lib/terminal-font-size.svelte";
  import { tick, untrack } from "svelte";
  import { SvelteMap } from "svelte/reactivity";
  import {
    getSessionUsage,
    getTodo,
    uploadImage,
    resumeSession as apiResumeSession,
    renameSession,
    getLeftovers,
    setSessionAutopilot,
    stopPreview as apiStopPreview,
    getCommands,
    getVoiceStatus,
  } from "$lib/api";
  import { imageFilesFromItems } from "$lib/clipboard";
  import { trimTrailingWhitespace } from "$lib/terminalSelection";
  import { composeKeystrokes } from "$lib/compose";
  import { findCommandLinks } from "$lib/slashLinks";
  import { shouldForwardEscape } from "$lib/terminalEscape";
  import { altComboKey, isCommandBarChord } from "./herd-keynav";
  import { detectNotesKey } from "$lib/notesAffordance";
  import { isScrolledAwayFromBottom, SCROLL_UP_PX } from "$lib/scrollAffordance";
  import { pollWhileVisible } from "$lib/visibility";
  import TodoPanel from "$lib/components/TodoPanel.svelte";
  import ActivityFeed from "$lib/components/ActivityFeed.svelte";
  import SubagentFanout from "$lib/components/SubagentFanout.svelte";
  import DiffPanel from "$lib/components/DiffPanel.svelte";
  import FilesPanel from "./viewport/FilesPanel.svelte";
  import { enterKey } from "$lib/controlKeys";
  import { lockAxis, paneSwipeAction, type Axis } from "./swipe";
  import GitRail from "$lib/components/GitRail.svelte";
  import AutopilotBadge from "$lib/components/AutopilotBadge.svelte";
  import PlanGateBadge from "$lib/components/PlanGateBadge.svelte";
  import { reviews, planGates, repoConfig } from "$lib/reviews.svelte";
  import { recaps } from "$lib/recaps.svelte";
  import { toasts } from "$lib/toasts.svelte";
  import SteerBar from "$lib/components/SteerBar.svelte";
  import ComposeBar from "$lib/components/ComposeBar.svelte";
  import LeftoverDialog from "$lib/components/LeftoverDialog.svelte";
  import BuildQueuePanel from "$lib/components/BuildQueuePanel.svelte";
  import EpicDraftPanel from "$lib/components/EpicDraftPanel.svelte";
  import SessionRecap from "$lib/components/SessionRecap.svelte";
  import ViewportTermBanners from "./viewport/ViewportTermBanners.svelte";
  import ReviewInFlightBanner from "./viewport/ReviewInFlightBanner.svelte";
  import CiRunningBanner from "./viewport/CiRunningBanner.svelte";
  import ViewportTermControls from "./viewport/ViewportTermControls.svelte";
  import ViewportTabBar from "./viewport/ViewportTabBar.svelte";
  import ViewportHeaderActions from "./viewport/ViewportHeaderActions.svelte";
  import ClipboardPill from "./viewport/ClipboardPill.svelte";
  import { handleOsc52 } from "$lib/osc52";
  import type { BuildQueue } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { modelLabel } from "$lib/model-label";
  import { effortLabel } from "$lib/effort-guidance";
  import { buildPreviewUrl } from "$lib/previewUrl";
  import { longPress } from "./longpress";

  // Enter pinned in the thumb zone — locale-reactive for its accessible name.
  const enter = $derived(enterKey());

  let {
    session,
    onarchive,
    onback,
    onretry,
    retryHaltedCount = 0,
    retryReady = false,
    onedit,
    mobile = false,
    touch = false,
    queue = [],
    switchOrder = [],
    onnavigate,
    limits = null,
    connected = true,
    git = null,
    activity = undefined,
    previewPort = null,
    claudeAlive = undefined,
    previewServeFailed = false,
    previewMap = {},
    openPreviewTick = 0,
    renameRequest = null,
    buildQueue = null,
    onSeedBuildQueue,
    previewHost = null,
    workingBlocked = {},
    authUrl = null,
    consumeAutoFocusTerm = () => true,
    drain = null,
    subagents = {},
  }: {
    session: Session;
    onarchive?: (id: string, reap?: string[]) => void;
    onback?: () => void;
    onretry?: () => void;
    retryHaltedCount?: number;
    retryReady?: boolean;
    onedit?: (steerId?: string) => void;
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
    /** Live focused-session activity signal (heartbeat + current task-agent tool summary). */
    activity?: SessionActivity;
    /** Live preview-listener port for this session (server-driven). Non-null → the
     *  Preview tab + pane are available; the iframe URL is built from window.location. */
    previewPort?: number | null;
    /** Server-swept claude-process liveness for this session: true = a `claude`
     *  process still lives in the worktree (hide Resume), false = husk shell
     *  (offer Resume), undefined = not swept yet (offer Resume, fail-safe). */
    claudeAlive?: boolean;
    /** true when the server's tailscale serve registration failed for this session's
     *  preview port — the preview is reachable on loopback only, not over Tailscale. */
    previewServeFailed?: boolean;
    /** Authoritative per-session preview-port map (the whole store.preview record).
     *  Stop-pending resolution reads THIS (not the single focused `previewPort`) so a
     *  stop confirmed after the operator navigates to another unit still resolves the
     *  right session — otherwise the old unit's timeout fires a false "couldn't stop". */
    previewMap?: Record<string, number | null>;
    /** Monotonic tick bumped by a row's Preview-badge click → switch to the Preview tab. */
    openPreviewTick?: number;
    /** Targeted request from a card context-menu Rename action. */
    renameRequest?: { id: string; tick: number } | null;
    /** Current build queue for this session; updated live by WS queue:update events. */
    buildQueue?: BuildQueue | null;
    /** Called when the panel bootstrap-GETs or mutates a queue, to seed the store. */
    onSeedBuildQueue?: (q: BuildQueue) => void;
    /** The agent node's own tailnet host; preview URLs build from it when the HUD is
     *  fronted on a different host. Null → fall back to the operator's connection host. */
    previewHost?: string | null;
    /** Working-while-blocked display flags (store map). Header status displays read
     *  the derived `dStatus`; behavioral reads (resume self-heal, preview confirm
     *  arm) stay on the raw `session.status`. */
    workingBlocked?: Record<string, boolean>;
    /** Pending MCP OAuth authorization URL for this session's awaiting-input block (from
     *  the block reason). Drives the "open in browser" banner above the terminal; null
     *  when the agent isn't waiting on an auth URL. */
    authUrl?: string | null;
    /** One-shot gate for the mount auto-focus: the page records whether the selection
     *  that remounted this terminal *wants* the keyboard (click / Alt-combo / Enter →
     *  yes; plain j/k chaining → no), and this consumes that intent — read it, reset
     *  it to true, return it. The always-true default merely keeps the prop optional
     *  (tests / future callers). */
    consumeAutoFocusTerm?: () => boolean;
    /** Live drain status for this session's repo; passed through to GitRail →
     *  AutomationPanel so the epic-mode precedence indicator can render. */
    drain?: DrainStatus | null;
    /** Live per-session sub-agent roster map (the whole store.subagents record);
     *  the Activity tab's fan-out section reads this session's entry from it. */
    subagents?: Record<string, SubagentEntry[]>;
  } = $props();

  // Display-side status for every header/status render below (see display-status.ts).
  const dStatus = $derived(displayStatus(session, workingBlocked));

  const headerNameSlug = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

  // Branch label for the header: every session branch is cut as `shepherd/<name>`,
  // so the prefix is pure noise that only eats the truncation budget — strip it and
  // surface the descriptive tail (the part the user actually distinguishes by).
  const branchLabel = $derived(
    (session.branch ?? session.worktreePath)?.replace(/^shepherd\//, ""),
  );
  const branchRepeatsSessionName = $derived(
    !!session.branch &&
      !!branchLabel &&
      headerNameSlug(branchLabel) === headerNameSlug(session.name),
  );

  const activityRecap = $derived(recaps.map[session.id]);
  // settled = the session has stopped working; a recap survives re-activation
  // (src/recap.ts), so a resumed (running) session must fall back to the live feed.
  const recapSettled = $derived(session.status === "idle" || session.status === "done");
  const showInlineRecap = $derived(activityRecap?.state === "ready" && recapSettled);

  let el: HTMLDivElement | undefined = $state();
  // root element + live signed offset (px) for the phone horizontal swipe gesture:
  // negative pages to the next queued agent, positive to the previous / back to list
  let viewportEl: HTMLDivElement | undefined = $state();
  let swipeX = $state(0);
  let swiping = $state(false);
  let tab = $state<"term" | "todo" | "activity" | "diff" | "files" | "preview">("term");
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

  // Compose sheet — owned here because its two entry points live on different rows:
  // the SteerBar mic (Row 1) opens it dictating; the ctrl-row swipe-up (Row 2) opens
  // it in type mode. Both rows get callbacks that flip this state; the sheet mounts
  // once below.
  let composeOpen = $state(false);
  let composeDictate = $state(false);

  // Mic availability (mobile/touch only). Web Speech is the primary path; the
  // local-Whisper plugin adds a mic on clients that can record (MediaRecorder +
  // getUserMedia) even without Web Speech (e.g. an iOS home-screen PWA). The
  // getVoiceStatus probe is gated to touch layouts so desktop fires no needless call.
  const speechSupported =
    typeof window !== "undefined" &&
    !!(
      (window as { SpeechRecognition?: unknown }).SpeechRecognition ??
      (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition
    );
  const recorderSupported =
    typeof window !== "undefined" &&
    typeof MediaRecorder !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia;
  let localVoiceAvailable = $state(false);
  $effect(() => {
    if (!(mobile || touch)) return;
    getVoiceStatus()
      .then((s) => (localVoiceAvailable = s.available && recorderSupported))
      .catch(() => {});
  });
  const micAvailable = $derived((mobile || touch) && (speechSupported || localVoiceAvailable));

  // composed send: routes the line through composeKeystrokes (atomic bracketed
  // paste) instead of xterm's textarea, sidestepping the Android IME duplication bug.
  const sendComposed = (text: string) => conn?.send(composeKeystrokes(text));

  // monotonic local keystroke counter, bumped on every term.onData — drives the
  // ReviewInFlightBanner's client-side escalation (issue #1022). Pure UI signal,
  // independent of the server-side lastOperatorKeystrokeAt seam.
  let opKeystrokes = $state(0);
  // occupied height (px) of the ReviewInFlightBanner while it's shown, 0 otherwise.
  // Published as --review-banner-h on .vp-body so the floating jump-to-latest button
  // (a sibling in ViewportTermBanners) can lift clear of the bottom banner strip.
  let reviewBannerH = $state(0);
  // occupied height of the CiRunningBanner, and the review banner's logical
  // visibility. The two strips are mutually exclusive by construction (CI suppresses
  // itself while reviewActive), so at most one publishes a non-zero height — the
  // jump-to-latest button lifts by `reviewBannerH || ciBannerH` (no max() needed).
  let ciBannerH = $state(0);
  let reviewActive = $state(false);
  // In-flight-review dim signal, bound out of ReviewInFlightBanner: true ONLY while a review runs
  // off-screen (its PTY is separate, this session's PTY is idle). Drives the .term-mount dim so
  // the operator reads "Shepherd is working — hands off". False during addressing (agent works in
  // THIS PTY) and conclusion, so the terminal never dims while its own output is live.
  let reviewInFlight = $state(false);
  // Text stashed from an OSC 52 clipboard write that the browser refused (async writes need
  // a user gesture); the ClipboardPill offers a one-click retry that runs inside a real click.
  let pendingCopy = $state<string | null>(null);
  // true when another device took over this terminal — show a take-over prompt
  let parked = $state(false);
  // true once the connection stopped for good — show a recovery prompt. endReason
  // splits the two cases: "gone" = the agent exited (offer provider resume),
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
  // mirror the FitAddon too, so the live font-size effect can reflow (fit) the
  // terminal after changing fontSize without recreating it
  let fitRef = $state<FitAddon | undefined>();

  // Per-device terminal-font default — the SINGLE source of the 11/12.5 literal
  // (referenced by terminal creation, the remeasure metrics check, the live
  // font-size effect and the wrench-menu readout) so the three sites can't drift.
  const termFontDefault = $derived(mobile || touch ? 11 : 12.5);
  // Effective size for the wrench-menu UI (readout + A−/A+ bound gating) and the
  // step base: the pinned preference, or the per-device default ROUNDED to an
  // integer. Rounding here keeps the readout an integer — a fresh desktop user
  // never sees the fractional 12.5 (nor its overflow of the readout box) — and
  // lets stepping move a clean ±1 from the shown number. The ACTUAL xterm size
  // when unset stays the true termFontDefault (12.5/11) — see the creation +
  // live-apply effects — so default terminal rendering is unchanged; the ≤0.5px
  // gap exists only in the never-touched state and closes the moment the user
  // steps. Never feeds the terminal-creation effect.
  const effectiveFontSize = $derived(terminalFontSize.size ?? Math.round(termFontDefault));
  // A+ / A− step. Snaps to an integer (up → floor+1, down → ceil−1) so stepping
  // can never produce a fractional size; from the rounded default it is a clean
  // ±1 off the shown readout. Store clamps to [FONT_MIN, FONT_MAX].
  function stepTerminalFont(delta: number) {
    const base = terminalFontSize.size ?? Math.round(termFontDefault);
    const next = delta > 0 ? Math.floor(base) + 1 : Math.ceil(base) - 1;
    terminalFontSize.set(next);
  }

  // Installed slash-command names (lowercased) for the terminal link provider, which
  // linkifies command tokens Claude suggests in its output so a tap pastes them into
  // the prompt. Same authoritative source ComposeBar uses; lowercased so branch (A)
  // membership is case-insensitive. Stale-guarded against repoPath changing in flight.
  let knownCommands = $state<Set<string>>(new Set());
  $effect(() => {
    const rp = session.repoPath;
    if (!rp) {
      knownCommands = new Set();
      return;
    }
    getCommands(rp)
      .then((r) => {
        if (rp === session.repoPath)
          knownCommands = new Set(r.commands.map((c) => c.name.toLowerCase()));
      })
      .catch(() => {
        if (rp === session.repoPath) knownCommands = new Set();
      });
  });

  // Build a terminal line's visible text together with a string-index → 0-based column
  // map by walking cells, so a wide char (emoji/CJK: 2 columns but 1+ string chars)
  // before a token doesn't desync the link's tap region from the glyph. Mirrors xterm's
  // own translateToString (empty cell → " ", advance by the cell's width). `cell` is a
  // reusable scratch cell to avoid per-cell allocation.
  function lineTextWithColumns(
    line: IBufferLine,
    cell: IBufferCell,
  ): { text: string; colAt: number[] } {
    let text = "";
    const colAt: number[] = [];
    let col = 0;
    while (col < line.length) {
      const c = line.getCell(col, cell);
      const width = c?.getWidth() ?? 1;
      const chars = c?.getChars() || " ";
      for (let i = 0; i < chars.length; i++) colAt.push(col);
      text += chars;
      col += width || 1;
    }
    return { text, colAt };
  }

  /** Hand the keyboard to the live terminal — the page's Enter shortcut calls this
   *  so plain-key navigation (which deliberately keeps focus *out* of the PTY, see
   *  consumeAutoFocusTerm) has a way back in. Term tab only: focusing the hidden
   *  textarea of a display:none terminal would strand the keyboard invisibly. */
  export function focusTerminal() {
    if (tab === "term") termRef?.focus();
  }
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
  // Agent-owned top jumps move a remote TUI whose real position xterm cannot
  // observe. Until the user explicitly jumps back down (or the terminal resets),
  // do not let local wheel/touch bookkeeping claim we verified the bottom.
  let agentTopJumpNeedsExplicitBottom = false;
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
  // platform-correct modifier for the "force local selection" hint: xterm uses
  // Shift on Linux/Windows, Option (⌥) on macOS while the agent holds the mouse.
  // Guarded for SSR (no navigator) → renders the Shift glyph, corrects on hydrate.
  const isMac = $derived(
    typeof navigator !== "undefined" &&
      /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent),
  );

  // compact header: narrow mobile OR a touch device on the desktop layout (unfolded
  // foldables). Drops secondary fields + wraps so the trailing actions never clip.
  const compact = $derived(mobile || touch);
  // the fold only applies on the compact layout (it's the mobile space-saver);
  // desktop keeps its own git-actions disclosure untouched.
  const headerFolded = $derived(compact && headerCollapsed);

  // a parked (idle/done) session whose provider process is actually gone can be
  // brought back — surface a header Resume button so the user isn't stranded at a
  // bare shell with no affordance (the in-terminal overlay only shows once the PTY
  // closes for good). A verifiably-alive claude (server /proc sweep) hides it.
  const resumable = $derived(canResume(session, claudeAlive));
  const effectiveAgentProvider = $derived(
    session.agentProvider ??
      (session as Session & { launch?: { agent?: { provider?: Session["agentProvider"] } } }).launch
        ?.agent?.provider ??
      "claude",
  );
  // a11y: the fold button's aria-controls points at the tab switcher — the always-
  // mounted primary region it collapses (the git rail + build queue come and go with
  // the fold, so they can't carry a stable controlled-region id). Per-session id so
  // it stays unique if ever more than one viewport mounts.
  const foldRegionId = $derived(`vp-fold-region-${session.id}`);
  // a11y: tablist wiring — per-session ids so the tab buttons' aria-controls and the
  // panel's aria-labelledby resolve uniquely if more than one viewport ever mounts.
  const vpBodyId = $derived(`vp-panel-${session.id}`);
  const tabId = $derived((t: typeof tab) => `vp-tab-${t}-${session.id}`);

  function toggleFold() {
    // also a ViewportTabBar callback — callers that never pass through onTitleTap's
    // swallow guard, so reset the popover flags here too (holdOpen would leak a
    // bound capture listener; focusOpen a stuck-open popover).
    resetMeta();
    headerCollapsed = !headerCollapsed;
    // folding hides the tab switcher, so a non-terminal tab would be stranded with no
    // way back except unfolding — and its panel would keep filling the body, reclaiming
    // nothing. Land on the terminal (the view this fold exists to enlarge).
    if (headerCollapsed) tab = "term";
  }

  // phone merged header: the repo + session that used to live in the top bar
  const repoName = $derived(session.repoPath.split("/").filter(Boolean).at(-1) ?? "");
  const repoIcon = $derived(projectIcons.iconFor(session.repoPath));
  // phone: a configured project emoji identifies the repo on its own (mirrors the
  // herd cards), so the name is dropped to free header width — tapping the emoji
  // toggles it back for context. Reset when the viewport switches repos.
  let ctxRepoShown = $state(false);
  $effect(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- reactive dep
    session.repoPath;
    ctxRepoShown = false;
  });

  // alert-by-exception: a *saturated* tint fires only when the agent wants the
  // operator (blocked / done) so the tint stays a signal, not noise. The exact
  // status still reaches assistive tech via .vp-status-sr.
  const tintColor = $derived(
    mobile && (dStatus === "blocked" || dStatus === "done") ? STATUS_COLOR[dStatus] : null,
  );
  // The header background uses a per-theme wash token (--wash-blocked / -done)
  // rather than mixing the status colour inline: a 24% red→head srgb blend that
  // reads as a deep alarm bezel on the dark ground muddies into a dusty pink in
  // light, so the light theme retunes the blocked wash in OKLCH (see app.css).
  const tintWash = $derived(tintColor ? `var(--wash-${dStatus})` : null);
  // Non-hue partner to the tint: a leading shape mark so blocked (!) vs done (✓)
  // never rests on colour alone (WCAG 1.4.1) — mirrors the StatusPip glyphs. Same
  // blocked/done-on-phone gate as the tint, but opt-in (theme.colorblind): for
  // normal-sighted users the glyph just duplicates the tint and steals header
  // width, so it's hidden unless the colourblind marker preference is on.
  const statusGlyph = $derived(
    !tintColor || !theme.colorblind ? null : dStatus === "blocked" ? "!" : "✓",
  );
  // Desktop counterpart (.status-mark): one glyph per status, shape-coded so no
  // state pair rests on hue alone — done (✓) and idle/archived (●) both resolve
  // to slate. Word stays in title/aria.
  const STATUS_MARK: Record<SessionStatus, string> = {
    running: "⠿",
    blocked: "!",
    done: "✓",
    idle: "●",
    archived: "●",
  };
  const statusMark = $derived(STATUS_MARK[dStatus]);

  // ...but a busy agent shouldn't read as idle either: running gets a faint,
  // gently-pulsing amber edge (CSS .working) — ambient enough to distinguish
  // "churning" from "idle" at a glance without competing with the alert states.
  const working = $derived(mobile && dStatus === "running");

  // phone: the usage gauge only mounts once the hotter window runs hot (≥70%),
  // i.e. exactly when the remaining token budget starts to matter mid-session
  const hotGauge = $derived.by(() => {
    const h = hotterGauge(limits);
    return h && h.w.pct >= 70 ? h : null;
  });
  // Three-step ladder shared with TopBar (usage-gauges.ts): muted at rest, amber
  // 75–90 (warming), red >90 (approaching cap). Documented Four-Light exception —
  // bar-fill/text only (no halo/pip), blocked pip stays the loudest red on screen.

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

  const launch = $derived(session.launchMetadata ?? null);
  const launchSource = $derived(launch?.sourceKind ?? "legacy");
  const workBranchDisplay = $derived(
    launch?.branch.sharedCheckout
      ? m.tasktip_shared_checkout()
      : ((launch?.branch.workBranch ?? session.branch)?.replace(/^shepherd\//, "") ??
          m.tasktip_shared_checkout()),
  );
  const baseBranchDisplay = $derived(launch?.branch.baseBranch ?? session.baseBranch);
  const promptDisplay = $derived(launch?.prompt || session.prompt || m.tasktip_not_recorded());
  const issueDisplay = $derived(
    launch?.issue
      ? m.tasktip_issue_value({ number: launch.issue.number, title: launch.issue.title })
      : session.issueNumber != null
        ? m.tasktip_issue_number({ number: session.issueNumber })
        : launchSource === "legacy"
          ? m.tasktip_not_recorded()
          : m.tasktip_none(),
  );
  const launchedFiles = $derived(
    launch?.attachments.filter((a) => !a.dropped && a.launchedName).map((a) => a.launchedName!) ??
      null,
  );
  const droppedFiles = $derived(
    launch?.attachments.filter((a) => a.dropped).map((a) => a.submittedName) ?? [],
  );
  const filesDisplay = $derived(
    launchedFiles === null
      ? m.tasktip_not_recorded()
      : launchedFiles.length > 0
        ? launchedFiles.join(", ")
        : m.tasktip_none(),
  );
  const droppedFilesDisplay = $derived(droppedFiles.length > 0 ? droppedFiles.join(", ") : "");

  function checkboxDisplay(value: boolean | undefined): string {
    if (value === true) return m.tasktip_checked();
    if (value === false) return m.tasktip_unchecked();
    return launchSource === "generated" ? m.tasktip_generated() : m.tasktip_not_recorded();
  }
  const researchCheckboxDisplay = $derived(checkboxDisplay(launch?.uiState?.researchChecked));
  const planGateCheckboxDisplay = $derived(checkboxDisplay(launch?.uiState?.planGateChecked));
  const autopilotCheckboxDisplay = $derived(checkboxDisplay(launch?.uiState?.autopilotChecked));
  const planGateOptInDisplay = $derived(
    (launch?.resolvedLaunch.planGateOptIn ?? session.planGateEnabled ?? false)
      ? m.tasktip_on()
      : m.tasktip_off(),
  );
  const planGateCurrentDisplay = $derived(
    session.planPhase === "planning"
      ? m.tasktip_plan_gate_planning()
      : session.planPhase === "executing" && (launch?.resolvedLaunch.planGateOptIn ?? false)
        ? m.tasktip_plan_gate_released()
        : planGateOptInDisplay,
  );
  const researchLaunchedDisplay = $derived(
    (launch?.resolvedLaunch.research ?? session.research) ? m.tasktip_on() : m.tasktip_off(),
  );
  const autopilotOptInDisplay = $derived(
    (launch?.resolvedLaunch.autopilotOptIn ?? session.autopilotEnabled ?? false)
      ? m.tasktip_on()
      : m.tasktip_off(),
  );
  const autopilotStatusDisplay = $derived(
    session.planPhase === "planning"
      ? m.tasktip_autopilot_planning()
      : session.autopilotPaused
        ? m.session_autopilot_paused_label()
        : session.autopilotComplete
          ? m.session_autopilot_complete_label()
          : autopilotOptInDisplay,
  );
  const providerDisplay = $derived(
    (session.agentProvider ?? launch?.agent.provider ?? "claude") === "codex"
      ? m.agent_provider_codex()
      : m.agent_provider_claude(),
  );
  const submittedModelDisplay = $derived(
    launch
      ? launch.submittedChoices.model
        ? modelLabel(launch.submittedChoices.model)
        : m.newtask_model_default()
      : m.tasktip_not_recorded(),
  );
  const storedModelDisplay = $derived(
    (session.model ?? launch?.resolvedLaunch.storedModel)
      ? modelLabel((session.model ?? launch?.resolvedLaunch.storedModel)!)
      : m.newtask_model_default(),
  );
  const submittedEffortDisplay = $derived(
    launch
      ? launch.submittedChoices.effort
        ? effortLabel(launch.submittedChoices.effort)
        : m.effort_default()
      : m.tasktip_not_recorded(),
  );
  const storedEffortDisplay = $derived(
    (session.effort ?? launch?.resolvedLaunch.effort)
      ? effortLabel((session.effort ?? launch?.resolvedLaunch.effort)!)
      : m.effort_default(),
  );
  function sandboxDisplay(profile: string | null | undefined): string {
    if (profile === "autonomous") return m.session_sandbox_autonomous_label();
    if (profile === "standard") return m.session_sandbox_standard_label();
    if (profile === "trusted") return m.session_sandbox_unconfined_label();
    return m.tasktip_not_recorded();
  }
  const submittedSandboxDisplay = $derived(
    launch
      ? launch.submittedChoices.sandboxProfile
        ? sandboxDisplay(launch.submittedChoices.sandboxProfile)
        : m.tasktip_inherit()
      : m.tasktip_not_recorded(),
  );
  const spawnedSandboxDisplay = $derived(sandboxDisplay(session.sandboxApplied ?? null));
  const sandboxFlagsDisplay = $derived(
    [
      session.sandboxDegraded ? m.session_sandbox_degraded_label() : "",
      session.egressApplied ? m.tasktip_egress_applied() : "",
      session.egressDegraded ? m.session_sandbox_egress_degraded_label() : "",
    ]
      .filter(Boolean)
      .join(", "),
  );

  // The `session` prop is re-resolved from the store whenever the sessions
  // state changes, so its reference can churn while the id stays put. Derive
  // the id: a $derived only notifies dependents when its *value* changes, so
  // effects keyed on it re-run on an actual unit switch — not on churn.
  const unitId = $derived(session.id);

  // Live preview availability is purely server-driven: a non-null port means the
  // server bound a reverse-proxy listener for this session's dev server. Single
  // source of truth for both the tab and the pane — no iframe-load inference.
  const hasPreview = $derived(previewPort != null);
  // Build the iframe URL via the helper, which branches on loopback vs. split-front:
  // when previewHost is set (agent node's own tailnet host differs from the operator's
  // connection host), the URL targets previewHost directly so the iframe doesn't hit a
  // port that only exists on the agent node. Falls back to loc.hostname when null
  // (single-host deployment). SSR-guarded.
  const previewUrl = $derived(
    hasPreview && previewPort != null && typeof location !== "undefined"
      ? buildPreviewUrl(previewHost, location, previewPort)
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
    const stop = pollWhileVisible(load, 5000); // skip hidden-tab ticks; refresh on return
    return () => {
      alive = false;
      stop();
    };
  });

  // The To-Do tab only earns its place when the repo actually has a TODO.md — an
  // empty "add your first item" tab is just noise. Poll per-session (mirrors the
  // usage loop above) so the tab appears live when the agent writes TODO.md
  // mid-session and drops away if it's removed. null = not yet resolved → tab
  // stays hidden until we know.
  let todoExists = $state<boolean | null>(null);
  $effect(() => {
    const rp = session.repoPath;
    todoExists = null;
    let alive = true;
    const load = () =>
      getTodo(rp)
        .then((r) => alive && (todoExists = r.exists))
        .catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  });
  // Don't strand the operator on a To-Do tab that just vanished (TODO.md removed).
  $effect(() => {
    if (todoExists === false && tab === "todo") tab = "term";
  });

  // The Files tab is shown for any live session that has a claudeSessionId (#1258). This lets an
  // operator upload files even before the agent writes anything. hasScratchpadFiles is subsumed —
  // it can only be true for a live session with a claudeSessionId — so it no longer drives visibility.
  const hasFiles = $derived(session.claudeSessionId !== "" && session.status !== "archived");
  // Don't strand the operator on a Files tab whose scratchpad just emptied.
  $effect(() => {
    if (!hasFiles && tab === "files") tab = "term";
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
  const planGate = $derived(planGates.map[session.id]);
  // The git strip holds the Review-plan action during planning; flag the collapsed
  // desktop disclosure when the gate is in the stuck state the re-kick is FOR — a
  // latched REVIEW ERR — so the operator is cued to expand it and reach the button.
  // Scoped to "error" only: other planning states are surfaced by the PlanGateBadge
  // in the header without lighting a "needs you" hue on every planning session.
  // (During planning there is no PR, so prAttention/prClear are both false → no hue
  // conflict with the merge-readiness vocabulary; once a PR opens, planPhase is
  // "executing" so planAttention is false. The two are temporally disjoint.)
  const planAttention = $derived(
    session.planPhase === "planning" && planGate?.decision === "error",
  );
  // Localized status word folded into the toggle's title/aria so the hue isn't the only
  // signal — color-only status fails colorblind users and screen readers.
  const gitToggleState = $derived(
    prClear
      ? m.viewport_git_actions_state_clear()
      : prAttention || planAttention
        ? m.viewport_git_actions_state_attention()
        : "",
  );

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
  let decomTarget = $state<string | null>(null);
  $effect(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- touch reactive dep
    unitId; // on unit switch: disarm decommission + default back to terminal tab
    armed = false;
    leftovers = [];
    decomTarget = null; // drop any captured decommission target from the prior unit
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
  async function confirmDecommission(id: string) {
    // only interrupt the close with the dialog when something is actually still
    // running; a probe failure must never block decommission, so fall through to close.
    const found = await getLeftovers(id).catch(() => [] as Leftover[]);
    if (found.length === 0) {
      onarchive?.(id);
      return;
    }
    decomTarget = id;
    leftovers = found;
  }

  async function decommission() {
    if (!armed) {
      armed = true;
      clearTimeout(armTimer);
      armTimer = setTimeout(() => (armed = false), 3000);
      return;
    }
    clearTimeout(armTimer);
    armed = false;
    confirmDecommission(session.id);
  }

  // ── rename: ✎ click or title double-tap opens an inline editor; Enter/blur commits, Esc cancels ──
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
  let lastRenameRequestTick = -1;
  $effect(() => {
    if (
      renameRequest &&
      renameRequest.id === session.id &&
      renameRequest.tick !== lastRenameRequestTick
    ) {
      lastRenameRequestTick = renameRequest.tick;
      void startRename();
    }
  });
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
  // Double-tap / double-click on the session title opens the rename editor; a
  // lone tap toggles the disclosure — the git rail on desktop, the header fold
  // on compact (mobile + touch). Hand-rolled click timing instead of ondblclick
  // so touch and mouse behave identically (iOS Safari fires dblclick
  // unreliably). The timestamp is deliberately shared across the title
  // elements (desig + vp-name + ctx-trigger): they carry the same session
  // identity side by side, so a double-tap straddling them still reads as
  // "double-tap the title" and should rename.
  //
  // Timing: the single-tap toggle fires instantly so the common action stays
  // snappy; the double-tap that renames undoes the first tap's toggle, so the
  // disclosure returns to its pre-rename state and the only flash is on the
  // rare rename path. Synchronous — no timer, so nothing fires after the user
  // moves on. `toggleFold()` isn't a pure involution (it also forces
  // `tab = "term"` when it collapses, so a non-terminal tab isn't stranded),
  // so the compact undo can't just call it twice — it restores both
  // `headerCollapsed` and the pre-tap tab via `preFoldTab`.
  // 500ms matches the common OS double-click default (400 dropped slow double-clicks).
  const DOUBLE_TAP_MS = 500;
  let lastTitleTap = 0;
  // compact only: the tab shown before a first-tap fold, restored if the second
  // tap turns the gesture into a rename (so rename leaves the fold — and the
  // visible tab — exactly as the user left them). Deliberately a plain snapshot,
  // not a $derived: it's reassigned imperatively on every fold tap (see below),
  // not meant to track `tab` reactively.
  // svelte-ignore state_referenced_locally
  let preFoldTab: typeof tab = tab;
  function onTitleTap() {
    // A tap while the popover is held open is a dismissal, nothing else: swallow it
    // so it neither folds the header nor toggles the git rail nor starts a rename.
    // Reset lastTitleTap so this closing tap isn't read as the first half of a
    // double-tap (a double-tap over an open popover must not rename).
    if (holdOpen) {
      holdOpen = false;
      lastTitleTap = 0;
      return;
    }
    const now = Date.now();
    if (now - lastTitleTap < DOUBLE_TAP_MS) {
      lastTitleTap = 0;
      // undo the first tap's toggle → header back to its pre-tap state
      if (compact) {
        headerCollapsed = !headerCollapsed;
        tab = preFoldTab;
      } else {
        gitOpen = !gitOpen;
      }
      void startRename();
    } else {
      lastTitleTap = now;
      if (compact) {
        preFoldTab = tab;
        toggleFold();
      } else {
        gitOpen = !gitOpen;
      }
    }
  }
  function onTitleKey(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      void startRename();
    }
  }

  // ── task-info popover reveal ────────────────────────────────────────────────
  // The .desig-pop tooltip used to be revealed purely by CSS (:hover / :focus-
  // within), which both fire on a touch tap — so one tap popped the popover *and*
  // folded the header. The reveal is now driven from state, one flag per gesture,
  // and the CSS keys off .desig-wrap.meta-open instead.
  let hoverOpen = $state(false); // pointerenter/leave on .desig-wrap, non-touch only
  let focusOpen = $state(false); // focusin/out on the wrap, keyboard/AT-origin only
  let holdOpen = $state(false); // longPress toggle (touch only)
  const metaVisible = $derived(hoverOpen || focusOpen || holdOpen);
  // SSR-stable id for the aria-describedby span that advertises the affordance.
  const metaDescId = $props.id();

  // bind:this targets. desigWrapEl is bound on BOTH .desig-wrap branches (phone
  // .ctx + desktop) — miss the phone branch and insideTitle() returns false for
  // .ctx-trigger, so the closing re-tap would leak through and fold the header.
  // vpNameEl exists only on the desktop branch (.vp-name isn't rendered on phone),
  // so insideTitle() tolerates it being undefined via `?.`.
  let desigWrapEl = $state<HTMLElement | undefined>();
  let vpNameEl = $state<HTMLElement | undefined>();
  let renameFieldEl = $state<HTMLElement | undefined>();

  // .vp-name is a *sibling* of .desig-wrap, not a descendant, so the "inside the
  // title" region is a union — a containment test against .desig-wrap alone would
  // class the very .vp-name you long-pressed as outside. Widened to
  // EventTarget|Node|null because callers pass e.target / e.relatedTarget, never a
  // bare Node; Node.contains(null) === false is the behaviour we want.
  const insideTitle = (t: EventTarget | Node | null) =>
    t instanceof Node && (!!desigWrapEl?.contains(t) || !!vpNameEl?.contains(t));
  const insideRenameField = (t: EventTarget | Node | null) =>
    t instanceof Node && !!renameFieldEl?.contains(t);

  function resetMeta() {
    hoverOpen = false;
    focusOpen = false;
    holdOpen = false;
  }

  // Pointer-origin detection for focus, without a stranded flag. A touch that
  // yields focus must have lifted before longPress fired at 500ms (otherwise
  // touchend is preventDefault'd and no focus arrives), so pointerdown→focus is
  // bounded just above 500ms; mouse is ~1ms; AT focus has no preceding pointerdown
  // and ages out. Date.now() (NOT performance.now()) deliberately: it is mockable
  // via vi.setSystemTime, matches lastTitleTap's clock, and monotonicity is
  // irrelevant for a 600ms recency window. lastPointerType lets oncontextmenu on
  // the triggers suppress the native menu only for a real touch long-press, not for
  // a mouse right-click on a touchscreen laptop (the device `touch` prop can't tell
  // them apart).
  const POINTER_FOCUS_MS = 600; // > longPress's 500ms
  let lastPointerDownAt = -Infinity;
  let lastPointerType = "";
  $effect(() => {
    const onWinPointerDown = (e: PointerEvent) => {
      lastPointerDownAt = Date.now();
      lastPointerType = e.pointerType;
    };
    const onWinKeyDown = () => {
      lastPointerDownAt = -Infinity; // keyboard wins → any following focus opens
      lastPointerType = ""; // so the keyboard Menu key isn't suppressed
    };
    window.addEventListener("pointerdown", onWinPointerDown, { capture: true });
    window.addEventListener("keydown", onWinKeyDown, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", onWinPointerDown, { capture: true });
      window.removeEventListener("keydown", onWinKeyDown, { capture: true });
    };
  });

  // pointerenter/leave (NOT over/out — those bubble on descendant transitions, so
  // moving into the popover would close it). Early-return on touch: a touch never
  // fires pointerenter with pointerType "mouse" (its compat events are MouseEvents,
  // not PointerEvents), and a pen must still open (guard is !== "touch", not
  // === "mouse").
  function onWrapPointerEnter(e: PointerEvent) {
    if (e.pointerType === "touch") return;
    hoverOpen = true;
  }
  function onWrapPointerLeave(e: PointerEvent) {
    if (e.pointerType === "touch") return;
    hoverOpen = false;
  }

  // focusin/focusout on the WRAP, not focus/blur on the trigger: .desig-pop lives
  // inside .desig-wrap, so if AT (VoiceOver/TalkBack) moves DOM focus into the
  // popover to read it, focus/blur on .desig would collapse it mid-read. We diverge
  // from UnitRow's `:focus-visible` gate deliberately — UnitRow's tooltip is
  // decorative, ours is the only AT path to the launch details, and whether
  // :focus-visible matches AT-driven focus is UA-dependent. Instead we ask *where
  // the focus came from* (recent pointerdown ⇒ mouse/touch ⇒ suppress; otherwise
  // keyboard/AT ⇒ reveal). NEVER clear the origin on pointerup — on touch it
  // precedes the compat mousedown that delivers focus — and NEVER use a sticky
  // boolean: a held press preventDefault's touchend, so no focus ever arrives to
  // consume it and the flag would strand.
  function onWrapFocusIn(e: FocusEvent) {
    if (renaming || insideRenameField(e.target)) return;
    if (insideTitle(e.relatedTarget)) return; // moving within the title region
    const pointerDriven = Date.now() - lastPointerDownAt <= POINTER_FOCUS_MS;
    focusOpen = !pointerDriven;
  }
  function onWrapFocusOut(e: FocusEvent) {
    if (renaming || insideRenameField(e.target)) return;
    if (insideTitle(e.relatedTarget)) return; // focus staying within the wrap (AT read)
    focusOpen = false;
  }

  // longPress trigger (touch): open the popover (the close path is the onTitleTap
  // swallow on the next tap). Returns true so longPress preventDefault's the trailing
  // synthetic click, keeping the gesture clean.
  function openMeta() {
    holdOpen = true;
    return true;
  }
  // Android Chrome fires a native contextmenu on long-press (can cancel the timer);
  // suppress it only for a genuine touch press, read from the preceding pointerdown.
  function onTriggerContextMenu(e: Event) {
    if (lastPointerType === "touch") e.preventDefault();
  }

  // Reset all three flags on unit switch — a programmatic session switch would
  // otherwise carry the previous session's open popover onto the new title. Mirrors
  // the disarm-on-unit-switch effect below.
  $effect(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- reactive dep
    unitId;
    resetMeta();
  });
  // Reset on every renaming transition (entering *and* leaving the editor). Not
  // inside startRename(): it resets before its own await tick() → select(), which
  // then fires focusin and re-opens focusOpen; the $effect runs after the DOM
  // settles and also covers cancelRename()/commitRename(), which startRename()
  // never sees. Closes the "popover remounts stuck open after a rename commits"
  // hazard (Chrome doesn't reliably fire focusout on a removed element).
  $effect(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- reactive dep
    renaming;
    resetMeta();
  });

  // Dismissal — bound while metaVisible (not just holdOpen) so a keyboard user who
  // opened it via focusOpen can still Escape it. Escape clears only the *latches*
  // (focusOpen, holdOpen); hoverOpen is live cursor-tracking already cleared by the
  // pointerleave that ends the hover, and clearing it here would hide the popover
  // with the cursor still inside the wrap, dead until the pointer leaves and
  // re-enters. An outside pointerdown closes everything. (Scroll-to-close and
  // focus-restore from AddRepoMenu are deliberately skipped: .desig-pop is itself
  // overflow:auto and is never focused.)
  $effect(() => {
    if (!metaVisible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        focusOpen = false;
        holdOpen = false;
      }
    };
    const onDown = (e: PointerEvent) => {
      if (!insideTitle(e.target)) resetMeta();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, { capture: true });
    };
  });

  // ── stop preview ──────────────────────────────────────────────────────────
  // Per-session "stop in flight" guard: keyed by session id. The 15s timer fires
  // a warning toast if the sweep hasn't cleared the port yet (signals-sent ≠ dead).
  // Cleared on port-clear (via $effect), error/throw, or the 15s timeout. The entry
  // captures the session NAME at stop time so the success toast names the right unit
  // even if the operator has since navigated to a different session.
  const previewStopPending = new SvelteMap<
    string,
    { timer: ReturnType<typeof setTimeout>; name: string }
  >();
  // Teardown: clear all outstanding guard timers so they can't fire after unmount.
  $effect(() => () => {
    for (const { timer } of previewStopPending.values()) clearTimeout(timer);
  });
  // Two-step confirm for stop (always — stopping is destructive).
  let previewStopArmed = $state(false);
  let previewStopArmTimer: ReturnType<typeof setTimeout> | undefined;
  // Disarm on unit switch; clean up arm timer on unmount.
  $effect(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- reactive dep
    unitId;
    previewStopArmed = false;
    clearTimeout(previewStopArmTimer);
  });
  $effect(() => () => clearTimeout(previewStopArmTimer));

  function setStopPending(id: string, name: string) {
    clearStopPending(id); // clear any stale timer first
    const timer = setTimeout(() => {
      if (!previewStopPending.has(id)) return; // already resolved
      // If the port has actually cleared, this is a success the resolver will/just
      // handled — never warn on it. Otherwise the signals didn't take: warn.
      if (previewMap[id] == null) {
        clearStopPending(id);
        return;
      }
      clearStopPending(id);
      toasts.info(m.viewport_preview_stop_failed(), {
        alert: true,
        key: `preview-stop-warn-${id}`,
      });
    }, 15_000);
    previewStopPending.set(id, { timer, name });
  }

  function clearStopPending(id: string) {
    const entry = previewStopPending.get(id);
    if (entry !== undefined) clearTimeout(entry.timer);
    previewStopPending.delete(id);
  }

  const isPreviewStopPending = $derived(previewStopPending.has(unitId));

  // Success resolver: a stop is confirmed only when the session's port actually
  // clears in the authoritative store map (RAM freed) — NOT from the 200 response.
  // Keyed off `previewMap` (the whole store record), not the focused `previewPort`,
  // so a stop confirmed AFTER the operator navigates away still resolves the right
  // session (the captured name) instead of stranding its 15s timer into a false
  // "couldn't stop" warning. Resolved entries are removed first (clearStopPending),
  // so the success toast fires at most once per stop episode.
  $effect(() => {
    // Collect first (don't mutate the map mid-iteration), then resolve.
    const resolved: Array<{ id: string; name: string }> = [];
    for (const [id, { name }] of previewStopPending) {
      if (previewMap[id] == null) resolved.push({ id, name });
    }
    for (const { id, name } of resolved) {
      clearStopPending(id);
      toasts.info(m.viewport_preview_stopped({ name }));
    }
  });

  async function handleStopPreview() {
    let res;
    try {
      res = await apiStopPreview(session.id);
    } catch {
      toasts.info(m.viewport_preview_stop_failed(), {
        alert: true,
        key: `preview-stop-fail-${unitId}`,
      });
      return;
    }

    if ("notBound" in res) return; // benign race — preview already gone; pane clears on its own

    if (res.killed === 0) {
      toasts.info(m.viewport_preview_stop_nothing(), {
        alert: true,
        key: `preview-stop-warn-${unitId}`,
      });
      return;
    }

    // killed > 0: signals dispatched; wait for the sweep to clear the port.
    setStopPending(unitId, session.name);
    toasts.info(m.viewport_preview_stopping());
  }

  async function onStopPreviewClick() {
    if (isPreviewStopPending) return; // re-entrancy guard

    // Always two-step confirm: stopping kills the dev server (destructive).
    if (!previewStopArmed) {
      previewStopArmed = true;
      clearTimeout(previewStopArmTimer);
      previewStopArmTimer = setTimeout(() => (previewStopArmed = false), 3000);
      return;
    }
    clearTimeout(previewStopArmTimer);
    previewStopArmed = false;
    // Re-check pending at the moment of the confirming click.
    if (isPreviewStopPending) return;

    await handleStopPreview();
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

  function clearAgentScrollState() {
    scrollDepth = 0;
    contentBelowScroll = false;
    agentTopJumpNeedsExplicitBottom = false;
  }

  function trackAgentScrollDelta(deltaY: number) {
    scrollDepth = Math.max(0, scrollDepth - deltaY);
    if (agentTopJumpNeedsExplicitBottom) {
      scrollDepth = Math.max(scrollDepth, SCROLL_UP_PX + 1);
    }
  }

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
    clearAgentScrollState();
    scrolledUp = false;
  }

  function scrollToTop() {
    const term = termRef;
    if (!term) return;
    if (agentOwnsScroll(term)) {
      // Claude owns the visible scroll in fullscreen/mouse-tracking mode. Its
      // documented top shortcut is Ctrl+Home; PageUp spam is a defensive fallback
      // for renderer/terminal combinations that ignore that CSI variant.
      conn?.send("\x1b[1;5H" + "\x1b[5~".repeat(500));
      agentTopJumpNeedsExplicitBottom = true;
      scrollDepth = Math.max(scrollDepth, SCROLL_UP_PX + 1);
      contentBelowScroll = true;
      scrolledUp = true;
    } else {
      term.scrollToTop();
    }
  }

  // bring a finished session back: ask the server to respawn the provider resume in
  // the worktree, then bump the epoch so the terminal effect rebuilds and attaches
  // to the fresh agent (the old PtyConn stopped for good on the ended-close).
  // force=true (header button) tears down a surviving husk shell and respawns
  // the agent; force=false (the agent-gone overlay) just respawns into the empty tab.
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

  // ── redraw menu: squished-history repair variants under field test ──────────
  // Scrollback rendered while a narrow device owned the shared PTY is hard-
  // wrapped at that width forever (Claude Code writes real newlines). These four
  // variants are repair *candidates* — Kai + Patrick A/B them in the wild and the
  // losers get deleted, so keep each one self-contained and trivially removable.
  let redrawOpen = $state(false);
  // 1) Gentle: shrink the PTY by one column and restore it. Both SIGWINCHes make
  //    Claude Code repaint its visible screen at the (now correct) width. Safe
  //    while the agent is working; doesn't touch deep scrollback.
  function redrawNudge() {
    redrawOpen = false;
    const term = termRef;
    const c = conn;
    if (!term || !c) return;
    c.resize(Math.max(20, term.cols - 1), term.rows);
    // restore reads term.* at fire time, not call time: a real device resize
    // within the window already refit to fresh dims, and re-sending those is
    // deduped server-side — whereas restoring captured dims would be stale.
    setTimeout(() => c.resize(term.cols, term.rows), 150);
  }
  // 2) Medium: rebuild the terminal + fresh herdr attach (takeover) at the
  //    current size — same path as the herdr-unreachable recovery.
  function redrawReattach() {
    redrawOpen = false;
    reattach();
  }
  // 3) Claude-side: switch Claude Code to its alternate-screen renderer, which
  //    owns its scrollback and re-renders from its own message model instead of
  //    printing into ours. Sent as an atomic bracketed paste + Enter (same byte
  //    path as the mobile compose bar) so the slash-command autocomplete can't
  //    intercept mid-typing.
  function redrawFullscreen() {
    redrawOpen = false;
    conn?.send(composeKeystrokes("/tui fullscreen"));
  }
  // 4) Heavy: force a fresh provider resume — re-renders the FULL conversation
  //    at the current width, but aborts an in-flight turn (hence last + hinted).
  function redrawResume() {
    redrawOpen = false;
    void resumeSession(true);
  }

  // Self-heal when the session is resumed from OUTSIDE this terminal — e.g. the
  // card context-menu Resume on the already-open session, where this Viewport's
  // own resume path never runs. That respawns the agent server-side and flips the
  // session back to `running`, but leaves us parked on the stale ended overlay. So
  // while we're ended and not mid-resume ourselves, a transition to `running` means
  // a fresh agent is up: drop the overlay and rebuild the terminal to re-attach.
  //
  // Gated on endReason === "gone" (the agent exited; herdr — and so the events WS —
  // is still up, so `session.status` is live and trustworthy). The "unreachable"
  // case (herdr down) is deliberately excluded: its events WS is down too, so status
  // freezes at a stale "running", and acting on it would rebuild/reattach-loop every
  // fast-fail cycle and defeat the dedicated Reconnect overlay. Also gated on `ended`
  // so a normal idle→running turn never rebuilds a live terminal, and on `!resuming`
  // so our own resume path doesn't double-bump the epoch. Raw status by design:
  // a working-while-blocked display upgrade must never trigger a terminal rebuild.
  $effect(() => {
    if (ended && endReason === "gone" && !resuming && session.status === "running") {
      ended = false;
      resumeEpoch++;
    }
  });

  $effect(() => {
    const id = unitId;
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- reactive dep
    resumeEpoch; // a resume bumps this → rebuild the terminal + re-attach to the new agent
    if (!el) return;
    parked = false; // fresh attach for this unit
    scrolledUp = false; // fresh terminal starts pinned to the bottom
    clearAgentScrollState();
    notesKey = null; // no prompt scraped yet on this fresh terminal

    // initial palette: non-reactive DOM read so this effect doesn't depend on
    // theme.resolved (which would recreate the whole terminal — and its PTY —
    // on every theme switch). Live updates are handled by the effect below.
    const initialTheme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    // Initial font size: the persisted preference (read UNTRACKED so a later
    // wrench-menu step never re-keys this effect → never recreates the terminal /
    // PTY), else the per-device default. Live changes are applied in place by the
    // dedicated effect below.
    const initialFont = untrack(() => terminalFontSize.size) ?? termFontDefault;
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: initialFont,
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
    fitRef = fit;
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

    // WebGL renderer. The default DOM renderer flows text with a per-glyph
    // letter-spacing derived from a fractional cell width; at a non-integer
    // fontSize (12.5) on a HiDPI display (devicePixelRatio 2) xterm's glyph
    // measurement and its computed cell width disagree by half a device pixel,
    // so the rendered text drifts ~0.25px/char off the hit-test grid and the
    // selection lands a few characters short by the end of a long line. The
    // WebGL renderer rasterizes each glyph into its exact grid cell (no flowed
    // text, no letter-spacing), so text, the selection overlay and mouse
    // hit-testing all share one grid. Loaded after open() as the addon requires.
    // Guarded: if WebGL is unavailable (context creation throws, or is lost and
    // unrecoverable) we dispose it and fall back to the DOM renderer rather than
    // leaving the terminal blank.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch (err) {
      console.warn("webgl renderer unavailable; using DOM renderer", err);
    }

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
      // recovery prompt. "gone" → agent exited (status badge already flipped to
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
    term.onData((d) => {
      opKeystrokes++;
      c.send(d);
    });

    // Linkify slash-command tokens Claude suggests in its output (e.g. "/squad",
    // "/gsd-quick") so a tap pastes the command into the prompt — on a phone the
    // command text is otherwise un-actionable inside xterm's canvas. Same link layer
    // as the URL WebLinksAddon above; recognizer is in slashLinks.ts. The paste omits
    // a trailing CR (composeKeystrokes would submit) so the user reviews and presses
    // Enter themselves. No preventDefault/focus here: the el click→onTap→term.focus()
    // listener below already focuses the terminal on the same tap. Disposed implicitly
    // by term.dispose() in teardown, like the WebLinksAddon.
    const linkCell = term.buffer.active.getNullCell();
    term.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        const line = term.buffer.active.getLine(bufferLineNumber - 1);
        if (!line) {
          callback(undefined);
          return;
        }
        const { text, colAt } = lineTextWithColumns(line, linkCell);
        const found = findCommandLinks(text, knownCommands);
        if (found.length === 0) {
          callback(undefined);
          return;
        }
        callback(
          found.map((f) => ({
            text: `/${f.name}`,
            // Map string indices → 1-based terminal columns via colAt so a wide char
            // before the token doesn't shift the tap region; range end is the inclusive
            // last cell of the token.
            range: {
              start: { x: colAt[f.start]! + 1, y: bufferLineNumber },
              end: { x: colAt[f.end - 1]! + 1, y: bufferLineNumber },
            },
            activate: () => {
              c.send(`\x1b[200~/${f.name}\x1b[201~`);
            },
          })),
        );
      },
    });

    // Claude's `c to copy` emits OSC 52 (ESC]52;c;<base64>). xterm has no built-in handler, so
    // forward the decoded text to the browser clipboard. The bytes arrive async over the WS
    // (not inside the `c` keydown), so navigator.clipboard.writeText may be refused
    // (NotAllowedError / unfocused tab); on ANY failure, stash the text and surface the
    // ClipboardPill for a one-click, in-gesture retry. handleOsc52 already refuses `?` reads and
    // caps size (via parseOsc52), and claims every outcome so a write can never vanish silently.
    // We claim OSC 52 entirely (return true).
    const osc52Sub = term.parser.registerOscHandler(52, (data) => {
      handleOsc52(data, {
        writeText: (t) => navigator.clipboard?.writeText(t),
        onCopied: () => toasts.info(m.clipboard_copied_toast()),
        onPending: (text) => (pendingCopy = text),
      });
      return true;
    });

    // Fit + push the size to the PTY — but only while the mount is actually
    // visible. A hidden (To-Do tab → display:none) or mid-layout mount
    // has zero width, where FitAddon clamps to its 2-col minimum; resizing the
    // PTY to 2 cols makes Claude reflow its transcript at 2 cols and permanently
    // poisons the scrollback with 2-char-wide wrapping. offsetParent===null
    // catches display:none; the client-size checks catch transient collapses.
    const refit = () => {
      if (!el || el.offsetParent === null || el.clientWidth === 0 || el.clientHeight === 0) return;
      fit.fit();
      c.resize(term.cols, term.rows);
    };

    // Selection-offset fix. xterm measures the character cell exactly once (in its
    // CharSizeService) and maps mouse coords → (row, col) with that width, but it
    // only re-measures on becoming visible when the prior size was *invalid*
    // (width 0) and never on web-font load. Two conditions leave a *valid but
    // wrong* measurement that drifts the selection by a few characters for the
    // terminal's whole life: the mount was `display:none` at open (a non-term
    // initial tab — the effect opens xterm regardless of the active tab), or
    // 'JetBrains Mono' hadn't finished loading (async Google font, `display=swap`)
    // when it was measured under the fallback metrics. Changing `fontFamily`
    // forces CharSizeService to re-measure (it watches ["fontFamily","fontSize"]),
    // so toggle it off/on once — the first moment the mount is both visible and
    // the font is loaded — then refit to the corrected cell size. Latched so it
    // runs at most once and never in the common warm case (term tab active + font
    // cached at open), where the original measurement was already correct.
    let disposed = false;
    const remeasureFont = `${initialFont}px 'JetBrains Mono'`;
    let metricsFixed = el.offsetParent !== null && (document.fonts?.check(remeasureFont) ?? true);
    const remeasure = () => {
      if (metricsFixed || disposed || !el || el.offsetParent === null) return; // needs visible
      if (document.fonts && !document.fonts.check(remeasureFont)) return; // needs font loaded
      term.options.fontFamily = "monospace"; // OptionsService dedupes equal values, so
      term.options.fontFamily = "'JetBrains Mono', monospace"; // toggle → CharSizeService.measure()
      refit();
      metricsFixed = true;
    };
    // Font resolves while the terminal is already visible → re-measure then.
    if (!metricsFixed) document.fonts?.ready.then(remeasure);

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
      // Alt+J/K/G/arrows/1-9 + Alt+Tab/Alt+Shift+Tab + Alt+]/Alt+[: session-switch
      // combos must work *while the terminal owns the keyboard* — that's the whole
      // point of the modifier. Suppress them from the PTY here (altComboKey is the
      // same code→key map the window shortcut handler acts on, so the two sides
      // can't drift). This branch is Shift-agnostic, so BOTH Alt+Tab and
      // Alt+Shift+Tab are suppressed (their direction is resolved window-side, not
      // here). Like Shift+Enter
      // above, returning false alone only stops xterm's own keydown handling — the
      // browser's follow-up keypress would still make xterm emit the Meta/ESC-
      // prefixed bytes — so e.preventDefault() is required for NO bytes to reach
      // the agent. preventDefault does not stop propagation: the keydown still
      // bubbles to the window, where +page.svelte's onShortcut performs the
      // actual switch. keydown-only; the keyup is inert for these combos.
      if (
        e.type === "keydown" &&
        e.altKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        altComboKey(e.code) !== null
      ) {
        e.preventDefault();
        return false;
      }
      // Cmd/Ctrl+K: opens the command bar (#1334). xterm would otherwise forward the
      // control byte 0x0B (Ctrl+K = kill-line) to the agent. preventDefault stops that
      // byte; returning false stops xterm's own handling. preventDefault does NOT stop
      // propagation, so the keydown still bubbles to the window, where +page.svelte's
      // onShortcut opens the bar — same split as the Alt combos above.
      if (e.type === "keydown" && isCommandBarChord(e)) {
        e.preventDefault();
        return false;
      }
      // Ctrl+Shift+C: explicit copy. Ctrl+C in a focused terminal sends SIGINT to
      // the agent rather than copying; this gives users an explicit copy shortcut.
      // Read the selection before returning false — xterm hasn't cleared it yet.
      if (e.type === "keydown" && e.ctrlKey && e.shiftKey && (e.key === "C" || e.key === "c")) {
        const sel = trimTrailingWhitespace(term.getSelection());
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
      const sel = trimTrailingWhitespace(term.getSelection());
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

    // Native copy (macOS Cmd+C, right-click → Copy, Ctrl+Insert) bypasses the two
    // programmatic copy paths above: xterm binds its own `copy` handler (bubble
    // phase, on its terminal element — a descendant of `el`) that writes the raw,
    // untrimmed selection to the clipboard. Intercept in the capture phase on `el`
    // so we run first, write the trimmed text, and stopImmediatePropagation() to
    // keep xterm's handler from overwriting it. No selection → fall through.
    const onCopy = (e: ClipboardEvent) => {
      const sel = trimTrailingWhitespace(term.getSelection());
      if (!sel) return;
      e.clipboardData?.setData("text/plain", sel);
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    el.addEventListener("copy", onCopy, true);

    // Claude Code runs as a full-screen TUI with mouse tracking on (it stays on
    // the normal buffer, keeping scrollback, but grabs the wheel): scrolling
    // means sending wheel input to the app, which is what the mouse wheel does on
    // desktop. Touch emits no wheel events, so translate one-finger drags into
    // wheel events on xterm's screen — xterm then forwards them per the active
    // mode (to the app when mouse-tracking, otherwise its own scrollback).
    // Matches desktop in both.
    // One-finger drag → synthetic wheel, now with flick momentum: releasing
    // mid-scroll coasts to a stop instead of dead-stopping, which is what makes
    // native mobile scrolling feel fluid. We track the drag velocity, then decay
    // it across rAF frames after touchend, dispatching the same wheels the live
    // drag does.
    let lastY: number | null = null;
    let lastMoveT = 0;
    let flingV = 0; // px/ms, sign matches dy (the drag delta)
    let flingRAF = 0;
    // recent move samples (timestamp + clientY) for a windowed release-velocity
    // read: a hard flick's finger decelerates in its final frame as it lifts, so
    // measuring over a short trailing window (not just the last sample) keeps a
    // fast swipe reading fast — and a slow drag-release reading near-zero.
    const VELOCITY_WINDOW_MS = 90;
    let trail: { t: number; y: number }[] = [];
    const FLING_MIN_V = 0.03; // px/ms — below this the coast has effectively stopped
    const FLING_MAX_V = 6; // px/ms — clamp a freak velocity read so a flick can't rocket
    const FLING_DECAY = 0.96; // velocity retained per 16ms frame (higher = coasts longer)
    const FLING_STALE_MS = 60; // a release this long after the last move = held still, no coast
    const stopFling = () => {
      if (flingRAF) cancelAnimationFrame(flingRAF);
      flingRAF = 0;
    };
    // apply a wheel delta the way a live drag does: in the agent-owned regime
    // xterm's viewport never moves (onScroll won't fire), so track the gesture
    // depth directly (dy<0 = scrolling up → grow it); then refresh the
    // jump-to-bottom affordance and forward the wheel to xterm's screen.
    const dispatchScroll = (dy: number) => {
      if (agentOwnsScroll(term)) {
        trackAgentScrollDelta(dy);
      }
      recomputeScrolled();
      const target = el!.querySelector<HTMLElement>(".xterm-screen") ?? el!;
      target.dispatchEvent(
        new WheelEvent("wheel", { deltaY: dy, deltaMode: 0, bubbles: true, cancelable: true }),
      );
    };
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      stopFling(); // a fresh touch catches the coast, like grabbing a moving page
      lastY = e.touches[0].clientY;
      lastMoveT = performance.now();
      flingV = 0;
      trail = [{ t: lastMoveT, y: lastY }];
      dragged = false;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (lastY === null || e.touches.length !== 1) return;
      const y = e.touches[0].clientY;
      const dy = lastY - y; // drag down → wheel up (reveal older), natural scroll
      lastY = y;
      const now = performance.now();
      lastMoveT = now;
      // keep a short trail of samples inside the velocity window; the release
      // velocity is read from this span, not a single (possibly stuttery) frame.
      trail.push({ t: now, y });
      while (trail.length > 2 && now - trail[0].t > VELOCITY_WINDOW_MS) trail.shift();
      if (Math.abs(dy) > 2) dragged = true;
      dispatchScroll(dy);
      e.preventDefault();
    };
    const onTouchEnd = () => {
      lastY = null;
      // release velocity over the recent window (px/ms, dy-sign): content moved
      // (head.y − tail.y) across the window's time span. A windowed read makes a
      // fast flick coast proportionally further while a slow release barely
      // coasts — and one decelerating final frame can't under-read the swipe.
      const head = trail[0];
      const tail = trail[trail.length - 1];
      const span = head && tail ? tail.t - head.t : 0;
      flingV = span > 0 ? (head.y - tail.y) / span : 0;
      flingV = Math.max(-FLING_MAX_V, Math.min(FLING_MAX_V, flingV));
      trail = [];
      // coast on release only if the finger was still moving with intent: a
      // pause before lifting stops touchmove from firing, leaving stale velocity
      // behind, so a long gap since the last move means "held still" → no coast.
      if (Math.abs(flingV) < FLING_MIN_V || performance.now() - lastMoveT > FLING_STALE_MS) return;
      let prev = performance.now();
      const step = (t: number) => {
        const dt = t - prev;
        prev = t;
        flingV *= Math.pow(FLING_DECAY, dt / 16);
        if (Math.abs(flingV) < FLING_MIN_V) {
          flingRAF = 0;
          return;
        }
        dispatchScroll(flingV * dt);
        // coasting toward the latest output and we've hit it → nothing more to
        // reveal, so stop pushing scroll into the agent.
        if (agentOwnsScroll(term) && flingV > 0 && scrollDepth === 0) {
          flingRAF = 0;
          return;
        }
        flingRAF = requestAnimationFrame(step);
      };
      flingRAF = requestAnimationFrame(step);
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
      // doesn't pop open on every selection. consumeAutoFocusTerm gates this:
      // a plain j/k keynav switch declines the focus (so the next plain key
      // still chains instead of vanishing into the PTY). The consume comes
      // FIRST so every rebuild — any layout, any active tab — consumes the
      // one-shot: a stale `false` can't survive into a later resumeEpoch-driven
      // rebuild (resume / re-attach must auto-focus exactly as before), and a
      // coarse-pointer desktop-width device (where onShortcut still runs — its
      // bail is width-based) can't park one either. The layout/tab guards only
      // decide whether the consumed intent results in a focus. Read inside the
      // rAF callback (like mobile/touch/tab) — async, so no new tracked dep on
      // this terminal effect; the consumed flag itself is a plain non-reactive
      // let upstairs.
      if (consumeAutoFocusTerm() && !mobile && !touch && tab === "term") term.focus();
    });

    const ro = new ResizeObserver(() => {
      // fires on the display:none → visible flip when the term tab is shown, which
      // is where a mount that opened hidden finally gets a valid size → re-measure
      remeasure();
      refit();
    });
    ro.observe(el);

    // track scroll position so we can offer a jump-to-bottom button. The two
    // regimes (gesture accumulator vs. xterm viewport offset) and why content
    // arrival matters are documented in `isScrolledAwayFromBottom`.
    const recomputeScrolled = () => {
      const b = term.buffer.active;
      if (scrollDepth === 0) contentBelowScroll = false; // verified bottom → re-arm
      scrolledUp = isScrolledAwayFromBottom({
        agentOwnsScroll: agentOwnsScroll(term),
        scrollDepth,
        contentBelowScroll,
        viewportOffsetLines: b.baseY - b.viewportY,
      });
    };
    const scrollSub = term.onScroll(recomputeScrolled);
    const bufSub = term.buffer.onBufferChange(() => {
      clearAgentScrollState();
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
      trackAgentScrollDelta(e.deltaY);
      recomputeScrolled();
    };
    el.addEventListener("wheel", onWheelTrack, { passive: true, capture: true });

    return () => {
      disposed = true; // stops a pending document.fonts.ready remeasure after teardown
      window.removeEventListener("keydown", onWindowKeydown, true);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onPageShow);
      el?.removeEventListener("click", onTap);
      el?.removeEventListener("mousedown", onTermMouseDown, true);
      document.removeEventListener("mouseup", onDocMouseUp);
      el?.removeEventListener("paste", onPaste, true);
      el?.removeEventListener("copy", onCopy, true);
      el?.removeEventListener("touchstart", onTouchStart);
      el?.removeEventListener("touchmove", onTouchMove);
      el?.removeEventListener("touchend", onTouchEnd);
      el?.removeEventListener("wheel", onWheelTrack, { capture: true });
      stopFling();
      scrollSub.dispose();
      bufSub.dispose();
      writeSub.dispose();
      renderSub.dispose();
      osc52Sub.dispose();
      ro.disconnect();
      c.close();
      conn = undefined;
      termRef = undefined;
      fitRef = undefined;
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

  // Live-apply the terminal font size (wrench-menu stepper). Mirrors the theme
  // effect: mutate the option in place — never recreate the terminal/PTY.
  // Setting term.options.fontSize makes xterm's CharSizeService re-measure the
  // cell (it watches fontSize), but ONLY when the mount is visible; a hidden
  // measure is invalid. If the mount is hidden we store the option and return
  // before fit.fit() (the same 2-col poison guard as refit()) — but the deferred
  // visibility/ResizeObserver refit() calls fit.fit() alone, which does NOT
  // re-trigger a CharSizeService measure, so it would reflow against stale cell
  // metrics. We rely on the invariant that the ONLY font-size trigger is the
  // wrench menu, which renders on the terminal tab only → the mount is always
  // visible at change time, so this hidden branch is effectively unreachable for
  // user-driven changes.
  $effect(() => {
    const size = terminalFontSize.size ?? termFontDefault;
    const term = termRef;
    const fit = fitRef;
    if (!term || !fit) return;
    if (term.options.fontSize === size) return;
    term.options.fontSize = size;
    if (!el || el.offsetParent === null || el.clientWidth === 0 || el.clientHeight === 0) return;
    fit.fit();
    conn?.resize(term.cols, term.rows);
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
      const t = e.target as Element | null;
      // Allow-list: page only from the terminal/panel body (`.vp-body`, tagged
      // data-swipe-page). The surrounding chrome — header + tabs, the
      // PR/automations strip, the build-queue panel, the steer + control bars, and
      // any popover anchored to them — sits outside `.vp-body`, so it's excluded by
      // omission (no per-container tagging, and new chrome is excluded automatically).
      if (!t?.closest("[data-swipe-page]")) return;
      // Within-body refinement: don't hijack text selection / cursor placement in
      // editable fields that can appear inside a panel. [data-swipe-ignore] is a
      // forward-compat opt-out for any FUTURE surface placed inside the body (e.g. a
      // horizontally-scrollable panel) — today's markers (steer/control bars) live
      // outside `.vp-body` and are already excluded by the allow-gate above.
      if (t.closest("input, textarea, [contenteditable], [data-swipe-ignore]")) return;
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
  class:phone={mobile}
  bind:this={viewportEl}
  style:transform={swipeX ? `translateX(${swipeX}px)` : undefined}
>
  {#snippet metaPop()}
    <span class="desig-pop" role="tooltip">
      <span class="dp-row">
        <span class="dp-k">{m.tasktip_prompt()}</span>
        <span class="dp-v">{promptDisplay}</span>
      </span>
      <span class="dp-row">
        <span class="dp-k">{m.tasktip_issue()}</span>
        <span class="dp-v">{issueDisplay}</span>
      </span>
      <span class="dp-row">
        <span class="dp-k">{m.tasktip_files()}</span>
        <span class="dp-v">{filesDisplay}</span>
      </span>
      {#if droppedFilesDisplay}
        <span class="dp-row">
          <span class="dp-k">{m.tasktip_dropped_files()}</span>
          <span class="dp-v">{droppedFilesDisplay}</span>
        </span>
      {/if}
      <span class="dp-row">
        <span class="dp-k">{m.tasktip_base_branch()}</span>
        <span class="dp-v">{baseBranchDisplay}</span>
      </span>
      <span class="dp-row">
        <span class="dp-k">{m.tasktip_work_branch()}</span>
        <span class="dp-v">{workBranchDisplay}</span>
      </span>
      <span class="dp-section">{m.tasktip_launch_state()}</span>
      <span class="dp-row">
        <span class="dp-k">{m.tasktip_research_checkbox()}</span>
        <span class="dp-v">{researchCheckboxDisplay}</span>
      </span>
      <span class="dp-row">
        <span class="dp-k">{m.tasktip_research_launched()}</span>
        <span class="dp-v">{researchLaunchedDisplay}</span>
      </span>
      <span class="dp-row">
        <span class="dp-k">{m.tasktip_plan_gate_checkbox()}</span>
        <span class="dp-v">{planGateCheckboxDisplay}</span>
      </span>
      <span class="dp-row">
        <span class="dp-k">{m.tasktip_plan_gate_optin()}</span>
        <span class="dp-v">{planGateOptInDisplay}</span>
      </span>
      <span class="dp-row">
        <span class="dp-k">{m.tasktip_plan_gate_current()}</span>
        <span class="dp-v">{planGateCurrentDisplay}</span>
      </span>
      <span class="dp-row">
        <span class="dp-k">{m.tasktip_autopilot_checkbox()}</span>
        <span class="dp-v">{autopilotCheckboxDisplay}</span>
      </span>
      <span class="dp-row">
        <span class="dp-k">{m.tasktip_autopilot_optin()}</span>
        <span class="dp-v">{autopilotOptInDisplay}</span>
      </span>
      <span class="dp-row">
        <span class="dp-k">{m.tasktip_autopilot_status()}</span>
        <span class="dp-v">{autopilotStatusDisplay}</span>
      </span>
      <span class="dp-section">{m.tasktip_runtime()}</span>
      <span class="dp-row">
        <span class="dp-k">{m.tasktip_cli()}</span>
        <span class="dp-v">{providerDisplay}</span>
      </span>
      <span class="dp-row">
        <span class="dp-k">{m.tasktip_model_submitted()}</span>
        <span class="dp-v">{submittedModelDisplay}</span>
      </span>
      <span class="dp-row">
        <span class="dp-k">{m.tasktip_model_stored()}</span>
        <span class="dp-v">{storedModelDisplay}</span>
      </span>
      <span class="dp-row">
        <span class="dp-k">{m.tasktip_effort_submitted()}</span>
        <span class="dp-v">{submittedEffortDisplay}</span>
      </span>
      <span class="dp-row">
        <span class="dp-k">{m.tasktip_effort_stored()}</span>
        <span class="dp-v">{storedEffortDisplay}</span>
      </span>
      <span class="dp-row">
        <span class="dp-k">{m.tasktip_sandbox_submitted()}</span>
        <span class="dp-v">{submittedSandboxDisplay}</span>
      </span>
      <span class="dp-row">
        <span class="dp-k">{m.tasktip_sandbox_spawned()}</span>
        <span class="dp-v">{spawnedSandboxDisplay}</span>
      </span>
      <span class="dp-row">
        <span class="dp-k">{m.tasktip_sandbox_flags()}</span>
        <span class="dp-v">{sandboxFlagsDisplay || m.tasktip_none()}</span>
      </span>
      {#if usage && usage.total > 0}
        <span class="dp-section">{m.tasktip_usage()}</span>
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
  <!-- rename is a double-tap/dblclick on the title itself: the input takes the
       title's own slot in place (see desig/ctx-name below), so there is no
       separate field or pencil button. -->
  {#snippet renameField()}
    <span class="rename-edit" bind:this={renameFieldEl}>
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
      <!-- explicit cancel/confirm — handled on pointerdown (with preventDefault)
           so they act BEFORE the input's blur-commits-automatically fires; a
           plain onclick would always lose to the blur and ✕ could never cancel.
           tabindex=-1: tabbing out of the input already commits and unmounts
           these, so a tab stop here would be dead — Enter/Esc are the keyboard
           path. The onclick handlers are NOT dead code: assistive-tech
           activation (VoiceOver/TalkBack, voice control) dispatches a synthetic
           click without real pointer events, so onclick is that path. Both
           actions are idempotent, so a real pointer firing pointerdown + click
           is harmless (cancel unmounts the buttons; commit re-entry is guarded
           by renaming/renameSaving). -->
      <button
        class="rename-btn cancel"
        type="button"
        tabindex="-1"
        disabled={renameSaving}
        aria-label={m.viewport_rename_cancel_aria()}
        onpointerdown={(e) => {
          e.preventDefault();
          cancelRename();
        }}
        onclick={cancelRename}>✕</button
      >
      <button
        class="rename-btn ok"
        type="button"
        tabindex="-1"
        disabled={renameSaving}
        aria-label={m.viewport_rename_confirm_aria()}
        onpointerdown={(e) => {
          e.preventDefault();
          void commitRename();
        }}
        onclick={() => void commitRename()}>✓</button
      >
      {#if renameError}<span class="rename-err" title={renameError}>{renameError}</span>{/if}
    </span>
  {/snippet}
  {#snippet renameNoteEl()}
    {#if renameNote}<span class="rename-note">{renameNote}</span>{/if}
  {/snippet}
  <!-- header -->
  <div
    class="vp-head"
    class:mobile={compact}
    class:phone={mobile}
    class:renaming
    class:working={working && !tintColor}
    style:background={tintWash ?? undefined}
  >
    {#if onback}
      <button class="back" type="button" onclick={onback} aria-label={m.viewport_back_aria()}
        >{mobile ? "☰" : m.viewport_back_button()}</button
      >
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
      {#if repoIcon}
        <!-- emoji stands in for the repo name (herd-card convention) to free
             header width; tapping it toggles the name back in. Lives outside the
             .desig-wrap so focusing it doesn't also pop the meta tooltip. -->
        <span
          class="ctx-glyph emoji actionable"
          role="button"
          tabindex="0"
          aria-expanded={ctxRepoShown}
          aria-label={m.viewport_ctx_repo_toggle_aria({ repo: repoName })}
          onclick={(e) => {
            e.stopPropagation();
            ctxRepoShown = !ctxRepoShown;
          }}
          onkeydown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              ctxRepoShown = !ctxRepoShown;
            }
          }}>{repoIcon}</span
        >
      {/if}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <!-- the wrap is a non-interactive container; the pointer/focus handlers only
           track hover/focus state to reveal the popover. The interactive trigger
           (.ctx-trigger, role="button") lives inside it. -->
      <span
        class="desig-wrap ctx"
        class:editing={renaming}
        class:meta-open={metaVisible}
        class:hovering={hoverOpen}
        bind:this={desigWrapEl}
        onpointerenter={onWrapPointerEnter}
        onpointerleave={onWrapPointerLeave}
        onfocusin={onWrapFocusIn}
        onfocusout={onWrapFocusOut}
      >
        {#if renaming}
          {@render renameField()}
        {:else}
          <span
            class="ctx-trigger"
            role="button"
            tabindex="0"
            aria-label={`${m.topbar_detail_context_aria({ repo: repoName, name: session.name })} — ${m.viewport_title_enter_renames()}`}
            aria-describedby={metaDescId}
            onclick={onTitleTap}
            onkeydown={onTitleKey}
            oncontextmenu={onTriggerContextMenu}
            use:longPress={{ onTrigger: openMeta }}
          >
            {#if !repoIcon}
              <span class="ctx-glyph" aria-hidden="true">▣</span>
            {/if}
            {#if !repoIcon || ctxRepoShown}
              <span class="ctx-repo">{repoName}</span>
              <span class="ctx-sep">·</span>
            {/if}
            <span class="ctx-name">{session.name}</span>
          </span>
          {@render metaPop()}
        {/if}
        <span class="vp-meta-sr" id={metaDescId}>{m.viewport_meta_desc()}</span>
      </span>
    {:else}
      <!-- TASK-XX: hover/focus reveals the secondary meta (profile + token usage)
           that used to sit inline in the header, reclaiming horizontal space -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <!-- non-interactive container; pointer/focus handlers only track state to
           reveal the popover. The interactive trigger (.desig, role="button")
           lives inside it. -->
      <span
        class="desig-wrap"
        class:editing={renaming}
        class:meta-open={metaVisible}
        class:hovering={hoverOpen}
        bind:this={desigWrapEl}
        onpointerenter={onWrapPointerEnter}
        onpointerleave={onWrapPointerLeave}
        onfocusin={onWrapFocusIn}
        onfocusout={onWrapFocusOut}
      >
        {#if renaming}
          {@render renameField()}
        {:else}
          <span
            class="desig"
            role="button"
            tabindex="0"
            aria-label={`${m.viewport_meta_aria()} — ${m.viewport_title_enter_renames()}`}
            aria-describedby={metaDescId}
            onclick={onTitleTap}
            onkeydown={onTitleKey}
            oncontextmenu={onTriggerContextMenu}
            use:longPress={{ onTrigger: openMeta }}>{session.desig}</span
          >
          {@render metaPop()}
        {/if}
        <span class="vp-meta-sr" id={metaDescId}>{m.viewport_meta_desc()}</span>
      </span>
      {#if !renaming}
        <!-- visible task title: on normal desktop this restores the name beside the
             designator; on compact/touch desktop it keeps the previous name target.
             Pointer-only rename target — the adjacent desig owns the keyboard/AT path
             (a button role here would announce a second, redundant control for the
             same identity), so no role/tabindex/keydown by design. Hidden while
             renaming: the input already shows the editable name in the desig slot. -->
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <!-- keep use:longPress here — .vp-name is the most obvious hold target on
             touch-desktop; dropping it leaves that press doing nothing. The popover
             still anchors to .desig-wrap (its sibling). Mouse hover on .vp-name opens
             nothing (the pointer handlers are on the wrap) — pre-existing, unchanged. -->
        <span
          class="vp-name"
          title={session.name}
          bind:this={vpNameEl}
          onclick={onTitleTap}
          oncontextmenu={onTriggerContextMenu}
          use:longPress={{ onTrigger: openMeta }}>{session.name}</span
        >
      {/if}
    {/if}
    {#if !compact}
      {#if !renaming && branchLabel && !branchRepeatsSessionName}
        <!-- hidden while the rename editor is open — the editor claims the full
             row width, so the branch label would only fight it for space -->
        <span class="sep">·</span>
        <span class="branch" title={session.branch ?? session.worktreePath}>{branchLabel}</span>
      {/if}
      <!-- transient post-rename note (e.g. "branch kept"); the rename input itself
           takes the title's slot in place when active -->
      {@render renameNoteEl()}
    {/if}
    <div class="spacer"></div>
    <ViewportTabBar
      bind:tab
      {session}
      {previewPort}
      todoExists={!!todoExists}
      {hasFiles}
      {hasPreview}
      {compact}
      {headerFolded}
      {vpBodyId}
      {tabId}
      {foldRegionId}
    />
    {#if !compact}
      <span class="sep">·</span>
      <!-- git-rail disclosure — grouped with the work-state chips (status ·
           PLANNING) it shares meaning with, anchored in the right cluster so a
           short task name no longer strands it mid-bar. Reveals the full rail
           (PR / CI / merge / critic / ready / verdict) plus the autopilot toggle
           as a second header row (.vp-git-strip). A direct tap toggles instantly
           and is the keyboard/AT path (aria-expanded); tapping the task title
           (onTitleTap) toggles the same strip. -->
      <button
        class="git-toggle"
        class:open={gitOpen}
        class:attention={prAttention || planAttention}
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
    {/if}
    {#if mobile}
      <!-- connection state, alert-by-exception: a lone red dot only when dropped -->
      {#if !connected}
        <span
          class="vp-offline"
          title={m.topbar_conn_tip_disconnected()}
          aria-label={m.topbar_conn_tip_disconnected()}>●</span
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
      <span class="vp-status-sr">{statusLabel(dStatus)}</span>
    {:else}
      <!-- desktop status: a single shape-coded glyph — done (✓) and idle/archived
           (●) share the slate hue, so shape carries the distinction; the status
           word lives in title + aria. -->
      <span
        class="status-mark"
        style="color:{STATUS_COLOR[dStatus]}"
        role="img"
        title={statusLabel(dStatus)}
        aria-label={statusLabel(dStatus)}>{statusMark}</span
      >
    {/if}
    <!-- plan-gate state in the focused view: the pre-execution lifecycle (PLANNING /
         REWORK / READY / REVIEW ERR; the Review-plan trigger on the git rail acts on this
         state), and during execution the legible read-only PLAN re-open of the signed-off
         plan (issue #809). Self-hides outside the plan phase. Unlike the session-list cards
         (UnitRow, which passes allowView={false}), the focused view surfaces the
         executing read-only chip — it is its home. -->
    <PlanGateBadge {session} pulseReady />
    {#if !compact}
      <!-- passive at-rest pip: the READY control lives in the git strip; its ON
           state stays glance-able here. Autopilot's ON state is surfaced solely
           by the Automation pill in GitRail; paused/complete states still appear
           via AutopilotBadge below. -->
      {#if session.readyToMerge}
        <span
          class="state-pip ready"
          role="img"
          aria-label={m.gitrail_ready_on_title()}
          title={m.gitrail_ready_on_title()}>✓</span
        >
      {/if}
      <!-- REVIEWING (in-flight critic, surfaced in the GitRail/auto-pill) outranks the
           autopilot badge — mirror the cards' precedence so NEEDS YOU/DELIVERED never
           co-renders with REVIEWING anywhere. -->
      {#if !reviews.isReviewing(session.id)}<AutopilotBadge
          {session}
          repoAutopilotDefault={repoConfig.isAutopilotEnabled(session.repoPath)}
        />{/if}
    {/if}
    <ViewportHeaderActions
      {compact}
      {renaming}
      {tab}
      {headerCollapsed}
      {foldRegionId}
      {toggleFold}
      bind:redrawOpen
      {ended}
      {parked}
      {resuming}
      {resumable}
      {resumeSession}
      {prReady}
      {armed}
      {decommission}
      {renameNote}
      onnudge={redrawNudge}
      onreattach={redrawReattach}
      onfullscreen={redrawFullscreen}
      onresume={redrawResume}
      fontSize={effectiveFontSize}
      fontAtMin={effectiveFontSize <= FONT_MIN}
      fontAtMax={effectiveFontSize >= FONT_MAX}
      onfontstep={stepTerminalFont}
    />
  </div>

  <!-- the git rail gets its own strip when there's no room for it inline:
       always on compact layouts (mobile + unfolded fold, where the header wraps),
       and on desktop only while the PR disclosure toggle is open. The strip is
       the session-lifecycle surface, so the lifecycle cluster (ready — inside
       GitRail — autopilot, plus decommission on compact) lives here too, off the
       identity row; on desktop decommission stays inline in the actions cluster. -->
  {#if (compact && !headerCollapsed) || gitOpen}
    <div class="vp-git-strip">
      <GitRail
        sessionId={session.id}
        repoPath={session.repoPath}
        name={session.name}
        prompt={session.prompt}
        ready={session.readyToMerge}
        status={dStatus}
        planPhase={session.planPhase}
        {drain}
        autopilotOn={autopilotEffective}
        issueNumber={session.issueNumber}
        isolated={session.isolated}
        baseBranch={session.baseBranch}
        ondecommission={confirmDecommission}
        mobile
      />
      <span class="strip-controls">
        <!-- per-session autopilot override toggle. Reflects the EFFECTIVE state
             (session override, else repo default) so a null-override session isn't
             shown as off while the repo default has it running. -->
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
          {#if compact}
            {autopilotEffective ? m.session_autopilot_on_short() : m.session_autopilot_off_short()}
          {:else}
            {autopilotEffective ? m.session_autopilot_on_label() : m.session_autopilot_off_label()}
          {/if}
        </button>
        {#if compact && !prReady}
          <!-- compact only: the rare destructive action, parked at the strip's far
               edge; once a PR is up it graduates to the identity row as the green
               ready nudge. Desktop always renders decommission inline in the
               actions cluster, so it never duplicates here. -->
          <button
            class="decom icon-btn compact"
            class:armed
            type="button"
            onclick={decommission}
            title={armed ? m.viewport_confirm_decommission() : m.viewport_decommission_title()}
            aria-label={armed ? m.viewport_confirm_decommission() : m.viewport_decommission_aria()}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"><path d="M18 6 6 18" /><path d="M6 6l12 12" /></svg
            >
          </button>
        {/if}
      </span>
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
    <!-- epic draft review (issue #1507): shown for epic-authoring sessions (or when a draft exists) -->
    <EpicDraftPanel
      sessionId={session.id}
      epicAuthoring={session.epicAuthoring}
      sessionLive={session.status !== "archived" && session.status !== "done"}
    />
  {/if}

  <!-- terminal (stays mounted across tab switches) -->
  <div
    class="vp-body"
    data-swipe-page
    role="tabpanel"
    id={vpBodyId}
    aria-labelledby={tabId(tab)}
    style:--review-banner-h={`${reviewBannerH || ciBannerH}px`}
  >
    <div
      class="term-mount"
      class:dragging
      class:reviewing={reviewInFlight}
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
    {#if tab === "term" && pendingCopy}
      <ClipboardPill
        text={pendingCopy}
        oncopied={() => {
          pendingCopy = null;
          toasts.info(m.clipboard_copied_toast());
        }}
        oncopyfailed={() => {
          // Announce the failure but keep the pill mounted — its Copy button is the
          // retry surface (a fresh in-gesture click), so no separate Retry action.
          toasts.info(m.clipboard_copy_failed(), { alert: true });
        }}
        ondismiss={() => (pendingCopy = null)}
      />
    {/if}
    <ViewportTermBanners
      {tab}
      {scrolledUp}
      {parked}
      {ended}
      {endReason}
      {resuming}
      {resumeFailed}
      {resumable}
      {authUrl}
      {scrollToTop}
      {scrollToBottom}
      {takeover}
      {reattach}
      {resumeSession}
    />
    <!-- Non-blocking review-in-flight banner: reserved bottom strip. The terminal
         (.term-mount) shrinks by this banner's height (--review-banner-h) so the
         strip sits BELOW the live prompt, not over it. Stays mounted across tab
         switches (state survives); it suppresses its own render off the term tab.
         (issue #1022) -->
    <ReviewInFlightBanner
      {session}
      {dStatus}
      {activity}
      keystrokes={opKeystrokes}
      {tab}
      bind:height={reviewBannerH}
      bind:active={reviewActive}
      bind:inflight={reviewInFlight}
    />
    <!-- Non-blocking "CI is running" banner: same bottom strip, shown only when no
         review banner claims it (reviewActive) so the two never overlap. -->
    <CiRunningBanner {git} {tab} {reviewActive} bind:height={ciBannerH} />
    {#if tab === "todo"}
      <div class="panel-wrap">
        <TodoPanel repoPath={session.repoPath} />
      </div>
    {/if}
    {#if tab === "activity"}
      <div class="panel-wrap activity-wrap">
        <SubagentFanout sessionId={session.id} {subagents} />
        {#if showInlineRecap}
          <div class="activity-recap-fill">
            <SessionRecap {session} inline />
          </div>
        {:else}
          {#if activityRecap?.state === "failed"}
            <!-- compact retry strip: inline SessionRecap renders only the failed+retry row here -->
            <SessionRecap {session} inline />
          {/if}
          <div class="activity-feed-fill">
            <ActivityFeed sessionId={session.id} />
          </div>
        {/if}
      </div>
    {/if}
    {#if tab === "diff"}
      <div class="panel-wrap">
        <DiffPanel sessionId={session.id} />
      </div>
    {/if}
    {#if tab === "files"}
      <div class="panel-wrap">
        <FilesPanel sessionId={session.id} />
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
          {#if previewServeFailed}
            <span class="preview-serve-failed">{m.viewport_preview_serve_failed()}</span>
          {/if}
          <!-- Persistent static setup hint (NOT an auto-detected error): a blank
               frame usually means the preview port isn't tailscale-served yet, or the
               app refuses to frame via in-HTML CSP — both handled by open-in-new-tab. -->
          <span class="preview-hint">{m.viewport_preview_setup_hint()}</span>
          <button
            class="preview-stop"
            class:armed={previewStopArmed}
            type="button"
            disabled={isPreviewStopPending}
            title={m.viewport_preview_stop_note()}
            onclick={onStopPreviewClick}
            >{previewStopArmed
              ? m.viewport_preview_stop_confirm()
              : m.viewport_preview_stop()}</button
          >
          <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external preview origin (distinct port), not an app route -->
          <a class="preview-open" href={previewUrl} target="_blank" rel="noopener"
            >{m.viewport_preview_open_new_tab()}</a
          >
        </div>
      </div>
    {/if}
  </div>

  {#if tab === "term"}
    <SteerBar
      focusedId={session.id}
      repoPath={session.repoPath}
      agentProvider={effectiveAgentProvider}
      onbroadcast={() => onbroadcast?.()}
      onretry={() => onretry?.()}
      {retryHaltedCount}
      {retryReady}
      onedit={(id) => onedit?.(id)}
      {mobile}
      {touch}
      termSend={(seq) => conn?.send(seq)}
      {micAvailable}
      ondictate={() => {
        composeDictate = true;
        composeOpen = true;
      }}
    />
  {/if}

  <!-- control-key bar: any touch device (incl. unfolded foldables wider than the
       mobile breakpoint) gets it, since there's no hardware keyboard to steer with -->
  <ViewportTermControls
    {mobile}
    {touch}
    {tab}
    send={(seq) => conn?.send(seq)}
    {notesKey}
    {enter}
    {uploading}
    {uploadFailed}
    {attachImages}
    onsummon={() => {
      composeDictate = false;
      composeOpen = true;
    }}
  />
  {#if composeOpen}
    <ComposeBar
      onsend={sendComposed}
      onclose={() => (composeOpen = false)}
      repoPath={session.repoPath}
      agentProvider={effectiveAgentProvider}
      startDictation={composeDictate}
    />
  {/if}

  {#if tab !== "activity"}
    <SessionRecap {session} />
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
      <span
        class="hint-help"
        title={m.viewport_select_hint_title({ key: isMac ? "Option (⌥)" : "Shift (⇧)" })}
      >
        {m.viewport_select_hint({ key: isMac ? "⌥" : "⇧" })}
      </span>
      <span class="sep">·</span>
      <span>{m.viewport_keynav_hint()}</span>
      <span class="sep">·</span>
      <span>{m.viewport_commandbar_hint({ key: isMac ? "⌘K" : "Ctrl+K" })}</span>
      <!-- Enter only hands focus back on the terminal tab (focusTerminal
           no-ops elsewhere), so don't advertise it on other tabs -->
      {#if tab === "term"}
        <span class="sep">·</span>
        <span>{m.viewport_keynav_enter_hint()}</span>
      {/if}
    </div>
  {/if}
</div>

{#if leftovers.length > 0}
  <LeftoverDialog
    {leftovers}
    onclose={() => {
      const target = decomTarget ?? session.id;
      leftovers = [];
      decomTarget = null;
      onarchive?.(target);
    }}
    onconfirm={(keys) => {
      const target = decomTarget ?? session.id;
      leftovers = [];
      decomTarget = null;
      onarchive?.(target, keys);
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

  /* Short viewports (unfolded foldable split-screen landscape, phone landscape):
     the detail/terminal screen is a fixed-height .shell.mobile column — NOT the
     document-scroll list shell. .viewport keeps its definite height:100%, so vp-body
     fills the pane and the terminal keeps its own internal scroll while content fits
     (no page scrollbar). Only at the extreme-short floor (column min-content > pane,
     vp-body pinned to its 4rem min) would the bottom bars (SteerBar /
     ViewportTermControls / SessionRecap) be clipped by overflow:hidden with no way to
     reach them — so allow vertical page-scroll there. overflow-x stays hidden to
     preserve the horizontal swipe-to-navigate clip. Safe to key on height alone: at
     height ≤600 the app is in the mobile branch (the desktop Viewport instance is
     unmounted), and tall mobile (height >600) never matches, so normal phone detail
     is untouched. */
  @media (max-height: 600px) {
    .viewport {
      overflow: hidden auto;
    }
  }

  /* phone session view: full-bleed terminal — the side borders + rounded corners
     cost two vertical lines plus gutters on a narrow phone, so drop them and
     stretch into the shell's base edge padding (--mobile-shell-pad, shared with
     .shell.mobile in +page.svelte; a larger safe-area inset keeps the remainder).
     The top/bottom borders stay as horizontal section rules. Mirrors Herd's
     .panel.flow full-bleed treatment for the mobile list. */
  .viewport.phone {
    border-inline: 0;
    border-radius: 0;
    margin-inline: calc(-1 * var(--mobile-shell-pad));
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
     present. Status is carried by the background tint alone — no side stripe.
     The pulse is compositor-only: base background stays static; a ::after
     overlay carries the delta (5% extra amber) and animates via opacity only,
     avoiding per-frame background repaints. */
  .vp-head.working {
    position: relative;
    background: color-mix(in srgb, var(--color-amber) 4%, var(--color-head));
  }
  .vp-head.working::after {
    content: "";
    position: absolute;
    inset: 0;
    background: color-mix(in srgb, var(--color-amber) 5%, transparent);
    pointer-events: none;
    animation: vp-working-pulse 2.4s ease-in-out infinite;
  }
  @keyframes vp-working-pulse {
    0%,
    100% {
      opacity: 0;
    }
    50% {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .vp-head.working {
      background: color-mix(in srgb, var(--color-amber) 7%, var(--color-head));
    }
    .vp-head.working::after {
      display: none;
    }
  }

  .desig-wrap {
    position: relative;
    flex-shrink: 0;
    display: inline-flex;
    /* shared by .desig-pop's width and the hover-bridge ::after below, so the
       bridge spans the popover (up to 520px), not the narrow chip. */
    --desig-pop-w: min(520px, calc(100vw - 24px));
  }

  /* the task designation as a read-only ghost chip: boxed at the 6px chip radius
     to rhyme with the GitRail chip strip, but hue-less and dot-less so it never
     competes with the semantic status chips. A sanctioned standalone ghost-chip
     form (DESIGN.md), distinct from the inline 2px Badge. */
  .desig {
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-muted);
    flex-shrink: 0;
    cursor: default;
    border: 1px solid var(--color-line);
    border-radius: 6px;
    padding: 3px 9px;
    /* double-tap renames: no double-tap zoom, no text-selection flash on dblclick.
       -webkit-touch-callout: a 500ms hold on this text would otherwise raise iOS
       Safari's selection callout/magnifier over the popover (user-select:none alone
       doesn't suppress it) — mirrors UnitRow's long-press-on-text fix. */
    touch-action: manipulation;
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
  .desig-wrap.hovering .desig {
    color: var(--color-ink-bright);
    border-color: var(--color-line-bright);
    background: var(--color-hover);
  }
  /* Compact / touch header (.vp-head.mobile) wraps its row, and the git-toggle the
     ghost chip rhymes with isn't rendered there — so keep the designation the plain
     dotted-underline label it was. A boxed chip would widen the wrapping row and
     push the tab bar under the hover meta-popover (.desig-pop), which would then
     intercept tab taps. */
  .vp-head.mobile .desig {
    border: 0;
    border-bottom: 1px dotted var(--color-line);
    border-radius: 0;
    padding: 0;
  }
  .vp-head.mobile .desig-wrap.hovering .desig {
    color: var(--color-ink);
    border-color: var(--color-line);
    background: transparent;
  }
  /* keyboard focus — flat inset amber ring, distinct from the hover color shift */
  .desig:focus-visible {
    color: var(--color-ink);
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }

  /* secondary meta popover, revealed on hover/focus of the task designator */
  .desig-pop {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 20;
    display: none;
    flex-direction: column;
    gap: 4px;
    width: var(--desig-pop-w);
    max-height: min(70vh, 720px);
    overflow: auto;
    padding: 8px 10px;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    box-shadow: 0 6px 20px color-mix(in srgb, var(--color-bg) 45%, transparent);
    white-space: normal;
    text-transform: none;
    letter-spacing: normal;
  }
  .desig-wrap.meta-open .desig-pop {
    display: flex;
  }
  /* Hover-bridge: .desig-pop sits at top:calc(100% + 4px), so a 4px dead band
     outside the wrap separates chip from popover; a mouse crossing it fires
     pointerleave and closes the popover before reaching its scrollable content.
     This out-of-flow ::after (a pseudo-element's hit target is its origin element,
     so the pointer never actually leaves .desig-wrap) bridges the band. Gated on
     .hovering (never true for touch) — never .meta-open — so no dead hit-strip is
     laid across a wrapped phone header; :not(.editing) so it isn't armed with the
     rename editor (and no popover) beneath it. position:absolute is required: the
     wrap is inline-flex, so an in-flow ::after would become a flex item and widen
     the chip. */
  .desig-wrap.hovering:not(.editing)::after {
    content: "";
    position: absolute;
    top: 100%;
    left: 0;
    width: var(--desig-pop-w);
    height: 4px;
  }
  .dp-row {
    display: grid;
    grid-template-columns: minmax(128px, 0.42fr) minmax(0, 1fr);
    gap: 12px;
    align-items: start;
    font-size: var(--fs-meta);
  }
  .dp-section {
    margin-top: 4px;
    padding-top: 5px;
    border-top: 1px solid var(--color-line);
    color: var(--color-muted);
    font-size: var(--fs-meta);
    font-weight: 700;
  }
  .dp-k {
    color: var(--color-muted);
  }
  .dp-v {
    min-width: 0;
    color: var(--color-ink);
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  }

  /* full task name — the visible rename target beside the task designator */
  .vp-name {
    color: var(--color-ink);
    font-size: var(--fs-base);
    /* double-tap renames: no double-tap zoom, no text-selection flash on dblclick.
       -webkit-touch-callout: suppress iOS Safari's selection callout on a 500ms hold
       (the hold that opens the popover) — see .desig. */
    touch-action: manipulation;
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
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

  .status-mark {
    font-size: var(--fs-meta);
    flex-shrink: 0;
  }

  /* desktop disclosure for the git rail — a ghost chip that toggles the second
     header row. Stays neutral until the PR has an actionable verdict, then takes a
     hue: green = CI green & critic clear (ready to merge), amber = needs you (CI
     failed or critic requested changes). Pending / merged / closed stay neutral. */
  .git-toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 6px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 3px 9px;
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
    width: 7px;
    height: 7px;
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
    font-size: var(--fs-meta);
    line-height: 1;
  }
  .git-toggle.open .gt-caret,
  .git-toggle.attention .gt-caret,
  .git-toggle.clear .gt-caret {
    color: currentColor;
  }

  /* passive at-rest state pips (identity row): quiet AutoPip-style pills that keep
     the READY / AUTOPILOT on-state visible while the controls themselves live in
     the git strip. Four-Light hues: green = ready-to-merge, amber = active mode. */
  .state-pip {
    flex-shrink: 0;
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 1px 6px;
    border: 1px solid;
    border-radius: 2px;
    white-space: nowrap;
    font-weight: 600;
  }
  .state-pip.ready {
    color: var(--color-green);
    border-color: color-mix(in srgb, var(--color-green) 55%, transparent);
  }

  /* per-session autopilot toggle (git strip): matches .git-toggle sizing */
  .ap-toggle {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 6px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 3px 9px;
    cursor: pointer;
    transition:
      color 0.12s,
      border-color 0.12s;
  }
  .ap-toggle:hover {
    color: var(--color-ink);
  }
  /* ON is an active mode, not a completion — amber per the active-toolbar
     convention (DESIGN.md); green stays reserved for ready-to-merge */
  .ap-toggle.on {
    color: var(--color-amber);
    border-color: color-mix(in srgb, var(--color-amber) 55%, transparent);
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
    /* double-tap renames: no double-tap zoom, no text-selection flash on dblclick.
       -webkit-touch-callout: suppress iOS Safari's selection callout on a 500ms hold
       (the hold that opens the popover) — see .desig. */
    touch-action: manipulation;
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
  .ctx-glyph {
    color: var(--color-amber);
    font-size: var(--fs-meta);
    flex-shrink: 0;
  }
  .ctx-glyph.emoji {
    font-size: var(--fs-lg);
  }
  /* tappable emoji standing in for the repo name — toggles it back in.
     Phone-first control: pad the hit area toward the 44px touch-target
     minimum; matching negative margins keep the visual layout unchanged.
     Horizontal stays at ±8px — the header gap is only 7px, so anything wider
     would overlay the back button / title trigger and steal their taps. */
  .ctx-glyph.emoji.actionable {
    cursor: pointer;
    padding: 12px 8px;
    margin: -12px -8px;
  }
  .ctx-glyph.emoji.actionable:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
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
     the leading shape glyph (blocked/done). .vp-meta-sr shares the recipe: the
     aria-describedby target that advertises the popover affordance, mounted as the
     last child of .desig-wrap (position:absolute keeps it out of the inline-flex
     flow so it never widens the chip). */
  .vp-status-sr,
  .vp-meta-sr {
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
    cursor: pointer;
    transition:
      color 0.12s,
      border-color 0.12s,
      background 0.12s;
  }

  .decom:hover {
    color: var(--color-red);
    border-color: color-mix(in srgb, var(--color-red) 45%, transparent);
  }

  .decom.armed {
    color: var(--color-red);
    border-color: var(--color-red);
    background: color-mix(in srgb, var(--color-red) 12%, transparent);
  }

  /* Icon-only armed decom: no "?" adornment (the square has no room for it); the
     armed/destructive-confirm state reads as a solid red fill instead. Scoped to
     .icon-btn so the labeled "confirm ✕" text form keeps its faint-red treatment. */
  .decom.icon-btn.armed {
    background: var(--color-red);
    border-color: var(--color-red);
    /* knockout ✕ in the surface color — clears WCAG ≥3:1 non-text contrast on the
       red fill in all four themes (ink-bright fails the high-contrast themes). */
    color: var(--color-bg);
  }

  /* rename: inline editor that takes the title's own slot in place (double-tap/
     dblclick the title to open it); the post-rename note sits in the trailing
     cluster on compact/phone, after the branch on desktop.
     While open, the editor claims the full row width (.desig-wrap.editing turns
     the title slot into the row's grower; the desktop branch label hides) so the
     name is editable at length instead of inside a 14ch peephole. */
  .desig-wrap.editing {
    flex: 1 1 auto;
    min-width: 0;
  }
  .rename-edit {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1 1 auto;
    min-width: 0;
  }
  .rename-input {
    flex: 1 1 auto;
    min-width: 0;
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    border-radius: 6px;
    color: var(--color-ink-bright);
    font-family: var(--font-mono);
    font-size: var(--fs-base);
    padding: 5px 10px;
  }
  .rename-input:focus {
    outline: none;
    border-color: var(--color-amber);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-amber) 22%, transparent);
  }
  .rename-input.err {
    border-color: var(--color-red);
  }
  /* ✕ cancel / ✓ confirm flanking the input's right edge */
  .rename-btn {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 30px;
    min-height: 30px;
    padding: 0;
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    border-radius: 6px;
    font-family: var(--font-mono);
    font-size: var(--fs-base);
    line-height: 1;
    cursor: pointer;
    transition:
      color 0.12s,
      border-color 0.12s,
      background 0.12s;
  }
  .rename-btn.ok {
    color: var(--color-amber);
  }
  .rename-btn.ok:hover {
    border-color: var(--color-amber);
    background: color-mix(in srgb, var(--color-amber) 12%, transparent);
  }
  .rename-btn.cancel {
    color: var(--color-muted);
  }
  .rename-btn.cancel:hover {
    color: var(--color-red);
    border-color: var(--color-red);
    background: color-mix(in srgb, var(--color-red) 10%, transparent);
  }
  .rename-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  /* error floats below the input (header is overflow:visible) so it never
     squeezes the now-full-width field */
  .rename-err {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 20;
    color: var(--color-red);
    font-size: var(--fs-micro);
    background: var(--color-inset);
    border: 1px solid var(--color-red);
    border-radius: 4px;
    padding: 3px 7px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: min(60vw, 36ch);
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
    /* Floor so an expanded, scrollable SessionRecap (a sibling flex item that
       can shrink to its content) can't squeeze the body to 0px — a sliver of
       terminal/diff/todo/preview always remains. Only bites under the
       expanded-recap takeover; normal body content is far taller. */
    min-height: 4rem;
  }

  .term-mount {
    width: 100%;
    /* Reserve the review/CI banner's bottom strip so xterm reflows ABOVE it instead
       of being overlaid — the live prompt stays visible while a review runs.
       --review-banner-h is published on .vp-body (0px when no banner shows).
       Changing this height trips the ResizeObserver on this element → refit() → PTY
       resize, which is the intended reflow. The min-height floor equals .vp-body's
       own min-height (4rem) and must NOT exceed it: a larger floor would force the
       mount taller than a squeezed body and clip the bottom prompt row via
       .vp-body's overflow:hidden even with no banner. The review banner caps its own
       height at min(50%, 100% - 4rem) (see ReviewInFlightBanner) and shrinks its live
       preview to fit, so for any usably-sized terminal --review-banner-h stays ≤ 100% -
       4rem ⇒ this mount keeps its 4rem floor and the floor never overrides the reserve
       into an overlap. The banner can't shrink below its headline row (~1 line,
       flex-shrink:0), so only in the extreme squeezed-recap takeover — .vp-body pinned at
       its own 4rem floor, where nothing fits both a prompt and a banner — a small residual
       overlap of at most that headline row remains, still far less than the full-banner
       burial before the cap. */
    height: calc(100% - var(--review-banner-h, 0px));
    min-height: 4rem;
    overflow: hidden;
    /* we drive vertical scroll via touch handlers; keep the browser out of it */
    touch-action: none;
  }

  /* Visual-only dim while a review runs off-screen (bound from ReviewInFlightBanner's in-flight
     tier): the operator reads "Shepherd is working — hands off". NOT a modal scrim/blur — this is
     a non-blocking state and the live prompt stays usable; only the idle terminal recedes. The
     review banner + its live preview are siblings in .vp-body, so they stay fully lit. */
  .term-mount.reviewing {
    opacity: 0.5;
    transition: opacity 0.18s ease;
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
    min-width: 44px;
    min-height: 44px;
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

  /* dedicated git-rail strip for compact layouts (mobile + unfolded fold) and the
     desktop git-actions disclosure — the session-lifecycle surface */
  .vp-git-strip {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    flex-wrap: nowrap;
    min-width: 0;
    gap: 6px;
    padding: 6px 10px;
    background: var(--color-head);
    border-bottom: 1px solid var(--color-line);
    flex-shrink: 0;
    min-height: 44px;
  }
  /* lifecycle cluster (autopilot toggle + decommission) at the strip's trailing
     edge, split from the git controls by a hairline so the two groups read apart */
  .strip-controls {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 0 0 auto;
    padding-left: 8px;
    border-left: 1px solid var(--color-line);
  }
  /* the strip's GitRail uses the shared actionbar touch height — match it so the
     cluster doesn't sit half-height beside the rail buttons */
  .strip-controls .ap-toggle {
    min-height: var(--mobile-actionbar-hit);
    padding: 6px 9px;
  }

  .vp-head.mobile {
    flex-wrap: wrap;
    row-gap: 6px;
    padding: 8px 10px;
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
  /* finger-sized header controls on touch layouts (≥44px) */
  .vp-head.mobile .back {
    min-height: 44px;
    padding: 8px 12px;
    font-size: var(--fs-base);
  }
  /* rename ✕/✓ likewise finger-sized; the input matches their height so the
     editor reads as one bar */
  .vp-head.mobile .rename-btn {
    min-width: 44px;
    min-height: 44px;
    font-size: var(--fs-lg);
  }
  .vp-head.mobile .rename-input {
    min-height: 44px;
    padding: 5px 12px;
  }
  /* phone: the back control is a bare list glyph (☰, distinct from the ‹/› queue
     pager) — size it up to read as an icon */
  .vp-head.phone .back {
    font-size: var(--fs-xl);
    line-height: 1;
    padding: 6px 12px;
  }
  .panel-wrap {
    position: absolute;
    inset: 0;
    overflow: hidden;
  }
  /* Activity tab stacks the sub-agent fan-out (sized to content, self-capped) above
     the scrolling activity feed, which fills the remaining height. */
  .activity-wrap {
    display: flex;
    flex-direction: column;
  }
  .activity-feed-fill {
    flex: 1 1 auto;
    min-height: 0;
  }
  .activity-recap-fill {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 8px 10px;
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
  /* Degraded state: tailscale serve registration failed; mirrors preview-hint sizing
     but uses amber (attention/degraded) to call out the registration failure. */
  .preview-serve-failed {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-amber);
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
  /* stop-preview button: borrows .decom's danger-arm color treatment (faint base →
     --color-red on hover/armed) but keeps mixed-case at a tighter letter-spacing
     (0.08em vs .decom's 0.12em) because the label is multi-word ("Stop dev server" /
     "Confirm stop?") and all-caps would be too aggressive in the footer. */
  .preview-stop {
    flex: none;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 2px;
    color: var(--color-faint);
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    padding: 2px 7px;
    cursor: pointer;
    transition:
      color 0.12s,
      border-color 0.12s,
      background 0.12s;
  }
  .preview-stop:hover:not(:disabled) {
    color: var(--color-red);
    border-color: color-mix(in srgb, var(--color-red) 45%, transparent);
  }
  .preview-stop:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .preview-stop.armed {
    color: var(--color-red);
    border-color: var(--color-red);
    background: color-mix(in srgb, var(--color-red) 12%, transparent);
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

  .hint-help {
    cursor: help;
    text-decoration: underline dotted;
    text-underline-offset: 0.2em;
  }

  .term-mount.dragging {
    outline: 2px dashed var(--color-amber);
    outline-offset: -4px;
  }
</style>
