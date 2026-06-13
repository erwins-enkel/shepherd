<script lang="ts">
  import "@xterm/xterm/css/xterm.css";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import type { Session, GitState, SessionActivity } from "$lib/types";
  import {
    STATUS_COLOR,
    statusLabel,
    elapsed,
    hideStatusBadge,
    autopilotBadgeShown,
    canResume,
    canRelaunch,
  } from "$lib/format";
  import { onDestroy } from "svelte";
  import { displayStatus } from "$lib/display-status";
  import { connectPty } from "$lib/pty";
  import { resumeSession } from "$lib/api";
  import { theme, xtermTheme } from "$lib/theme.svelte";
  import CardMenu from "./CardMenu.svelte";
  import { longPress } from "./longpress";
  import PrBadge from "./PrBadge.svelte";
  import TimePopover from "./TimePopover.svelte";
  import CriticBadge from "./CriticBadge.svelte";
  import { reviews } from "$lib/reviews.svelte";
  import { toasts } from "$lib/toasts.svelte";
  import { m } from "$lib/paraglide/messages";
  import AutopilotBadge from "./AutopilotBadge.svelte";
  import PlanGateBadge from "./PlanGateBadge.svelte";
  import ResearchBadge from "./ResearchBadge.svelte";
  import AutoPip from "./AutoPip.svelte";

  let {
    session,
    selected = false,
    nowMs = Date.now(),
    onselect,
    git,
    activity,
    onrelaunch,
    onrelaunchElsewhere,
    workingBlocked = {},
  }: {
    session: Session;
    selected?: boolean;
    nowMs?: number;
    onselect: (id: string) => void;
    git?: GitState;
    // live per-session signal (heartbeat ts); feeds the TimePopover's last-activity line
    activity?: SessionActivity;
    // when provided, the right-click / long-press CardMenu gains a two-step armed
    // Relaunch action (spawns a fresh replacement + decommissions this session)
    onrelaunch?: (id: string) => void;
    // when provided, the CardMenu gains a one-click "Relaunch elsewhere" item that
    // opens the new-task composer pre-filled from this session (cross-repo relaunch)
    onrelaunchElsewhere?: (id: string) => void;
    // working-while-blocked display flags (whole store map); feeds displayStatus only
    workingBlocked?: Record<string, boolean>;
  } = $props();

  // Display branches read this, not session.status: a working-while-blocked
  // session gets the full working treatment. canResume stays on the raw status.
  const dStatus = $derived(displayStatus(session, workingBlocked));

  const reviewing = $derived(reviews.isReviewing(session.id));
  const autopilotShown = $derived(autopilotBadgeShown(session));
  const hideStatus = $derived(hideStatusBadge(dStatus, reviewing, autopilotShown));

  // A status badge renders for ready / a non-hidden status; only then does
  // #tile-status-{id} exist. Build the overlay's aria-describedby so it omits
  // that id when no badge renders (reviewing && done/idle) — no dangling IDREF.
  const describedBy = $derived(
    [
      session.readyToMerge || !hideStatus ? `tile-status-${session.id}` : null,
      `tile-desig-${session.id}`,
    ]
      .filter(Boolean)
      .join(" "),
  );

  let el: HTMLDivElement | undefined = $state();
  let termRef = $state<Terminal | undefined>();

  // Defer the heavy Terminal + PTY socket until the tile first scrolls into
  // view: a large herd would otherwise spin up N canvases + WebSockets at once.
  // One-shot — once visible we keep the terminal mounted (no teardown on
  // scroll-away) to avoid buffer loss / reconnect churn.
  let visible = $state(false);
  $effect(() => {
    if (!el || visible) return;
    // No IntersectionObserver (older/edge runtimes) → show eagerly, as before.
    if (typeof IntersectionObserver === "undefined") {
      visible = true;
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          visible = true;
          io.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  });

  // read-only live terminal: stream PTY output, never send input.
  // mirrors Viewport's xterm/fit/resize/teardown discipline minus input wiring
  // (no term.onData → send) and disableStdin.
  $effect(() => {
    const id = session.id;
    if (!el || !visible) return;

    const initialTheme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 10,
      disableStdin: true,
      cursorBlink: false,
      theme: xtermTheme(initialTheme),
    });
    termRef = term;

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();

    const c = connectPty(
      id,
      term.cols,
      term.rows,
      (d) => term.write(d),
      // reconnected (e.g. waking from a backgrounded tab): refit + repaint
      () => {
        fit.fit();
        c.resize(term.cols, term.rows);
      },
    );
    // intentionally no term.onData → send: tiles are read-only monitors

    const raf = requestAnimationFrame(() => {
      fit.fit();
      c.resize(term.cols, term.rows);
    });

    const ro = new ResizeObserver(() => {
      fit.fit();
      c.resize(term.cols, term.rows);
    });
    ro.observe(el);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      c.close();
      termRef = undefined;
      term.dispose();
    };
  });

  // repaint the read-only tile terminal when the active theme changes
  $effect(() => {
    const resolved = theme.resolved;
    const term = termRef;
    if (!term) return;
    term.options.theme = xtermTheme(resolved);
    term.refresh(0, Math.max(0, term.rows - 1));
  });

  // Right-click / long-press → a small action menu. On a tile only Resume applies
  // (decommission isn't wired into the grid view); skip the menu otherwise.
  // Deliberately NOT liveness-gated (no claudeAlive arg, unlike the Viewport
  // header): the menu only opens on an explicit gesture, so it doesn't add bar
  // noise — and it stays the force-resume escape hatch should the /proc sweep
  // ever misreport a session as alive.
  const resumable = $derived(canResume(session));
  // Relaunch only for an in-flight task (see canRelaunch) AND only when wired — never on
  // a concluded/merged record, where it would spawn a duplicate and tear down the row.
  const relaunchable = $derived(!!onrelaunch && canRelaunch(session, git, nowMs));
  // Relaunch-elsewhere reuses the same eligibility as Relaunch, just routed to the
  // cross-repo composer instead of the in-place two-step arm.
  const relaunchElsewhereAble = $derived(!!onrelaunchElsewhere && canRelaunch(session, git, nowMs));
  let hitEl = $state<HTMLButtonElement>();
  let elapsedEl = $state<HTMLSpanElement>();
  let menu = $state<{ x: number; y: number; opener: HTMLElement } | null>(null);
  function openMenuAt(x: number, y: number): boolean {
    if (menu || (!resumable && !relaunchable && !relaunchElsewhereAble)) return false;
    menu = { x, y, opener: hitEl! };
    return true;
  }
  function onContextMenu(e: MouseEvent) {
    if (!resumable && !relaunchable && !relaunchElsewhereAble) return; // nothing to offer → leave the native menu
    e.preventDefault();
    openMenuAt(e.clientX, e.clientY);
  }
  async function resumeFromMenu() {
    menu = null;
    onselect(session.id); // focus it so the rebuilt terminal lands in the viewport
    try {
      await resumeSession(session.id, true);
    } catch {
      toasts.info(m.cardmenu_resume_failed({ name: session.name }));
    }
  }
  function relaunchFromMenu() {
    menu = null;
    onrelaunch?.(session.id);
  }
  function relaunchElsewhereFromMenu() {
    menu = null;
    onrelaunchElsewhere?.(session.id);
  }

  // Time-breakdown popover: the .tile-hit overlay is the tile's only click/
  // keyboard surface, but its mouse trigger is bounds-gated to the wall-clock
  // (.elapsed) — onHitMove latches when the cursor enters/leaves the clock's
  // rect, arming the 450ms hover-intent once on enter (not on every move) so
  // sweeping the cursor across the grid doesn't cascade popovers. Keyboard focus
  // on the card still reveals it immediately; the popover anchors to the clock.
  // The clock rect is measured once on card-enter and cached so the per-move
  // bounds test never reads layout; bounded staleness is fine (the clock barely
  // shifts during a hover, the popover anchors off a fresh read in tipShow, and
  // it closes on scroll/resize).
  let tipRect = $state<DOMRect | null>(null);
  let tipTimer: ReturnType<typeof setTimeout> | undefined;
  let overClock = false; // pointer currently within the cached clock bounds
  let clockRect: DOMRect | null = null; // wall-clock bounds, cached on card-enter
  function tipShow(delay = 450) {
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => (tipRect = elapsedEl?.getBoundingClientRect() ?? null), delay);
  }
  function tipHide() {
    clearTimeout(tipTimer);
    tipRect = null;
    overClock = false;
  }
  function onHitEnter() {
    clockRect = elapsedEl?.getBoundingClientRect() ?? null;
  }
  function onHitMove(e: MouseEvent) {
    const r = clockRect;
    const inside =
      !!r &&
      e.clientX >= r.left &&
      e.clientX <= r.right &&
      e.clientY >= r.top &&
      e.clientY <= r.bottom;
    if (inside === overClock) return;
    overClock = inside;
    if (inside) tipShow();
    else tipHide();
  }
  onDestroy(() => clearTimeout(tipTimer));
</script>

<div
  class="tile"
  class:sel={selected}
  style="--rule:{session.readyToMerge ? 'var(--color-green)' : STATUS_COLOR[dStatus]}"
>
  <button
    bind:this={hitEl}
    class="tile-hit"
    type="button"
    aria-label={m.unit_open_aria({ name: session.name })}
    aria-describedby={describedBy}
    onclick={() => {
      tipHide();
      onselect(session.id);
    }}
    oncontextmenu={(e) => {
      tipHide();
      onContextMenu(e);
    }}
    onmouseenter={onHitEnter}
    onmousemove={onHitMove}
    onmouseleave={tipHide}
    onfocus={() => {
      if (hitEl?.matches(":focus-visible")) tipShow(0);
    }}
    onblur={tipHide}
    onkeydown={(e) => {
      if (e.key === "Escape" && tipRect) tipHide();
    }}
    use:longPress={{ onTrigger: openMenuAt }}
  ></button>
  <div class="t-head">
    <span class="name">{session.name}</span>
    <span class="spacer"></span>
    {#if dStatus === "running"}
      <span class="elapsed" bind:this={elapsedEl}>{elapsed(session.createdAt, nowMs)}</span>
    {/if}
    <ResearchBadge {session} />
    <PrBadge {git} />
    <CriticBadge sessionId={session.id} />
    <PlanGateBadge {session} />
    <!-- REVIEWING (in-flight critic) outranks the autopilot badge -->
    {#if !reviewing}<AutopilotBadge {session} />{/if}
    <AutoPip {session} />
    {#if session.readyToMerge}
      <span class="badge" id="tile-status-{session.id}">{m.status_ready_to_merge()}</span>
    {:else if !hideStatus}
      <span class="badge" class:alert={dStatus === "blocked"} id="tile-status-{session.id}"
        >{statusLabel(dStatus)}</span
      >
    {/if}
    <span class="desig" id="tile-desig-{session.id}">{session.desig}</span>
  </div>
  <div class="t-body">
    <div class="t-mount" bind:this={el}></div>
  </div>
</div>

{#if menu}
  <CardMenu
    x={menu.x}
    y={menu.y}
    {resumable}
    opener={menu.opener}
    onresume={resumeFromMenu}
    onrelaunch={relaunchable ? relaunchFromMenu : undefined}
    onrelaunchElsewhere={relaunchElsewhereAble ? relaunchElsewhereFromMenu : undefined}
    onclose={() => (menu = null)}
  />
{/if}

{#if tipRect && !menu}
  <TimePopover
    {session}
    {git}
    {activity}
    {nowMs}
    working={dStatus === "running"}
    anchorRect={tipRect}
    onclose={tipHide}
  />
{/if}

<style>
  .tile {
    position: relative;
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 240px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    background: var(--color-inset);
    padding: 0;
    cursor: pointer;
    color: inherit;
    font: inherit;
    text-align: left;
    overflow: hidden;
  }
  .tile::before {
    content: "";
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 1px;
    background: var(--rule, var(--color-faint));
    z-index: 2;
    pointer-events: none;
  }
  /* Transparent overlay that IS the tile's click/keyboard target — keeps the
     card a <div> so the interactive PlanGate badge can sit as a sibling instead
     of an (invalid) nested <button>. */
  .tile-hit {
    position: absolute;
    inset: 0;
    z-index: 0;
    width: 100%;
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: pointer;
    border-radius: inherit;
    font: inherit;
    color: inherit;
    /* long-press opens the card menu — suppress iOS's callout gesture */
    -webkit-touch-callout: none;
    user-select: none;
  }
  .tile-hit:focus-visible {
    outline: 1.5px solid var(--color-line-bright);
    outline-offset: -1.5px;
  }
  /* Raise the interactive badge above the overlay so it's clickable. */
  .t-head > :global(button),
  .t-head > :global([role="button"]) {
    position: relative;
    z-index: 1;
  }
  .tile:hover {
    border-color: var(--color-line-bright);
  }
  .tile.sel {
    border-color: var(--color-line-bright);
    box-shadow: inset 0 0 0 1px var(--color-line-bright);
  }

  .t-head {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 6px 10px;
    background: var(--color-head);
    border-bottom: 1px solid var(--color-line);
    flex-shrink: 0;
    white-space: nowrap;
    overflow: hidden;
  }
  /* designation is metadata: demoted to the end of the header, quietest tone */
  .desig {
    font-size: var(--fs-micro);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-faint);
    flex-shrink: 0;
  }
  .name {
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
    font-weight: 500;
    letter-spacing: 0.04em;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .spacer {
    flex: 1;
  }
  .elapsed {
    color: var(--color-ink);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.08em;
    font-size: var(--fs-meta);
  }
  /* Quiet muted text, not a colored pill — the stripe (left) already encodes
     status by hue, so an outlined `--rule`-tinted badge here triple-stacked the
     same color. Matches UnitRow's demoted badge. */
  .badge {
    font-size: var(--fs-micro);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-muted);
    flex-shrink: 0;
  }
  /* Blocked is the one state allowed to stay loud ("the loudest thing on
     screen"). The tile has no pip, so unlike the calm states the blocked badge
     keeps a small red chip so it grabs attention in the grid. */
  .badge.alert {
    color: var(--color-red);
    background: color-mix(in oklab, var(--color-red) 12%, transparent);
    padding: 1px 5px;
    border-radius: 2px;
  }

  .t-body {
    position: relative;
    flex: 1;
    overflow: hidden;
    /* The read-only monitor terminal is positioned (relative), so without this
       it would paint above the .tile-hit overlay (same stack level, later in
       source) and swallow body clicks. Let clicks fall through to the overlay so
       the whole tile selects; the terminal needs no pointer interaction. */
    pointer-events: none;
  }
  .t-mount {
    position: absolute;
    inset: 0;
    overflow: hidden;
  }
  .t-mount :global(.xterm) {
    height: 100%;
  }
</style>
