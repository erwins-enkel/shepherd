<script lang="ts">
  import type { HeavySlotSnapshot, Session } from "#lib/types.js";
  import { SvelteSet } from "svelte/reactivity";
  import { m } from "#lib/paraglide/messages.js";
  import StartQueueSection from "./StartQueueSection.svelte";
  import SlotGauges from "./SlotGauges.svelte";
  import SlotPips from "./SlotPips.svelte";
  import SlotStatus from "./SlotStatus.svelte";
  import {
    brakeLine,
    commandLabel,
    formatBytes,
    formatRuntime,
    holderState,
    orderedWaiters,
    ramGauge,
    recentResults,
    resultView,
    shortRevision,
    slotCells,
  } from "./heavy-slot";

  // One check slot's sections in the host popover: whether a check can start now, its slots, the
  // queue, waiting starts, RAM and pressure against the brake, memory by origin and the last
  // results.
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
  const cells = $derived(slotCells(heavySlot));
  const ram = $derived(ramGauge(heavySlot));
  // The status above already says the brake holds; under the queue only the waiting starts that
  // follow one by one once it let go.
  const pacingLine = $derived(heavySlot.brake.active ? null : brakeLine(heavySlot));
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
  const ramSummary = $derived(
    ram == null ? "–" : m.heavyslot_ram_free({ bytes: formatBytes(ram.freeBytes) }),
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
</script>

{#snippet commandToggle(key: string, command: string)}
  {@const open = expanded.has(key)}
  {@const text = open ? command : commandLabel(command)}
  <button
    type="button"
    class="hp-cmd"
    class:open
    aria-expanded={open}
    aria-label="{open ? m.heavyslot_command_collapse() : m.heavyslot_command_expand()}: {text}"
    title={open ? undefined : command}
    onclick={() => toggle(key)}
  >
    <span class="hp-chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
    <span class="hp-cmd-text">{text}</span>
  </button>
{/snippet}

{#snippet fold(key: string, open: boolean, label: string, summary: string)}
  <button type="button" class="hp-fold" aria-expanded={open} onclick={() => toggle(key)}>
    <span class="hp-chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
    <span class="hp-fold-label">{label}</span>
    <span class="hp-fold-sum">{summary}</span>
  </button>
{/snippet}

<SlotStatus {heavySlot} {nowMs} />

<section>
  <div class="hp-sec-head">
    <h3>{m.heavyslot_slots()}</h3>
    <span class="hp-push hp-dim hp-mono"
      >{m.settings_machines_slot_held({
        held: heavySlot.holders.length,
        capacity: heavySlot.capacity,
      })}</span
    >
  </div>
  <div class="hp-cells">
    {#each cells as cell, i (i)}
      {#if cell.kind === "held"}
        {@const h = cell.holder}
        <div class="hp-cell hp-cell-held hp-row">
          <SlotPips kinds={["held"]} />
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
            {#if releaseFailed}<p class="hp-err" role="alert">
                {m.heavyslot_release_failed()}
              </p>{/if}
          {:else if own}
            <button type="button" class="hp-btn" onclick={() => (confirming = h.sessionId)}>
              {m.heavyslot_release()}
            </button>
          {/if}
          {@render commandToggle(`h:${h.sessionId}`, h.command)}
        </div>
      {:else}
        <div class="hp-cell hp-cell-{cell.kind}">
          <SlotPips kinds={[cell.kind]} />
          <span class="hp-cell-text">
            <span class="hp-name">{m.heavyslot_slot_free({ n: cell.n })}</span>
            <span class="hp-cell-sub"
              >{cell.kind === "free" ? m.heavyslot_slot_ready() : m.heavyslot_slot_blocked()}</span
            >
          </span>
        </div>
      {/if}
    {/each}
  </div>
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
  {#if pacingLine}
    <p class="hp-pacing">{pacingLine}</p>
  {/if}
</section>

<StartQueueSection starts={heavySlot.startQueue} />

{#if folded}
  {@render fold("pressure", pressureOpen, m.heavyslot_pressure_memory(), ramSummary)}
{/if}
{#if pressureOpen}
  <SlotGauges {heavySlot} />
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
  /* The slots heading with their count pushed right. */
  .hp-sec-head {
    display: flex;
    align-items: baseline;
    gap: 6px;
    margin: 10px 0 4px;
  }
  .hp-sec-head h3 {
    margin: 0;
  }
  .hp-sec-head > .hp-push {
    margin-left: auto;
  }
  /* One cell per slot: a held one spans the row (name, runtime, release, command), free and
     blocked ones sit side by side. */
  .hp-cells {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .hp-cell {
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1 1 140px;
    min-width: 0;
    padding: 6px 8px;
    border: 1px solid var(--color-line);
    border-radius: var(--radius-chip);
  }
  .hp-cell.hp-cell-held {
    flex-basis: 100%;
    padding: 6px 8px;
    border-color: color-mix(in srgb, var(--color-amber) 45%, transparent);
  }
  .hp-cell-free {
    border-color: color-mix(in srgb, var(--color-green) 45%, transparent);
  }
  .hp-cell-blocked {
    border-style: dashed;
    border-color: color-mix(in srgb, var(--color-red) 50%, transparent);
  }
  .hp-cell-text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .hp-cell-sub {
    color: var(--color-green);
  }
  .hp-cell-blocked .hp-cell-sub {
    color: color-mix(in srgb, var(--color-red) 75%, var(--color-ink-bright));
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
  .hp-err {
    color: var(--color-red);
    margin: 4px 0 0;
  }
  /* Brake let go, waiting starts follow one by one: still waiting, no longer red. */
  .hp-pacing {
    color: var(--color-amber);
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
