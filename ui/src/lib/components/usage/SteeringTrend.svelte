<script lang="ts">
  // Steering trend (#4176): the weekly digests over time — prescribing share and the median
  // rework per typed session. Weekly reports only (manual runs overlap their windows).
  import { m } from "#lib/paraglide/messages.js";
  import InfoTip from "#lib/components/InfoTip.svelte";
  import { coachTarget } from "#lib/actions/coachTarget.svelte.js";
  import type { SteeringTrendPoint } from "#lib/types.js";
  import Sparkline from "./Sparkline.svelte";
  import { steeringTrendExplanation, steeringTrendRows } from "./steering";

  const { trend }: { trend: SteeringTrendPoint[] } = $props();

  const rows = $derived(steeringTrendRows(trend));
</script>

<section class="panel steering-trend" use:coachTarget={"steering-trend"}>
  <div class="head-row">
    <h3 class="trend-heading">{m.usage_steering_trend_heading()}</h3>
    <InfoTip text={steeringTrendExplanation()} label={m.usage_steering_trend_heading()} />
  </div>
  {#if trend.length < 2}
    <p class="caption">{m.usage_steering_trend_empty()}</p>
  {:else}
    <ul class="rows">
      {#each rows as row (row.key)}
        <li class="row" data-trend={row.key}>
          <span class="label">{row.label}</span>
          {#if row.points.length >= 2}
            <Sparkline
              points={row.points}
              color="var(--color-blue)"
              width={160}
              height={28}
              domain={row.domain}
              ariaLabel={row.label}
            />
          {:else}
            <span class="spark-gap" aria-hidden="true"></span>
          {/if}
          <span class="value">{row.latest}</span>
        </li>
      {/each}
    </ul>
    <p class="caption">{m.usage_steering_trend_caption({ n: trend.length })}</p>
  {/if}
</section>

<style>
  .steering-trend {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .head-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .trend-heading {
    margin: 0;
    font-size: var(--fs-base);
    font-weight: 600;
    color: var(--color-ink-bright);
  }

  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .row {
    display: grid;
    grid-template-columns: minmax(8rem, 1fr) 160px 3.5rem;
    align-items: center;
    gap: 0.75rem;
  }

  .label {
    font-size: var(--fs-meta);
    color: var(--color-ink);
  }

  .spark-gap {
    display: block;
    width: 160px;
    height: 28px;
  }

  .value {
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    color: var(--color-ink-bright);
    text-align: right;
  }

  .caption {
    margin: 0;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
</style>
