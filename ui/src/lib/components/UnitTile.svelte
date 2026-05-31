<script lang="ts">
  import "@xterm/xterm/css/xterm.css";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import type { Session } from "$lib/types";
  import { STATUS_COLOR, statusLabel, elapsed } from "$lib/format";
  import { connectPty } from "$lib/pty";
  import { theme, xtermTheme } from "$lib/theme.svelte";

  let {
    session,
    selected = false,
    nowMs = Date.now(),
    onselect,
  }: {
    session: Session;
    selected?: boolean;
    nowMs?: number;
    onselect: (id: string) => void;
  } = $props();

  let el: HTMLDivElement | undefined = $state();
  let termRef = $state<Terminal | undefined>();

  // read-only live terminal: stream PTY output, never send input.
  // mirrors Viewport's xterm/fit/resize/teardown discipline minus input wiring
  // (no term.onData → send) and disableStdin.
  $effect(() => {
    const id = session.id;
    if (!el) return;

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
  style="--rule:{STATUS_COLOR[session.status]}"
  type="button"
  onclick={() => onselect(session.id)}
>
  <div class="t-head">
    <span class="desig">{session.desig}</span>
    <span class="name">{session.name}</span>
    <span class="spacer"></span>
    {#if session.status === "running"}
      <span class="elapsed">{elapsed(session.createdAt, nowMs)}</span>
    {/if}
    <span class="badge">{statusLabel(session.status)}</span>
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
    width: 2px;
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
  .desig {
    font-size: 10px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .name {
    color: var(--color-ink-bright);
    font-size: 12px;
    font-weight: 500;
    letter-spacing: 0.04em;
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
  .badge {
    font-size: 9px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    padding: 2px 6px;
    border: 1px solid var(--rule);
    color: var(--rule);
    border-radius: 2px;
    flex-shrink: 0;
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
