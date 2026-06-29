<script lang="ts">
  import type { GithubRateLimit, GhRateBucket } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { gaugeColor } from "$lib/components/usage-gauges";
  import { formatResetIn } from "$lib/format";

  const { data }: { data: GithubRateLimit } = $props();

  const nowMs = $derived(Date.now());

  type Row = {
    bucket: GhRateBucket;
    label: string;
    desc: string;
    /** True when this is the GraphQL bucket — drives the backoff-aware paused banner. */
    isGraphql: boolean;
  };

  // Build only the buckets we actually received, in fixed order (REST, GraphQL, Search).
  function buildRows(d: GithubRateLimit): Row[] {
    const out: Row[] = [];
    if (d.rest)
      out.push({
        bucket: d.rest,
        label: m.github_lens_rest_label(),
        desc: m.github_lens_rest_desc(),
        isGraphql: false,
      });
    if (d.graphql)
      out.push({
        bucket: d.graphql,
        label: m.github_lens_graphql_label(),
        desc: m.github_lens_graphql_desc(),
        isGraphql: true,
      });
    if (d.search)
      out.push({
        bucket: d.search,
        label: m.github_lens_search_label(),
        desc: m.github_lens_search_desc(),
        isGraphql: false,
      });
    return out;
  }
  const rows = $derived(buildRows(data));

  // Consumed percentage of a bucket (higher = closer to its cap → hotter color).
  function usedPct(b: GhRateBucket): number {
    return b.limit > 0 ? Math.min(Math.max((b.used / b.limit) * 100, 0), 100) : 0;
  }

  // GraphQL is paused either because its bucket is empty or because Shepherd's own
  // backoff is engaged (an error tripped it before the live reading caught up).
  const graphqlPaused = $derived(
    (!!data.graphql && data.graphql.remaining <= 0) || data.backoff.blocked,
  );
  const restPaused = $derived(!!data.rest && data.rest.remaining <= 0);

  // When to resume GraphQL: the later of the bucket reset and any active backoff window.
  const graphqlResumeAt = $derived(
    Math.max(data.graphql?.resetAt ?? 0, data.backoff.pausedUntil ?? 0),
  );

  // Status pill for a row: "Exhausted" only when the bucket is truly empty;
  // "Paused" when GraphQL polling is backed off while the bucket still has budget
  // (a transient secondary-rate-limit error, not a drained quota); none otherwise.
  function pillLabel(row: Row): string | null {
    if (row.bucket.remaining <= 0) return m.github_lens_exhausted();
    if (row.isGraphql && data.backoff.blocked) return m.github_lens_paused();
    return null;
  }
</script>

<div class="github-lens panel">
  <p class="intro">{m.github_lens_intro()}</p>

  {#if graphqlPaused}
    <div class="paused-banner" role="alert">
      {m.github_lens_graphql_paused({ time: formatResetIn(graphqlResumeAt, nowMs) })}
    </div>
  {/if}
  {#if restPaused && data.rest}
    <div class="paused-banner" role="alert">
      {m.github_lens_rest_paused({ time: formatResetIn(data.rest.resetAt, nowMs) })}
    </div>
  {/if}

  {#if rows.length === 0}
    <p class="no-data">{m.github_lens_no_data()}</p>
  {:else}
    {#each rows as row (row.label)}
      {@const pct = usedPct(row.bucket)}
      {@const color = gaugeColor(pct)}
      {@const pill = pillLabel(row)}
      <div class="window-block">
        <div class="window-header">
          <span class="window-label">{row.label}</span>
          {#if pill}
            <span class="exhausted-pill">{pill}</span>
          {/if}
          <span class="window-count" style="color:{color}">
            {row.bucket.remaining.toLocaleString()} / {row.bucket.limit.toLocaleString()}
          </span>
        </div>

        <div
          class="meter-wrap"
          role="meter"
          aria-valuenow={Math.round(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={row.label}
        >
          <div class="meter-track">
            <div class="meter-fill" style="width:{pct}%;background:{color}"></div>
          </div>
        </div>

        <div class="window-meta">
          <span class="desc">{row.desc}</span>
          <span class="reset-time"
            >{m.usage_limits_resets_in({ time: formatResetIn(row.bucket.resetAt, nowMs) })}</span
          >
        </div>
      </div>
    {/each}
  {/if}
</div>

<style>
  .github-lens {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .intro {
    margin: 0;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    line-height: 1.5;
  }

  .no-data {
    color: var(--color-muted);
    font-size: var(--fs-base);
    margin: 0;
  }

  .paused-banner {
    border: 1px solid var(--color-red);
    border-radius: 3px;
    background: var(--color-inset);
    color: var(--color-red);
    font-size: var(--fs-meta);
    line-height: 1.5;
    padding: 8px 10px;
  }

  .window-block {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .window-header {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }

  .window-label {
    font-size: var(--fs-base);
    font-weight: 600;
    color: var(--color-ink-bright);
    flex: 1;
  }

  .window-count {
    font-size: var(--fs-base);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  .exhausted-pill {
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-red);
    border: 1px solid var(--color-red);
    border-radius: 2px;
    padding: 0 5px;
  }

  .meter-wrap {
    width: 100%;
  }

  .meter-track {
    position: relative;
    width: 100%;
    height: 10px;
    background: var(--color-line);
    border: 1px solid var(--color-line-bright);
    border-radius: 3px;
    overflow: hidden;
  }

  .meter-fill {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    border-radius: 3px 0 0 3px;
    transition: width 0.4s ease;
  }

  .window-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem 1rem;
  }

  .desc {
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }

  .reset-time {
    font-size: var(--fs-meta);
    color: var(--color-faint);
  }
</style>
