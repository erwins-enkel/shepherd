<script lang="ts">
  import type { HeavySlotSnapshot, Session } from "#lib/types.js";
  import { SvelteSet } from "svelte/reactivity";
  import { m } from "#lib/paraglide/messages.js";
  import StartQueueSection from "./StartQueueSection.svelte";
  import {
    brakeLine,
    commandLabel,
    formatBytes,
    formatRuntime,
    holderState,
    memPressureBar,
    orderedWaiters,
    ramUsedPct,
    recentResults,
    resultView,
    shortRevision,
  } from "./heavy-slot";

  // One check slot's sections in the host popover: who holds it, the queue, waiting starts,
  // pressure, memory by origin and the last results.
  let {
    heavySlot,
    own = true,
    folded = false,
    sessions = [],
    nowMs,
    onrelease,
  }: {
    heavySlot: HeavySlotSnapshot;
    /** This Shepherd's slot: the only one a release reaches. */
    own?: boolean;
    /** One machine among several: pressure and results sit behind a one-line summary each. */
    folded?: boolean;
    sessions?: Pick<Session, "id" | "name">[];
    nowMs: number;
    onrelease: (sessionId: string) => Promise<void>;
  } = $props();

  const resultLabel = {
    passed: () => m.heavyslot_result_passed(),
    failed: () => m.heavyslot_result_failed(),
    aborted: () => m.heavyslot_result_aborted(),
    stale: () => m.heavyslot_result_stale(),
  };
  let confirming = $state<string | null>(null);
  let releaseFailed = $state(false);
  // Open rows and sections, all collapsed by default: `h:<id>` holder and `r:<id>` result commands
  // shown in full, `all` every result, `pressure` / `results` the folded details.
  const expanded = new SvelteSet<string>();
  const toggle = (key: string) => (expanded.has(key) ? expanded.delete(key) : expanded.add(key));
  const nameOf = (id: string) =>
    sessions.find((s) => s.id === id)?.name ?? m.heavyslot_unknown_session();
  /** What a holder that isn't simply running is doing with its slot (#3631); empty when running. */
  const stateLabel = (h: HeavySlotSnapshot["holders"][number]) => {
    const state = holderState(h);
    if (state === "lingering") return m.heavyslot_state_lingering();
    return state === "offered" ? m.heavyslot_state_offered() : "";
  };
  const bar = $derived(memPressureBar(heavySlot));
  const ram = $derived(ramUsedPct(heavySlot));
  const p = $derived(heavySlot.pressure);
  const src = $derived(heavySlot.memoryBySource);
  const brake = $derived(brakeLine(heavySlot));
  // The brake let go and waiting starts follow one by one: amber, no longer red.
  const pacing = $derived(!heavySlot.brake.active);
  const showAllResults = $derived(expanded.has("all"));
  const results = $derived(recentResults(heavySlot, showAllResults));
  const anyStale = $derived(results.rows.some((r) => r.stale));
  const moreLabel = $derived(
    showAllResults
      ? m.heavyslot_results_show_fewer()
      : m.heavyslot_results_show_all({ n: heavySlot.lastResults.length }),
  );
  const pressureOpen = $derived(!folded || expanded.has("pressure"));
  const hasResults = $derived(results.rows.length > 0);
  const resultsOpen = $derived(hasResults && (!folded || expanded.has("results")));
  const ramSummary = $derived(ram == null ? "–" : m.heavyslot_ram({ pct: ram }));

  async function release(id: string) {
    releaseFailed = false;
    try {
      await onrelease(id);
      confirming = null;
    } catch {
      releaseFailed = true;
    }
  }
</script>

{#snippet commandToggle(key: string, command: string)}
  {@const open = expanded.has(key)}
  <button
    type="button"
    class="hp-cmd"
    class:open
    aria-expanded={open}
    title={open ? undefined : command}
    onclick={() => toggle(key)}
  >
    <span class="hp-chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
    <span class="sr-only"
      >{open ? m.heavyslot_command_collapse() : m.heavyslot_command_expand()}:
    </span>
    <span class="hp-cmd-text">{open ? command : commandLabel(command)}</span>
  </button>
{/snippet}

{#snippet fold(key: string, open: boolean, label: string, summary: string)}
  <button type="button" class="hp-fold" aria-expanded={open} onclick={() => toggle(key)}>
    <span class="hp-chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
    <span class="hp-fold-label">{label}</span>
    <span class="hp-fold-sum">{summary}</span>
  </button>
{/snippet}

<section>
  <h3>{m.heavyslot_holders()}</h3>
  {#each heavySlot.holders as h, i (i)}
    <div class="hp-row">
      <span class="hp-name">{nameOf(h.sessionId)}</span>
      <span class="hp-dim hp-state">{stateLabel(h)}</span>
      <span class="hp-dim hp-mono"
        >{formatRuntime(h.startedAt, nowMs)} · {formatBytes(h.rssBytes)}</span
      >
      <!-- Another machine's slot gets no release: none reaches it from here. -->
      {#if own && confirming === h.sessionId}
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
      {:else if own}
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
  {#if brake}
    <p class="hp-brake" class:hp-pacing={pacing}>{brake}</p>
  {/if}
</section>

<StartQueueSection starts={heavySlot.startQueue} />

{#if folded}
  {@render fold("pressure", pressureOpen, m.heavyslot_pressure_memory(), ramSummary)}
{/if}
{#if pressureOpen}
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
{/if}

{#if folded && hasResults}
  {@render fold(
    "results",
    resultsOpen,
    m.heavyslot_last_results_count({ n: heavySlot.lastResults.length }),
    "",
  )}
{/if}
{#if resultsOpen}
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
        {@render commandToggle(`r:${r.sessionId}`, r.command)}
      </div>
    {/each}
    {#if results.hidden > 0 || showAllResults}
      <button
        type="button"
        class="hp-btn hp-more"
        aria-expanded={showAllResults}
        onclick={() => toggle("all")}
      >
        {moreLabel}
      </button>
    {/if}
  </section>
{/if}

<style>
  h3 {
    font-size: var(--fs-micro);
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--color-muted);
    font-weight: 400;
    margin: 10px 0 4px;
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
  /* A plainly running holder has no state label; keep the row's gap from showing it. */
  .hp-state:empty {
    display: none;
  }
  /* The command sits on its own full-width line under the row's name/meta: collapsed it is its first
     step (commandLabel) on one line, so a heredoc pipeline can't push pressure below the fold; it
     toggles open to the full text. */
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
    -webkit-line-clamp: 1;
    line-clamp: 1;
    overflow: hidden;
    min-width: 0;
    overflow-wrap: anywhere;
    font-family: var(--font-mono);
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
  /* Brake let go, waiting starts follow one by one: still waiting, no longer red. */
  .hp-brake.hp-pacing {
    color: var(--color-amber);
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
  .hp-btn {
    min-height: 30px;
    padding: 0 8px;
    border: 1px solid var(--color-line);
    border-radius: var(--radius-chip);
    background: transparent;
    color: var(--color-ink);
    font: inherit;
    cursor: pointer;
  }
  .hp-btn:hover {
    background: color-mix(in srgb, var(--color-amber) 10%, transparent);
  }
  .hp-btn:focus-visible {
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
  /* A machine among several: pressure and results fold behind a one-line summary each. */
  .hp-fold {
    display: flex;
    align-items: baseline;
    gap: 8px;
    width: 100%;
    margin: 8px 0 0;
    padding: 4px 0 0;
    border: 0;
    border-top: 1px dashed var(--color-line);
    background: transparent;
    color: var(--color-muted);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .hp-fold:hover {
    color: var(--color-ink);
  }
  .hp-fold:focus-visible {
    outline: 1px solid var(--color-amber);
  }
  .hp-fold-label {
    font-size: var(--fs-micro);
    letter-spacing: 0.16em;
    text-transform: uppercase;
  }
  .hp-fold-sum {
    margin-left: auto;
    font-family: var(--font-mono);
    color: var(--color-ink);
  }
  @media (max-width: 768px), (pointer: coarse) {
    .hp-btn {
      min-height: 44px;
      min-width: 44px;
    }
  }
</style>
