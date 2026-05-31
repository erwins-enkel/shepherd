<script lang="ts">
  import "@xterm/xterm/css/xterm.css";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import type { Session, SessionUsage } from "$lib/types";
  import { elapsed, STATUS_COLOR, statusLabel, formatTokens } from "$lib/format";
  import { connectPty, type PtyConn } from "$lib/pty";
  import { getSessionUsage, uploadImage } from "$lib/api";
  import TodoPanel from "$lib/components/TodoPanel.svelte";
  import IssuesPanel from "$lib/components/IssuesPanel.svelte";
  import ControlBar from "$lib/components/ControlBar.svelte";
  import GitRail from "$lib/components/GitRail.svelte";

  let {
    session,
    nowMs = Date.now(),
    onnewtask,
    onarchive,
    onback,
    mobile = false,
    touch = false,
  }: {
    session: Session;
    nowMs?: number;
    onnewtask?: (repoPath: string, prompt: string) => void;
    onarchive?: (id: string) => void;
    onback?: () => void;
    mobile?: boolean;
    touch?: boolean;
  } = $props();

  let el: HTMLDivElement | undefined = $state();
  let tab = $state<"term" | "todo" | "issues">("term");
  let conn = $state<PtyConn | undefined>();
  let dragging = $state(false);
  let uploading = $state(false);
  let uploadFailed = $state(false);
  let fileInput = $state<HTMLInputElement>();

  // compact header: narrow mobile OR a touch device on the desktop layout (unfolded
  // foldables). Drops secondary fields + wraps so the decommission button never clips.
  const compact = $derived(mobile || touch);

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

  $effect(() => {
    const id = unitId;
    if (!el) return;

    const term = new Terminal({
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: mobile || touch ? 11 : 12.5,
      theme: {
        background: "#070a09",
        foreground: "#b9c7c1",
      },
      cursorBlink: true,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
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
        fit.fit();
        c.resize(term.cols, term.rows);
      },
    );
    conn = c;
    term.onData((d) => c.send(d));

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
      fit.fit();
      c.resize(term.cols, term.rows);
      // desktop: selecting a unit hands the keyboard straight to its terminal —
      // clicking a sidebar card otherwise leaves focus on the card button, so
      // typing goes nowhere. Mobile keeps tap-to-focus so the soft keyboard
      // doesn't pop open on every selection.
      if (!mobile && !touch && tab === "term") term.focus();
    });

    const ro = new ResizeObserver(() => {
      fit.fit();
      c.resize(term.cols, term.rows);
    });
    ro.observe(el);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onPageShow);
      el?.removeEventListener("click", onTap);
      el?.removeEventListener("touchstart", onTouchStart);
      el?.removeEventListener("touchmove", onTouchMove);
      el?.removeEventListener("touchend", onTouchEnd);
      ro.disconnect();
      c.close();
      conn = undefined;
      term.dispose();
    };
  });
</script>

<div class="viewport">
  <!-- header -->
  <div class="vp-head" class:mobile={compact}>
    {#if onback}
      <button class="back" type="button" onclick={onback} aria-label="Back to herd">‹ Herd</button>
    {/if}
    <span class="desig">{session.desig}</span>
    {#if !compact}
      <span class="sep">·</span>
      <span class="branch">{session.branch ?? session.worktreePath}</span>
      <span class="sep">·</span>
      <span class="model">{modelLabel}</span>
    {/if}
    {#if usage && usage.total > 0}
      <span class="sep">·</span>
      <span
        class="tokens"
        title="{usage.input.toLocaleString()} in · {usage.output.toLocaleString()} out · {usage.cacheRead.toLocaleString()} cache read · {usage.cacheWrite.toLocaleString()} cache write"
        >{formatTokens(usage.total)} tok</span
      >
    {/if}
    <div class="spacer"></div>
    <div class="tab-group" class:mobile={compact}>
      <button class="tab-btn" class:active={tab === "term"} onclick={() => (tab = "term")}
        >Terminal</button
      >
      <button class="tab-btn" class:active={tab === "todo"} onclick={() => (tab = "todo")}
        >To-Do</button
      >
      <button class="tab-btn" class:active={tab === "issues"} onclick={() => (tab = "issues")}
        >Issues</button
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
    {#if session.status === "running" && !compact}
      <span class="elapsed">{elapsed(session.createdAt, nowMs)}</span>
    {/if}
    {#if !compact}
      <GitRail sessionId={session.id} name={session.name} prompt={session.prompt} />
    {/if}
    <button
      class="decom"
      class:armed
      type="button"
      onclick={decommission}
      title="stop agent + remove worktree"
    >
      {armed ? "confirm ✕" : "✕ decommission"}
    </button>
  </div>

  <!-- compact layouts (mobile + unfolded fold) get the git rail its own strip,
       since the wrapping header has no room for it -->
  {#if compact}
    <div class="vp-git-strip">
      <GitRail sessionId={session.id} name={session.name} prompt={session.prompt} mobile />
    </div>
  {/if}

  <!-- scan overlay + terminal (terminal stays mounted across tab switches) -->
  <div class="vp-body">
    <div class="scan" aria-hidden="true"></div>
    <div
      class="term-mount"
      class:dragging
      role="region"
      aria-label="Terminal"
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
  </div>

  <!-- control-key bar: any touch device (incl. unfolded foldables wider than the
       mobile breakpoint) gets it, since there's no hardware keyboard to steer with -->
  {#if (mobile || touch) && tab === "term"}
    <div class="ctrl-row">
      <button
        type="button"
        class="attach"
        class:failed={uploadFailed}
        title={uploadFailed ? "Upload failed — tap to retry" : "Attach image"}
        onpointerdown={(e) => {
          e.preventDefault();
          fileInput?.click();
        }}
        aria-label="Attach image"
      >
        {uploading ? "⏳" : uploadFailed ? "⚠" : "📎"}
      </button>
      <ControlBar onkey={(seq) => conn?.send(seq)} />
    </div>
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

  <!-- footer -->
  <div class="vp-foot">
    <span>⌁ type to steer</span>
    <span class="sep">·</span>
    <span>⇥ detach</span>
  </div>
</div>

<style>
  .viewport {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: #070a09;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    overflow: hidden;
  }

  .vp-head {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 6px 12px;
    background: #0a0f0d;
    border-bottom: 1px solid var(--color-line);
    font-size: 11.5px;
    flex-shrink: 0;
    white-space: nowrap;
    overflow: hidden;
  }

  .desig {
    font-size: 10.5px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }

  .branch {
    color: var(--color-ink);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 22ch;
  }

  .model {
    color: var(--color-muted);
    font-size: 11px;
    letter-spacing: 0.06em;
  }

  .tokens {
    color: var(--color-ink);
    font-size: 11px;
    letter-spacing: 0.04em;
    font-variant-numeric: tabular-nums;
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

  .elapsed {
    color: var(--color-ink);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.08em;
    font-size: 11px;
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
    background: #0c1110;
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
    background: #0a0f0d;
    border-bottom: 1px solid var(--color-line);
    flex-shrink: 0;
    min-height: 44px;
  }

  .vp-head.mobile {
    flex-wrap: wrap;
    row-gap: 6px;
    padding: 8px 10px;
  }
  .tab-group.mobile {
    order: 10;
    flex-basis: 100%;
    gap: 4px;
  }
  .vp-head.mobile .tab-btn {
    flex: 1;
    text-align: center;
    padding: 8px 6px;
    font-size: 11px;
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
    background: #0a0f0d;
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
    height: 36px;
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
