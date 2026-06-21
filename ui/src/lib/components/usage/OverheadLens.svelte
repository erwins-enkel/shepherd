<script lang="ts">
  import type { UsageBreakdown, UsageTaskBreakdown } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import InfoTip from "$lib/components/InfoTip.svelte";
  import UsageBar from "./UsageBar.svelte";
  import SplitBar from "./SplitBar.svelte";
  import { formatPct } from "./format";

  const { breakdown }: { breakdown: UsageBreakdown } = $props();

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
            <span class="tax-desig">{task.desig}</span>
            <span class="tax-bar">
              <UsageBar value={tax} max={maxTax} tone="var(--color-amber)" />
            </span>
            <span class="tax-pct">+{formatPct(tax)}</span>
          </div>
        {/each}
      </div>
    {/if}
  </section>

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
    grid-template-columns: 6rem 1fr 4rem;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0.5rem;
    font-size: var(--fs-meta);
  }

  .tax-desig {
    color: var(--color-muted);
    font-variant-numeric: tabular-nums;
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

  @media (max-width: 480px) {
    .tax-task-row {
      grid-template-columns: 1fr auto;
      grid-template-areas: "desig pct" "bar bar";
      row-gap: 0.25rem;
    }
    .tax-desig {
      grid-area: desig;
    }
    .tax-pct {
      grid-area: pct;
    }
    .tax-bar {
      grid-area: bar;
    }
  }
</style>
