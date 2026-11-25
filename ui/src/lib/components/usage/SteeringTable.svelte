<script lang="ts">
  // One steering table (#4175): rows of sessions grouped by prompt style or type. Every number is
  // server-computed; thin rows (fewer than 3 sessions) are dimmed and say so to screen readers.
  import type { SteeringRow } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { formatPct } from "./format";
  import { median, minutes } from "./steering";

  const {
    heading,
    keyHeader,
    rows,
    labelOf = (k: string) => k,
  }: {
    heading: string;
    keyHeader: string;
    rows: SteeringRow[];
    labelOf?: (key: string) => string;
  } = $props();
</script>

<div class="table-wrap">
  <table class="steering-table">
    <caption>{heading}</caption>
    <thead>
      <tr>
        <th scope="col">{keyHeader}</th>
        <th scope="col" class="num">{m.usage_steering_col_n()}</th>
        <th scope="col" class="num">{m.usage_steering_col_merged()}</th>
        <th scope="col" class="num">{m.usage_steering_col_steers()}</th>
        <th scope="col" class="num">{m.usage_steering_col_critic()}</th>
        <th scope="col" class="num">{m.usage_steering_col_ci()}</th>
        <th scope="col" class="num">{m.usage_steering_col_plan()}</th>
        <th scope="col" class="num">{m.usage_steering_col_duration()}</th>
      </tr>
    </thead>
    <tbody>
      {#each rows as row (row.key)}
        <tr class:thin={row.thin}>
          <th scope="row" class="key">
            {labelOf(row.key)}
            {#if row.thin}<span class="thin-hint">({m.usage_steering_thin_row()})</span>{/if}
          </th>
          <td class="num">{row.n}</td>
          <td class="num">{formatPct(row.mergedShare)}</td>
          <td class="num">{median(row.medianOperatorSteers)}</td>
          <td class="num">{median(row.medianReview)}</td>
          <td class="num">{median(row.medianCi)}</td>
          <td class="num">{median(row.medianPlanReview)}</td>
          <td class="num">{minutes(row.medianDurationMin)}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .table-wrap {
    overflow-x: auto;
  }

  .steering-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--fs-meta);
    color: var(--color-ink);
  }

  caption {
    text-align: left;
    font-size: var(--fs-base);
    font-weight: 600;
    color: var(--color-ink-bright);
    padding-bottom: 0.4rem;
  }

  th,
  td {
    padding: 0.25rem 0.5rem;
    border-bottom: 1px solid var(--color-line);
    white-space: nowrap;
  }

  thead th {
    font-size: var(--fs-micro);
    font-weight: 400;
    color: var(--color-muted);
    text-align: left;
  }

  .key {
    font-weight: 400;
    text-align: left;
    white-space: normal;
  }

  .num {
    text-align: right;
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
  }

  thead .num {
    font-family: var(--font-sans);
  }

  tr.thin {
    color: var(--color-faint);
  }

  .thin-hint {
    font-size: var(--fs-micro);
    color: var(--color-faint);
  }
</style>
