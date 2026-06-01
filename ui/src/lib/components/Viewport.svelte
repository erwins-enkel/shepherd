<script lang="ts">
  import "@xterm/xterm/css/xterm.css";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { WebLinksAddon } from "@xterm/addon-web-links";
  import type { Session, SessionUsage } from "$lib/types";
  import { STATUS_COLOR, statusLabel, formatTokens } from "$lib/format";
  import { connectPty, type PtyConn } from "$lib/pty";
  import { theme, xtermTheme, xtermMinContrast } from "$lib/theme.svelte";
  import { getSessionUsage, uploadImage, resumeSession as apiResumeSession } from "$lib/api";
  import { imageFilesFromItems } from "$lib/clipboard";
  import { composeKeystrokes } from "$lib/compose";
  import TodoPanel from "$lib/components/TodoPanel.svelte";
  import IssuesPanel from "$lib/components/IssuesPanel.svelte";
  import ActivityFeed from "$lib/components/ActivityFeed.svelte";
  import DiffPanel from "$lib/components/DiffPanel.svelte";
  import ControlBar from "$lib/components/ControlBar.svelte";
  import ComposeBar from "$lib/components/ComposeBar.svelte";
  import GitRail from "$lib/components/GitRail.svelte";
  import SteerBar from "$lib/components/SteerBar.svelte";
  import { m } from "$lib/paraglide/messages";

  let {
    session,
    onnewtask,
    onarchive,
    onback,
    onnextneedsyou,
    nextNeedsYou = 0,
    onbroadcast,
    mobile = false,
    touch = false,
    queue = [],
    onnavigate,
  }: {
    session: Session;
    onnewtask?: (repoPath: string, prompt: string) => void;
    onarchive?: (id: string) => void;
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
    onnavigate?: (id: string) => void;
  } = $props();

  let el: HTMLDivElement | undefined = $state();
  let tab = $state<"term" | "todo" | "issues" | "activity" | "diff">("term");
  let conn = $state<PtyConn | undefined>();
  // true when another device took over this terminal — show a take-over prompt
  let parked = $state(false);
  // true once the agent is gone (claude quit / ctrl-c) — show a "resume" prompt
  let ended = $state(false);
  let resuming = $state(false);
  let resumeFailed = $state(false);
  // bumped on a successful resume to tear down the dead terminal + re-attach to the
  // freshly-spawned herdr agent (the terminal effect keys on it alongside the unit id)
  let resumeEpoch = $state(0);
  // mirror the live terminal so the theme effect can repaint it without
  // recreating it (recreating would tear down the PTY socket)
  let termRef = $state<Terminal | undefined>();
  // true when the user has scrolled up away from the latest output → show a
  // jump-to-bottom affordance bottom-right of the terminal. Two regimes:
  //  • normal buffer (plain shell / classic Claude): xterm owns the scrollback,
  //    so we read its viewport offset directly.
  //  • alternate screen (Claude's fullscreen TUI): Claude owns the scroll and
  //    xterm's viewport never moves, so we can't read a position. We approximate
  //    it with a wheel/gesture accumulator (scrollDepth) and jump back with the
  //    app's own Ctrl+End shortcut instead of moving xterm.
  let scrolledUp = $state(false);
  // px-ish accumulator of net upward scrolling while on the alternate screen;
  // plain (non-reactive) — only `scrolledUp` drives the UI. Reset on re-attach,
  // buffer switch, and a jump-to-bottom.
  let scrollDepth = 0;
  let dragging = $state(false);
  let uploading = $state(false);
  let uploadFailed = $state(false);
  let fileInput = $state<HTMLInputElement>();

  // compact header: narrow mobile OR a touch device on the desktop layout (unfolded
  // foldables). Drops secondary fields + wraps so the decommission button never clips.
  const compact = $derived(mobile || touch);

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

  // null model = claude's own default (shepherd passed no --model flag)
  const modelLabel = $derived(session.model ?? "default");

  // session:status events replace the Session object on every state change of the
  // running unit, so the `session` prop reference churns while its id stays put.
  // Derive the id: a $derived only notifies dependents when its *value* changes,
  // so effects keyed on it re-run on an actual unit switch — not on status churn.
  const unitId = $derived(session.id);

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

  // two-step decommission: first click arms, second (within 3s) fires; disarms on unit change
  let armed = $state(false);
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- touch reactive dep
    unitId; // on unit switch: disarm decommission + default back to terminal tab
    armed = false;
    tab = "term";
    ended = false;
    resumeFailed = false;
  });
  $effect(() => () => clearTimeout(armTimer));
  function decommission() {
    if (!armed) {
      armed = true;
      clearTimeout(armTimer);
      armTimer = setTimeout(() => (armed = false), 3000);
      return;
    }
    clearTimeout(armTimer);
    armed = false;
    onarchive?.(session.id);
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

  function scrollToBottom() {
    const term = termRef;
    if (!term) return;
    if (term.buffer.active.type === "alternate") {
      // Claude's fullscreen TUI owns the scroll; xterm can't move it. Ctrl+End is
      // its documented "jump to latest + re-enable auto-follow" shortcut and is
      // never interpreted as prompt text.
      conn?.send("\x1b[1;5F");
    } else {
      term.scrollToBottom();
    }
    scrollDepth = 0;
    scrolledUp = false;
  }

  // bring a finished session back: ask the server to respawn `claude --resume` in
  // the worktree, then bump the epoch so the terminal effect rebuilds and attaches
  // to the fresh agent (the old PtyConn stopped for good on the ended-close).
  async function resumeSession() {
    if (resuming) return;
    resuming = true;
    resumeFailed = false;
    try {
      await apiResumeSession(session.id);
      ended = false;
      resumeEpoch++;
    } catch {
      resumeFailed = true;
    } finally {
      resuming = false;
    }
  }

  // mobile compose bar submit. Routing the composed line through here (as an
  // atomic bracketed paste) instead of xterm's textarea sidesteps the Android
  // IME duplication bug. See composeKeystrokes for the byte mapping.
  function sendComposed(text: string) {
    conn?.send(composeKeystrokes(text));
  }

  $effect(() => {
    const id = unitId;
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- reactive dep
    resumeEpoch; // a resume bumps this → rebuild the terminal + re-attach to the new agent
    if (!el) return;
    parked = false; // fresh attach for this unit
    scrolledUp = false; // fresh terminal starts pinned to the bottom
    scrollDepth = 0;

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
      // the session ended (agent gone) — note it in the buffer + surface a "resume"
      // prompt; the status badge already flips to "done" via the session:status event
      () => {
        term.write(`\r\n\x1b[2m${m.viewport_session_ended()}\x1b[0m\r\n`);
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
    // Shift+Enter, so Claude Code can't tell them apart and submits. Send a
    // line feed (0x0A, same byte as Ctrl+J / chat:newline) instead and swallow
    // xterm's default CR. keydown-only so the keyup doesn't double-send.
    term.attachCustomKeyEventHandler((e) => {
      if (
        e.type === "keydown" &&
        e.key === "Enter" &&
        e.shiftKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey
      ) {
        c.send("\n");
        return false;
      }
      return true;
    });

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

    // Claude Code runs as a full-screen TUI on the alternate screen (no
    // scrollback) with mouse tracking on: scrolling means sending wheel input
    // to the app, which is what the mouse wheel does on desktop. Touch emits no
    // wheel events, so translate one-finger drags into wheel events on xterm's
    // screen — xterm then forwards them per the active mode (to the app when
    // mouse-tracking, otherwise its own scrollback). Matches desktop in both.
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
      // on the alternate screen xterm's viewport never moves (onScroll won't fire),
      // so track the gesture directly: dy<0 = scrolling up → grow the depth.
      if (term.buffer.active.type === "alternate") {
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

    // track scroll position so we can offer a jump-to-bottom button. The normal
    // buffer carries scrollback → read xterm's viewport offset. The alternate
    // screen (Claude's fullscreen TUI) has no xterm scrollback and forwards wheel
    // input to the app, so xterm's viewport never moves; there we lean on the
    // wheel accumulator instead.
    const SCROLL_UP_PX = 30; // small swipe / one wheel notch before the button shows
    const recomputeScrolled = () => {
      const b = term.buffer.active;
      scrolledUp = b.type === "normal" ? b.baseY - b.viewportY > 0 : scrollDepth > SCROLL_UP_PX;
    };
    const scrollSub = term.onScroll(recomputeScrolled);
    const bufSub = term.buffer.onBufferChange(() => {
      scrollDepth = 0;
      recomputeScrolled();
    });

    // desktop wheel observer for the alternate screen, where onScroll never fires.
    // Touch is tracked directly in onTouchMove, so ignore the synthetic wheels it
    // dispatches (isTrusted=false) to avoid double-counting; only real wheels here.
    // deltaY<0 = scrolling up (reveal older) → grow depth; >0 = toward latest.
    const onWheelTrack = (e: WheelEvent) => {
      if (!e.isTrusted || term.buffer.active.type !== "alternate") return;
      scrollDepth = Math.max(0, scrollDepth - e.deltaY);
      recomputeScrolled();
    };
    el.addEventListener("wheel", onWheelTrack, { passive: true, capture: true });

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onPageShow);
      el?.removeEventListener("click", onTap);
      el?.removeEventListener("paste", onPaste, true);
      el?.removeEventListener("touchstart", onTouchStart);
      el?.removeEventListener("touchmove", onTouchMove);
      el?.removeEventListener("touchend", onTouchEnd);
      el?.removeEventListener("wheel", onWheelTrack, { capture: true });
      scrollSub.dispose();
      bufSub.dispose();
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
    const term = termRef;
    if (!term) return;
    term.options.theme = xtermTheme(resolved);
    term.options.minimumContrastRatio = xtermMinContrast(resolved);
    term.refresh(0, Math.max(0, term.rows - 1));
  });
</script>

<div class="viewport">
  <!-- header -->
  <div class="vp-head" class:mobile={compact} class:phone={mobile}>
    {#if onback}
      <button class="back" type="button" onclick={onback} aria-label={m.viewport_back_aria()}
        >{m.viewport_back_button()}</button
      >
    {/if}
    {#if onnextneedsyou && nextNeedsYou > 0}
      <button
        class="next-yu"
        type="button"
        onclick={onnextneedsyou}
        aria-label={m.viewport_next_needs_you_aria()}
      >
        {m.viewport_next_needs_you()}
        <span class="nyu-count">{nextNeedsYou}</span>
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
    <!-- TASK-XX: hover/focus reveals the secondary meta (profile + token usage)
         that used to sit inline in the header, reclaiming horizontal space -->
    <span class="desig-wrap">
      <span class="desig" role="button" tabindex="0" aria-label={m.viewport_meta_aria()}
        >{session.desig}</span
      >
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
    </span>
    {#if compact && !mobile}
      <!-- foldable/touch desktop only: on a phone the task name now lives in the
           top bar (repo · task), so showing it here too would just duplicate it -->
      <span class="vp-name" title={session.name}>{session.name}</span>
    {/if}
    {#if !compact}
      <span class="sep">·</span>
      <span class="branch">{session.branch ?? session.worktreePath}</span>
    {/if}
    <div class="spacer"></div>
    <div class="tab-group" class:mobile={compact}>
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
    </div>
    {#if !compact}
      <span class="sep">·</span>
    {/if}
    <span
      class="status-badge"
      style="color:{STATUS_COLOR[session.status]};border-color:{STATUS_COLOR[session.status]}"
    >
      {#if session.status === "running"}⠿{/if}
      {statusLabel(session.status)}
    </span>
    {#if !compact}
      <GitRail
        sessionId={session.id}
        repoPath={session.repoPath}
        name={session.name}
        prompt={session.prompt}
      />
    {/if}
    <button
      class="decom"
      class:armed
      type="button"
      onclick={decommission}
      title={m.viewport_decommission_title()}
      aria-label={m.viewport_decommission_aria()}
    >
      {#if compact}
        {armed ? "✓" : "✕"}
      {:else}
        {armed ? m.viewport_confirm_decommission() : m.viewport_decommission()}
      {/if}
    </button>
  </div>

  <!-- compact layouts (mobile + unfolded fold) get the git rail its own strip,
       since the wrapping header has no room for it -->
  {#if compact}
    <div class="vp-git-strip">
      <GitRail
        sessionId={session.id}
        repoPath={session.repoPath}
        name={session.name}
        prompt={session.prompt}
        mobile
      />
    </div>
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
    {#if ended && !parked && tab === "term" && session.claudeSessionId}
      <button class="parked resume" type="button" onclick={resumeSession} disabled={resuming}>
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
          onnewtask={(p) => onnewtask?.(session.repoPath, p)}
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
  </div>

  {#if tab === "term"}
    <SteerBar focusedId={session.id} onbroadcast={() => onbroadcast?.()} />
  {/if}

  <!-- control-key bar: any touch device (incl. unfolded foldables wider than the
       mobile breakpoint) gets it, since there's no hardware keyboard to steer with -->
  {#if (mobile || touch) && tab === "term"}
    <div class="ctrl-row">
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
      <ControlBar onkey={(seq) => conn?.send(seq)} />
    </div>
    <ComposeBar onsend={sendComposed} />
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

  <!-- footer: keyboard-affordance hints — desktop / foldable only. On a phone
       there's no Tab key and the back button already affords leaving, so the
       row is pure overhead; dropping it hands the height back to the terminal -->
  {#if !mobile}
    <div class="vp-foot">
      <span>{m.viewport_type_steer_hint()}</span>
      <span class="sep">·</span>
      <span>{m.viewport_detach_hint()}</span>
    </div>
  {/if}
</div>

<style>
  .viewport {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    overflow: hidden;
  }

  .vp-head {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 6px 12px;
    background: var(--color-head);
    border-bottom: 1px solid var(--color-line);
    font-size: 11.5px;
    flex-shrink: 0;
    white-space: nowrap;
    /* not overflow:hidden — the Open-PR popover drops below the header and must
       escape it; long content is still clipped by .viewport's overflow */
    overflow: visible;
  }

  .desig-wrap {
    position: relative;
    flex-shrink: 0;
    display: inline-flex;
  }

  .desig {
    font-size: 10.5px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
    flex-shrink: 0;
    cursor: default;
    border-bottom: 1px dotted var(--color-line);
  }
  .desig-wrap:hover .desig,
  .desig:focus-visible {
    color: var(--color-ink);
    outline: none;
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
    border-radius: 3px;
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
    font-size: 11px;
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
    font-size: 12px;
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
    font-size: 12px;
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

  .status-badge {
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    padding: 2px 7px;
    border: 1px solid;
    border-radius: 2px;
    flex-shrink: 0;
  }

  .decom {
    flex-shrink: 0;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 2px;
    color: var(--color-faint);
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 2px 7px;
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

  .vp-body {
    position: relative;
    flex: 1;
    overflow: hidden;
  }

  /* faint amber scan line */
  .scan {
    position: absolute;
    left: 0;
    right: 0;
    height: 70px;
    background: linear-gradient(
      to bottom,
      transparent,
      color-mix(in srgb, var(--color-amber) 4%, transparent),
      transparent
    );
    pointer-events: none;
    z-index: 1;
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
    background: color-mix(in srgb, var(--color-bg, #070a09) 78%, transparent);
    backdrop-filter: blur(1.5px);
    border: 0;
    cursor: pointer;
    font: inherit;
    color: var(--color-ink);
  }
  .parked-icon {
    color: var(--color-amber);
    font-size: 22px;
    line-height: 1;
  }
  .parked-title {
    color: var(--color-ink-bright);
    letter-spacing: 0.08em;
    font-size: 13px;
  }
  .parked-sub {
    color: var(--color-muted);
    font-size: 11px;
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
    font-size: 15px;
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
    font-size: 11px;
    letter-spacing: 0.08em;
    padding: 4px 9px;
    cursor: pointer;
    flex-shrink: 0;
  }
  .back:hover {
    background: var(--color-hover);
  }
  /* amber accent: this jumps to a session that's actively waiting on the operator */
  .next-yu {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: transparent;
    border: 1px solid var(--color-amber);
    border-radius: 2px;
    color: var(--color-amber);
    font: inherit;
    font-size: 11px;
    letter-spacing: 0.08em;
    padding: 4px 9px;
    cursor: pointer;
    flex-shrink: 0;
    box-shadow: inset 0 0 18px -12px var(--color-amber);
  }
  .next-yu:hover {
    background: var(--color-hover);
  }
  .nyu-count {
    font-size: 10px;
    line-height: 1;
    min-width: 15px;
    text-align: center;
    padding: 2px 4px;
    border-radius: 999px;
    background: var(--color-amber);
    color: var(--color-bg);
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
    font-size: 15px;
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
    font-size: 11px;
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
  /* let the task name claim the free space instead of splitting it with the
     spacer; its flex-grow still pushes the status badge + decom to the right */
  .vp-head.mobile .spacer {
    display: none;
  }
  /* phone drops the task name (it moved to the top bar), so the spacer comes back
     to keep the status badge + decommission right-aligned */
  .vp-head.phone .spacer {
    display: block;
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
    font-size: 11px;
  }
  /* finger-sized header controls on touch layouts (≥40px) */
  .vp-head.mobile .back,
  .vp-head.mobile .next-yu,
  .vp-head.mobile .decom {
    min-height: 40px;
    padding: 8px 12px;
    font-size: 12px;
  }

  .tab-btn {
    background: transparent;
    border: 1px solid transparent;
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: 10.5px;
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

  .vp-foot {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 12px;
    background: var(--color-head);
    border-top: 1px solid var(--color-line);
    font-size: 11px;
    color: var(--color-muted);
    flex-shrink: 0;
  }

  .term-mount.dragging {
    outline: 2px dashed var(--color-amber);
    outline-offset: -4px;
  }
  .ctrl-row {
    display: flex;
    align-items: stretch;
    gap: 4px;
  }
  .ctrl-row .attach {
    flex: 0 0 auto;
    min-width: 44px;
    height: 40px;
    margin: 6px 0 6px 10px;
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    border-radius: 3px;
    color: var(--color-ink);
    font-size: 16px;
    cursor: pointer;
    touch-action: manipulation;
    user-select: none;
  }
  .ctrl-row .attach.failed {
    border-color: var(--color-red);
    color: var(--color-red);
  }
</style>
