<script lang="ts">
  import "@xterm/xterm/css/xterm.css";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import type { Session } from "$lib/types";
  import { elapsed, STATUS_COLOR, statusLabel } from "$lib/format";
  import { connectPty } from "$lib/pty";
  import TodoPanel from "$lib/components/TodoPanel.svelte";
  import IssuesPanel from "$lib/components/IssuesPanel.svelte";

  let {
    session,
    nowMs = Date.now(),
    onnewtask,
    onarchive,
  }: {
    session: Session;
    nowMs?: number;
    onnewtask?: (repoPath: string, prompt: string) => void;
    onarchive?: (id: string) => void;
  } = $props();

  let el: HTMLDivElement | undefined = $state();
  let tab = $state<"term" | "todo" | "issues">("term");

  // null model = claude's own default (shepherd passed no --model flag)
  const modelLabel = $derived(session.model ?? "default");

  // two-step decommission: first click arms, second (within 3s) fires; disarms on unit change
  let armed = $state(false);
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    session.id; // disarm when the selected unit changes
    armed = false;
    return () => clearTimeout(armTimer);
  });
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

  $effect(() => {
    const id = session.id;
    if (!el) return;

    const term = new Terminal({
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 12.5,
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

    const conn = connectPty(id, (d) => term.write(d), () => {});
    term.onData((d) => conn.send(d));

    const ro = new ResizeObserver(() => {
      fit.fit();
      conn.resize(term.cols, term.rows);
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      conn.close();
      term.dispose();
    };
  });
</script>

<div class="viewport">
  <!-- header -->
  <div class="vp-head">
    <span class="desig">{session.desig}</span>
    <span class="sep">·</span>
    <span class="branch">{session.branch ?? session.worktreePath}</span>
    <span class="sep">·</span>
    <span class="model">{modelLabel}</span>
    <div class="spacer"></div>
    <div class="tab-group">
      <button
        class="tab-btn"
        class:active={tab === "term"}
        onclick={() => (tab = "term")}
      >Terminal</button>
      <button
        class="tab-btn"
        class:active={tab === "todo"}
        onclick={() => (tab = "todo")}
      >To-Do</button>
      <button
        class="tab-btn"
        class:active={tab === "issues"}
        onclick={() => (tab = "issues")}
      >Issues</button>
    </div>
    <span class="sep">·</span>
    <span
      class="status-badge"
      style="color:{STATUS_COLOR[session.status]};border-color:{STATUS_COLOR[session.status]}"
    >
      {#if session.status === "running"}⠿{/if}
      {statusLabel(session.status)}
    </span>
    {#if session.status === "running"}
      <span class="elapsed">{elapsed(session.createdAt, nowMs)}</span>
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

  <!-- scan overlay + terminal (terminal stays mounted across tab switches) -->
  <div class="vp-body">
    <div class="scan" aria-hidden="true"></div>
    <div class="term-mount" bind:this={el} style:display={tab === "term" ? undefined : "none"}></div>
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
  }

  /* let xterm fill the mount */
  .term-mount :global(.xterm) {
    height: 100%;
  }

  .term-mount :global(.xterm-viewport) {
    overflow: hidden !important;
  }

  .tab-group {
    display: flex;
    gap: 2px;
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
    transition: color 0.12s, border-color 0.12s;
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
</style>
