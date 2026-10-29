<script lang="ts">
  import type { HeavySlotSnapshot, Session } from "#lib/types.js";
  import { SvelteSet } from "svelte/reactivity";
  import { m } from "#lib/paraglide/messages.js";
  import { portal } from "#lib/portal.js";
  import { dialog } from "#lib/a11yDialog.js";
  import { swipeBack } from "../swipe-back";
  import {
    formatBytes,
    formatRuntime,
    memPressureBar,
    orderedWaiters,
    ramUsedPct,
    recentResults,
    resultView,
    shortRevision,
  } from "./heavy-slot";

  let {
    heavySlot,
    sessions = [],
    nowMs,
    onrelease,
    onsettings,
    onClose,
    variant = "anchored",
    el = $bindable(null),
  }: {
    heavySlot: HeavySlotSnapshot;
    sessions?: Pick<Session, "id" | "name">[];
    nowMs: number;
    onrelease: (sessionId: string) => Promise<void>;
    onsettings?: () => void;
    onClose: () => void;
    /** "anchored" drops from the desktop chip; "sheet" is the phone's full-screen dialog. */
    variant?: "anchored" | "sheet";
    el?: HTMLDivElement | null;
  } = $props();

  const resultLabel = {
    passed: () => m.heavyslot_result_passed(),
    failed: () => m.heavyslot_result_failed(),
    aborted: () => m.heavyslot_result_aborted(),
    stale: () => m.heavyslot_result_stale(),
  };
  let confirming = $state<string | null>(null);
  let releaseFailed = $state(false);
  // Rows whose command is shown in full (`h:<id>` holders, `r:<id>` results); collapsed by default.
  const expanded = new SvelteSet<string>();
  const toggle = (key: string) => (expanded.has(key) ? expanded.delete(key) : expanded.add(key));
  const nameOf = (id: string) =>
    sessions.find((s) => s.id === id)?.name ?? m.heavyslot_unknown_session();
  const bar = $derived(memPressureBar(heavySlot));
  const ram = $derived(ramUsedPct(heavySlot));
  const p = $derived(heavySlot.pressure);
  const src = $derived(heavySlot.memoryBySource);
  let showAllResults = $state(false);
  const results = $derived(recentResults(heavySlot, showAllResults));
  const anyStale = $derived(results.rows.some((r) => r.stale));
  const moreLabel = $derived(
    showAllResults
      ? m.heavyslot_results_show_fewer()
      : m.heavyslot_results_show_all({ n: heavySlot.lastResults.length }),
  );

  async function release(id: string) {
    releaseFailed = false;
    try {
      await onrelease(id);
      confirming = null;
    } catch {
      releaseFailed = true;
    }
  }

  // Phone sheet: a rightward swipe closes it, like Settings and the command bar (see swipeBack).
  let sheetX = $state(0); // rubber-banded display offset (px, ≥ 0)
  const sheetSwipe = swipeBack({ onback: () => onClose(), onoffset: (px) => (sheetX = px) });
</script>

{#snippet commandToggle(key: string, command: string, oneLine = false)}
  {@const open = expanded.has(key)}
  <button
    type="button"
    class="hp-cmd"
    class:open
    class:hp-cmd-1={oneLine}
    aria-expanded={open}
    title={open ? undefined : command}
    onclick={() => toggle(key)}
  >
    <span class="hp-chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
    <span class="sr-only"
      >{open ? m.heavyslot_command_collapse() : m.heavyslot_command_expand()}:
    </span>
    <span class="hp-cmd-text">{command}</span>
  </button>
{/snippet}

{#snippet body()}
  <header class="hp-head">
    <span class="hp-title">▤ {m.heavyslot_popover_title()}</span>
    <button type="button" class="hp-x" aria-label={m.heavyslot_close()} onclick={onClose}>×</button>
  </header>

  <section>
    <h3>{m.heavyslot_holders()}</h3>
    {#each heavySlot.holders as h, i (i)}
      <div class="hp-row">
        <span class="hp-name">{nameOf(h.sessionId)}</span>
        <span class="hp-dim hp-mono"
          >{formatRuntime(h.startedAt, nowMs)} · {formatBytes(h.rssBytes)}</span
        >
        {#if confirming === h.sessionId}
          <p class="hp-confirm">{m.heavyslot_release_confirm({ name: nameOf(h.sessionId) })}</p>
          <span class="hp-actions">
            <button type="button" class="hp-btn" onclick={() => void release(h.sessionId)}>
              {m.heavyslot_release_confirm_yes()}
            </button>
            <button type="button" class="hp-btn" onclick={() => (confirming = null)}>
              {m.heavyslot_release_cancel()}
            </button>
          </span>
          {#if releaseFailed}<p class="hp-err" role="alert">{m.heavyslot_release_failed()}</p>{/if}
        {:else}
          <button type="button" class="hp-btn" onclick={() => (confirming = h.sessionId)}>
            {m.heavyslot_release()}
          </button>
        {/if}
        {@render commandToggle(`h:${h.sessionId}`, h.command)}
      </div>
    {:else}
      <p class="hp-dim">{m.heavyslot_none_holding()}</p>
    {/each}
  </section>

  <section>
    <h3>{m.heavyslot_queue()}</h3>
    {#each orderedWaiters(heavySlot) as w (w.sessionId)}
      <div class="hp-row">
        <span class="hp-name">{w.position}. {nameOf(w.sessionId)}</span>
        <span class="hp-dim">
          {w.reason === "pressure"
            ? m.heavyslot_strip_wait_pressure({ n: w.position })
            : m.heavyslot_strip_wait({ n: w.position })}
        </span>
      </div>
    {:else}
      <p class="hp-dim">{m.heavyslot_queue_empty()}</p>
    {/each}
    {#if heavySlot.brake.active}<p class="hp-brake">{m.heavyslot_strip_brake()}</p>{/if}
  </section>

  <section>
    <h3>{m.heavyslot_pressure()}</h3>
    <dl class="hp-kv">
      <dt>{m.heavyslot_ram_row()}</dt>
      <dd>
        {ram == null ? "–" : `${ram} %`} · {formatBytes(p.ramAvailableBytes)} / {formatBytes(
          p.ramTotalBytes,
        )}
      </dd>
      <dt>{m.heavyslot_swap_row()}</dt>
      <dd>{formatBytes(p.swapUsedBytes)} / {formatBytes(p.swapTotalBytes)}</dd>
      <dt>{m.heavyslot_mem_psi()}</dt>
      <dd>
        {p.memFullAvg10 == null ? "–" : `${p.memFullAvg10} %`}
        {#if bar}
          <span class="hp-bar" aria-hidden="true">
            <span class="hp-fill" style:width="{bar.fill * 100}%"></span>
            <span class="hp-limit" style:left="{bar.limit * 100}%"></span>
          </span>
          <span class="hp-dim hp-sans"
            >{m.heavyslot_mem_psi_limit({ limit: p.memBrakeThreshold ?? 0 })}</span
          >
        {/if}
      </dd>
      <dt>{m.heavyslot_cpu_psi()}</dt>
      <dd>{p.cpuSomeAvg10 == null ? "–" : `${p.cpuSomeAvg10} %`}</dd>
    </dl>
  </section>

  <section>
    <h3>{m.heavyslot_source()}</h3>
    <dl class="hp-kv">
      <dt>{m.heavyslot_source_agents()}</dt>
      <dd>{formatBytes(src.agentsBytes)}</dd>
      <dt>{m.heavyslot_source_foreign()}</dt>
      <dd>{formatBytes(src.foreignBytes)}</dd>
      {#each src.foreignTop as f (f.name)}
        <dt class="hp-dim hp-mono">{f.name}</dt>
        <dd class="hp-dim">{formatBytes(f.bytes)}</dd>
      {/each}
    </dl>
  </section>

  {#if results.rows.length > 0}
    <section>
      <h3>{m.heavyslot_last_results()}</h3>
      {#if anyStale}
        <p class="hp-dim hp-note">{m.heavyslot_result_stale_hint()}</p>
      {/if}
      {#each results.rows as r (r.sessionId)}
        {@const view = resultView(r)}
        <div class="hp-row">
          <span class="hp-name">{nameOf(r.sessionId)}</span>
          <span class="hp-dim hp-mono">
            {shortRevision(r)}{r.exitCode == null ? "" : ` · exit ${r.exitCode}`}
          </span>
          <span class="hp-res hp-res-{view}">{resultLabel[view]()}</span>
          {@render commandToggle(`r:${r.sessionId}`, r.command, true)}
        </div>
      {/each}
      {#if results.hidden > 0 || showAllResults}
        <button
          type="button"
          class="hp-btn hp-more"
          aria-expanded={showAllResults}
          onclick={() => (showAllResults = !showAllResults)}
        >
          {moreLabel}
        </button>
      {/if}
    </section>
  {/if}

  {#if onsettings}
    <button type="button" class="hp-link" onclick={onsettings}
      >{m.heavyslot_settings_link()} →</button
    >
  {/if}
{/snippet}

{#if variant === "sheet"}
  <div class="hp-portal" use:portal>
    <div class="scrim" aria-hidden="true" onclick={onClose}></div>
    <div
      class="hp hp-sheet"
      class:swiping={sheetX > 0}
      style:transform={sheetX > 0 ? `translateX(${sheetX}px)` : undefined}
      role="dialog"
      aria-modal="true"
      aria-label={m.heavyslot_popover_title()}
      tabindex="-1"
      bind:this={el}
      use:dialog={{ onclose: onClose }}
      {@attach sheetSwipe}
    >
      {@render body()}
    </div>
  </div>
{:else}
  <div
    class="hp"
    role="dialog"
    aria-label={m.heavyslot_popover_title()}
    tabindex="-1"
    bind:this={el}
  >
    {@render body()}
  </div>
{/if}

<style>
  .hp {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 40;
    box-sizing: border-box;
    width: min(380px, calc(100vw - 32px));
    max-height: calc(100vh - 80px);
    overflow-y: auto;
    padding: 10px 12px;
    border: 1px solid var(--color-line);
    border-radius: var(--radius-chip);
    background: var(--color-panel);
    font-size: var(--fs-meta);
    color: var(--color-ink);
    text-align: left;
  }
  .hp-portal {
    position: fixed;
    inset: 0;
    z-index: 60;
  }
  /* Phone: a full-screen dialog in place of the anchored panel (the usage panel's pattern). */
  .hp.hp-sheet {
    position: fixed;
    inset: 0;
    z-index: 1;
    width: auto;
    max-height: none;
    border: 0;
    border-radius: 0;
    padding: calc(4px + env(safe-area-inset-top)) 16px calc(16px + env(safe-area-inset-bottom));
    font-size: var(--fs-base);
    transition: transform 0.18s ease-out;
  }
  /* Mid swipe-back: follows the finger 1:1, edge shadow over the uncovered page. */
  .hp.hp-sheet.swiping {
    transition: none;
    box-shadow: var(--shadow-popover);
  }
  .hp-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .hp-title,
  h3 {
    font-size: var(--fs-micro);
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--color-muted);
    font-weight: 400;
    margin: 10px 0 4px;
  }
  .hp-head .hp-title {
    margin: 0;
  }
  .hp-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 10px;
    padding: 3px 0;
  }
  .hp-name {
    color: var(--color-ink-bright);
    overflow-wrap: anywhere;
  }
  .hp-dim {
    color: var(--color-muted);
    margin: 0;
  }
  /* The command sits on its own full-width line under the row's name/meta, clamped (two lines for
     holders, one for results) so a heredoc pipeline can't push pressure below the fold; it toggles open. */
  .hp-cmd {
    order: 1;
    flex-basis: 100%;
    display: flex;
    align-items: flex-start;
    gap: 6px;
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: var(--radius-chip);
    background: transparent;
    color: var(--color-muted);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .hp-cmd:hover {
    color: var(--color-ink);
  }
  .hp-cmd:focus-visible {
    outline: 1px solid var(--color-amber);
  }
  /* no .sr-only util in app.css (same as CommandBar) */
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
  .hp-chev {
    flex-shrink: 0;
  }
  .hp-cmd-text {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    min-width: 0;
    overflow-wrap: anywhere;
    font-family: var(--font-mono);
  }
  .hp-cmd-1 .hp-cmd-text {
    -webkit-line-clamp: 1;
    line-clamp: 1;
  }
  .hp-cmd.open .hp-cmd-text {
    display: block;
    -webkit-line-clamp: unset;
    line-clamp: none;
    white-space: pre-wrap;
  }
  /* Commands, revisions, exit codes and byte/% readouts are mono; prose stays sans. */
  .hp-mono {
    font-family: var(--font-mono);
  }
  .hp-sans {
    font-family: var(--font-sans);
  }
  .hp-res {
    font-weight: 600;
  }
  .hp-res-passed {
    color: var(--color-green);
  }
  .hp-res-failed {
    color: var(--color-red);
  }
  .hp-res-stale,
  .hp-res-aborted {
    color: var(--color-muted);
  }
  .hp-brake,
  .hp-err {
    color: var(--color-red);
    margin: 4px 0 0;
  }
  .hp-note {
    margin-bottom: 4px;
  }
  .hp-more {
    margin-top: 4px;
  }
  .hp-confirm {
    flex-basis: 100%;
    margin: 2px 0;
  }
  /* Confirm prompt, its actions and hints follow the command line. */
  .hp-row > p,
  .hp-actions {
    order: 2;
  }
  .hp-actions {
    display: inline-flex;
    gap: 8px;
  }
  .hp-btn,
  .hp-x,
  .hp-link {
    min-height: 30px;
    padding: 0 8px;
    border: 1px solid var(--color-line);
    border-radius: var(--radius-chip);
    background: transparent;
    color: var(--color-ink);
    font: inherit;
    cursor: pointer;
  }
  .hp-x {
    border: 0;
    font-size: 16px;
  }
  .hp-link {
    margin-top: 10px;
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .hp-btn:hover,
  .hp-link:hover {
    background: color-mix(in srgb, var(--color-amber) 10%, transparent);
  }
  .hp-btn:focus-visible,
  .hp-x:focus-visible,
  .hp-link:focus-visible {
    outline: 1px solid var(--color-amber);
  }
  .hp-kv {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 3px 12px;
    margin: 0;
  }
  .hp-kv dd {
    margin: 0;
    font-family: var(--font-mono);
  }
  .hp-bar {
    position: relative;
    display: inline-block;
    width: 80px;
    height: 6px;
    margin: 0 6px;
    vertical-align: middle;
    background: color-mix(in srgb, var(--color-line) 60%, transparent);
  }
  .hp-fill {
    position: absolute;
    inset: 0 auto 0 0;
    background: var(--color-amber);
  }
  .hp-limit {
    position: absolute;
    top: -2px;
    bottom: -2px;
    width: 1px;
    background: var(--color-red);
  }
  @media (max-width: 768px), (pointer: coarse) {
    .hp-btn,
    .hp-x,
    .hp-link {
      min-height: 44px;
      min-width: 44px;
    }
  }
</style>
