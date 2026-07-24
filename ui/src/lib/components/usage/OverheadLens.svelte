<script lang="ts">
  import type { UsageBreakdown, UsageTaskBreakdown } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import InfoTip from "$lib/components/InfoTip.svelte";
  import UsageBar from "./UsageBar.svelte";
  import SplitBar from "./SplitBar.svelte";
  import { formatPct, formatUnits } from "./format";

  const { breakdown }: { breakdown: UsageBreakdown } = $props();

  // ─── Satellite by type ─────────────────────────────────────────────────────────

  /** Translated label for a satellite-pass kind; falls back to the raw id for unknowns. */
  function kindLabel(kind: string): string {
    switch (kind) {
      case "classifier":
        return m.usage_kind_classifier();
      case "review":
        return m.usage_kind_review();
      case "plan_gate":
        return m.usage_kind_plan_gate();
      case "recap":
        return m.usage_kind_recap();
      case "rundown":
        return m.usage_kind_rundown();
      case "doc_agent":
        return m.usage_kind_doc_agent();
      default:
        return kind;
    }
  }

  /** Sum of by-kind units — the denominator for each kind's share. */
  const byKindTotal = $derived(breakdown.satelliteByKind.reduce((s, k) => s + k.units, 0));

  /** Largest kind's units — bar scale reference. */
  const maxKindUnits = $derived(
    breakdown.satelliteByKind.length > 0 ? breakdown.satelliteByKind[0].units : 1,
  );

  // ─── Reviewer tax ────────────────────────────────────────────────────────────

  /** All tasks flattened across repos. */
  const allTasks = $derived(breakdown.repos.flatMap((r) => r.tasks));

  /** Per-task tax = satelliteUnits / authoringUnits (guarded). */
  function taskTax(task: UsageTaskBreakdown): number {
    return task.authoringUnits > 0 ? task.satelliteUnits / task.authoringUnits : 0;
  }

  /** Top 6 tasks by tax, descending. */
  const topTaxTasks = $derived([...allTasks].sort((a, b) => taskTax(b) - taskTax(a)).slice(0, 6));

  /** Max tax in the top-6 list (for bar scaling). */
  const maxTax = $derived(topTaxTasks.length > 0 ? taskTax(topTaxTasks[0]) : 1);

  /** Overall satellite share relative to authoring (the "tax" caption). */
  const overallTax = $derived(
    breakdown.authoringUnits > 0 ? breakdown.satelliteUnits / breakdown.authoringUnits : 0,
  );

  // ─── Cache efficiency ────────────────────────────────────────────────────────

  const cacheTotal = $derived(breakdown.cacheReadUnits + breakdown.generationUnits);

  const cacheReadPct = $derived(cacheTotal > 0 ? breakdown.cacheReadUnits / cacheTotal : 0);
  const generationPct = $derived(cacheTotal > 0 ? breakdown.generationUnits / cacheTotal : 0);
</script>

<div class="overhead-lens">
  <!-- ── Section (a): Reviewer tax ── -->
  <section class="panel overhead-section">
    <h2 class="section-heading">{m.usage_overhead_tax_heading()}</h2>

    <!-- Overall authoring vs satellite split bar -->
    <div class="split-bar-wrap">
      <div class="split-labels">
        <span class="split-label authoring-label">{m.usage_overhead_authoring_label()}</span>
        <span class="split-label satellite-label">
          <span>{m.usage_overhead_satellite_label()}</span>
          <InfoTip
            text={m.gloss_satellite_pass_def()}
            label={m.newtask_info_aria({ topic: m.gloss_satellite_pass_term() })}
          />
        </span>
      </div>
      <SplitBar
        a={breakdown.authoringUnits}
        b={breakdown.satelliteUnits}
        aTone="var(--color-blue)"
        bTone="var(--color-amber)"
        aClass="authoring-seg"
        bClass="satellite-seg"
      />
      <p class="tax-caption">
        {m.usage_overhead_tax_caption({ pct: formatPct(overallTax) })}
      </p>
    </div>

    <!-- Per-task tax list -->
    {#if topTaxTasks.length > 0}
      <div class="tax-task-list">
        {#each topTaxTasks as task (task.sessionId)}
          {@const tax = taskTax(task)}
          <div class="tax-task-row">
            <span class="tax-label">
              <span class="tax-desig">{task.desig}</span>
              {#if task.name}
                <span class="tax-name" title={task.name}>{task.name}</span>
              {/if}
            </span>
            <span class="tax-bar">
              <UsageBar value={tax} max={maxTax} tone="var(--color-amber)" />
            </span>
            <span class="tax-pct">+{formatPct(tax)}</span>
          </div>
        {/each}
      </div>
    {/if}
  </section>

  <!-- ── Section (a2): Satellite by type ── -->
  {#if breakdown.satelliteByKind.length > 0}
    <section class="panel overhead-section">
      <h2 class="section-heading">{m.usage_overhead_bykind_heading()}</h2>
      <div class="bykind-list">
        {#each breakdown.satelliteByKind as k (k.kind)}
          <div class="bykind-row">
            <span class="bykind-label">{kindLabel(k.kind)}</span>
            <span class="bykind-count">{m.usage_overhead_bykind_count({ count: k.count })}</span>
            <span class="bykind-bar">
              <UsageBar value={k.units} max={maxKindUnits} tone="var(--color-amber)" />
            </span>
            <span class="bykind-units">{formatUnits(k.units)}</span>
            <span class="bykind-pct">{formatPct(byKindTotal > 0 ? k.units / byKindTotal : 0)}</span>
          </div>
        {/each}
      </div>
      <p class="tax-caption">{m.usage_overhead_bykind_caption()}</p>
    </section>
  {/if}

  <!-- ── Section (b): Cache efficiency ── -->
  <section class="panel overhead-section">
    <h2 class="section-heading">{m.usage_overhead_cache_heading()}</h2>

    <div class="split-bar-wrap">
      <div class="split-labels">
        <span class="split-label cacheread-label">
          <span>{m.usage_overhead_cacheread_label()}</span>
          <span class="split-share">{formatPct(cacheReadPct)}</span>
        </span>
        <span class="split-label generation-label">
          <span>{m.usage_overhead_generation_label()}</span>
          <span class="split-share">{formatPct(generationPct)}</span>
        </span>
      </div>
      <SplitBar
        a={breakdown.cacheReadUnits}
        b={breakdown.generationUnits}
        aTone="var(--color-blue)"
        bTone="var(--color-amber)"
        aClass="cacheread-seg"
        bClass="generation-seg"
      />
    </div>
  </section>
</div>

<style>
  .overhead-lens {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .overhead-section {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .section-heading {
    font-size: var(--fs-lg);
    font-weight: 600;
    color: var(--color-ink-bright);
    margin: 0;
  }

  /* ── Split bar ── */
  .split-bar-wrap {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .split-labels {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
  }

  .split-label {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }

  .split-share {
    color: var(--color-ink-bright);
    font-weight: 500;
  }

  /* ── Tax caption ── */
  .tax-caption {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    margin: 0;
  }

  /* ── Per-task tax list ── */
  .tax-task-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .tax-task-row {
    display: grid;
    grid-template-columns: 11rem 1fr 4rem;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0.5rem;
    font-size: var(--fs-meta);
  }

  .tax-label {
    display: flex;
    align-items: baseline;
    gap: 0.375rem;
    min-width: 0;
  }

  .tax-desig {
    flex: none;
    color: var(--color-muted);
    font-size: var(--fs-micro);
    font-variant-numeric: tabular-nums;
  }

  .tax-name {
    min-width: 0;
    color: var(--color-ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tax-bar {
    display: flex;
    align-items: center;
  }

  .tax-pct {
    color: var(--color-ink);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  /* ── Satellite by type ── */
  .bykind-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .bykind-row {
    display: grid;
    grid-template-columns: 6rem 2.5rem 1fr 4rem 3rem;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0.5rem;
    font-size: var(--fs-meta);
  }

  .bykind-label {
    color: var(--color-ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .bykind-count {
    color: var(--color-muted);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .bykind-bar {
    display: flex;
    align-items: center;
  }

  .bykind-units {
    color: var(--color-ink);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .bykind-pct {
    color: var(--color-muted);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  @media (max-width: 480px) {
    .tax-task-row {
      grid-template-columns: 1fr auto;
      grid-template-areas: "desig pct" "bar bar";
      row-gap: 0.25rem;
    }
    .tax-label {
      grid-area: desig;
    }
    .tax-pct {
      grid-area: pct;
    }
    .tax-bar {
      grid-area: bar;
    }

    .bykind-row {
      grid-template-columns: 1fr auto auto;
      grid-template-areas: "label count pct" "bar bar units";
      row-gap: 0.25rem;
    }
    .bykind-label {
      grid-area: label;
    }
    .bykind-count {
      grid-area: count;
    }
    .bykind-bar {
      grid-area: bar;
    }
    .bykind-units {
      grid-area: units;
    }
    .bykind-pct {
      grid-area: pct;
    }
  }
</style>
