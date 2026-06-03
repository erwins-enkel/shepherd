<script lang="ts">
  import "@xterm/xterm/css/xterm.css";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import type { Session, GitState } from "$lib/types";
  import { STATUS_COLOR, statusLabel, elapsed, hideStatusBadge } from "$lib/format";
  import { connectPty } from "$lib/pty";
  import { theme, xtermTheme } from "$lib/theme.svelte";
  import PrBadge from "./PrBadge.svelte";
  import CriticBadge from "./CriticBadge.svelte";
  import { reviews } from "$lib/reviews.svelte";
  import { m } from "$lib/paraglide/messages";
  import AutopilotBadge from "./AutopilotBadge.svelte";
  import AutoPip from "./AutoPip.svelte";

  let {
    session,
    selected = false,
    nowMs = Date.now(),
    onselect,
    git,
  }: {
    session: Session;
    selected?: boolean;
    nowMs?: number;
    onselect: (id: string) => void;
    git?: GitState;
  } = $props();

  const hideStatus = $derived(hideStatusBadge(session.status, reviews.isReviewing(session.id)));

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
</script>

<button
  class="tile"
  class:sel={selected}
  style="--rule:{session.readyToMerge ? 'var(--color-green)' : STATUS_COLOR[session.status]}"
  type="button"
  onclick={() => onselect(session.id)}
>
  <div class="t-head">
    <span class="name">{session.name}</span>
    <span class="spacer"></span>
    {#if session.status === "running"}
      <span class="elapsed">{elapsed(session.createdAt, nowMs)}</span>
    {/if}
    <PrBadge {git} />
    <CriticBadge sessionId={session.id} />
    <AutopilotBadge {session} />
    <AutoPip {session} />
    {#if session.readyToMerge}
      <span class="badge">{m.status_ready_to_merge()}</span>
    {:else if !hideStatus}
      <span class="badge" class:alert={session.status === "blocked"}
        >{statusLabel(session.status)}</span
      >
    {/if}
    <span class="desig">{session.desig}</span>
  </div>
  <div class="t-body">
    <div class="t-mount" bind:this={el}></div>
  </div>
</button>

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
    font-size: 9.5px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-faint);
    flex-shrink: 0;
  }
  .name {
    color: var(--color-ink-bright);
    font-size: 12px;
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
    font-size: 10.5px;
  }
  /* Quiet muted text, not a colored pill — the stripe (left) already encodes
     status by hue, so an outlined `--rule`-tinted badge here triple-stacked the
     same color. Matches UnitRow's demoted badge. */
  .badge {
    font-size: 9px;
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
