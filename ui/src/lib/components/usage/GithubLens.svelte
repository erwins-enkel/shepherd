<script lang="ts">
  import type { GithubRateLimit, GhRateBucket } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { gaugeColor } from "#lib/components/usage-gauges.js";
  import { formatResetIn } from "#lib/format.js";
  import SplitBar from "./SplitBar.svelte";

  const { data }: { data: GithubRateLimit } = $props();

  const nowMs = $derived(Date.now());

  type Row = {
    bucket: GhRateBucket;
    label: string;
    desc: string;
    /** Shepherd has backed this bucket off (never for Search) — drives the "Paused" pill. */
    paused: boolean;
    /** The GraphQL row carries the spend split (#2840). */
    graphql?: true;
  };

  // Build only the buckets we actually received, in fixed order (REST, GraphQL, Search).
  function buildRows(d: GithubRateLimit): Row[] {
    const out: Row[] = [];
    if (d.rest)
      out.push({
        bucket: d.rest,
        label: m.github_lens_rest_label(),
        desc: m.github_lens_rest_desc(),
        // Reads and writes back off apart (#2805); either one pauses work on this bucket.
        paused: d.restBackoff.blocked || d.restWriteBackoff.blocked,
      });
    if (d.graphql)
      out.push({
        bucket: d.graphql,
        label: m.github_lens_graphql_label(),
        desc: m.github_lens_graphql_desc(),
        paused: d.backoff.blocked,
        graphql: true,
      });
    if (d.search)
      out.push({
        bucket: d.search,
        label: m.github_lens_search_label(),
        desc: m.github_lens_search_desc(),
        paused: false,
      });
    return out;
  }
  const rows = $derived(buildRows(data));

  // Consumed percentage of a bucket (higher = closer to its cap → hotter color).
  function usedPct(b: GhRateBucket): number {
    return b.limit > 0 ? Math.min(Math.max((b.used / b.limit) * 100, 0), 100) : 0;
  }

  // Two distinct GraphQL-paused causes, kept apart so the banner copy matches the
  // row pill: a truly drained bucket ("exhausted") vs. a backoff engaged while the
  // bucket still has budget ("paused" — a transient secondary-rate-limit error).
  const graphqlExhausted = $derived(!!data.graphql && data.graphql.remaining <= 0);
  const graphqlBackedOff = $derived(!graphqlExhausted && data.backoff.blocked);
  // REST keeps the same split. Its backoff is the only trustworthy signal: `rate_limit`
  // can report a full REST budget while every real REST call is refused (#2662).
  const restExhausted = $derived(!!data.rest && data.rest.remaining <= 0);
  const restBackedOff = $derived(!restExhausted && data.restBackoff.blocked);
  // GitHub limits REST writes on a counter of their own (#2805): a write backoff pauses only
  // background writes, so it gets its own banner beside (not instead of) the read one.
  const restWriteBackedOff = $derived(!restExhausted && data.restWriteBackoff.blocked);

  // When to resume GraphQL: the later of the bucket reset and any active backoff window.
  const graphqlResumeAt = $derived(
    Math.max(data.graphql?.resetAt ?? 0, data.backoff.pausedUntil ?? 0),
  );

  // Who spent this GraphQL window (#2840): the Shepherd server vs. everything else on the
  // account. GitHub counts every token of the account against the one budget.
  const split = $derived(data.graphqlSplit);
  // Above this foreign rate, the hint names the likely sources.
  const FOREIGN_HINT_PER_HOUR = 1_000;
  const foreignHigh = $derived((split?.otherPerHour ?? 0) > FOREIGN_HINT_PER_HOUR);

  // Status pill for a row: "Exhausted" only when the bucket is truly empty;
  // "Paused" when Shepherd backed off the bucket while it still reads as having
  // budget (a transient rate-limit error, not a drained quota); none otherwise.
  function pillLabel(row: Row): string | null {
    if (row.bucket.remaining <= 0) return m.github_lens_exhausted();
    if (row.paused) return m.github_lens_paused();
    return null;
  }
</script>

<div class="github-lens panel">
  <p class="intro">{m.github_lens_intro()}</p>

  {#if graphqlExhausted}
    <div class="paused-banner" role="alert">
      {m.github_lens_graphql_paused({ time: formatResetIn(graphqlResumeAt, nowMs) })}
    </div>
  {:else if graphqlBackedOff}
    <div class="paused-banner" role="alert">
      {m.github_lens_graphql_backoff({ time: formatResetIn(graphqlResumeAt, nowMs) })}
    </div>
  {/if}
  {#if restExhausted && data.rest}
    <div class="paused-banner" role="alert">
      {m.github_lens_rest_paused({ time: formatResetIn(data.rest.resetAt, nowMs) })}
    </div>
  {:else if restBackedOff}
    <div class="paused-banner" role="alert">
      {m.github_lens_rest_backoff({
        time: formatResetIn(data.restBackoff.pausedUntil ?? 0, nowMs),
      })}
    </div>
  {/if}
  {#if restWriteBackedOff}
    <div class="paused-banner" role="alert">
      {m.github_lens_rest_write_backoff({
        time: formatResetIn(data.restWriteBackoff.pausedUntil ?? 0, nowMs),
      })}
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

        {#if row.graphql && split}
          <div class="split-block">
            {#if split.ownPerHour !== null && split.otherPerHour !== null}
              <SplitBar a={split.ownPerHour} b={split.otherPerHour} />
              <div class="split-legend">
                <span class="split-own"
                  >{m.github_lens_split_own({ rate: split.ownPerHour.toLocaleString() })}</span
                >
                <span class="split-sep" aria-hidden="true">·</span>
                <span class="split-other"
                  >{m.github_lens_split_other({ rate: split.otherPerHour.toLocaleString() })}</span
                >
              </div>
            {:else}
              <span class="desc">{m.github_lens_split_measuring()}</span>
            {/if}
          </div>
        {/if}

        {#if row.graphql && split && foreignHigh}
          <div class="foreign-hint" role="note">
            <p class="hint-title">
              {m.github_lens_foreign_title({ rate: (split.otherPerHour ?? 0).toLocaleString() })}
            </p>
            <p class="hint-text">{m.github_lens_foreign_summary()}</p>
            <p class="hint-label">{m.github_lens_foreign_sources()}</p>
            <ul class="hint-list">
              <li>{m.github_lens_foreign_source_agents()}</li>
              <li>{m.github_lens_foreign_source_machines()}</li>
              <li>{m.github_lens_foreign_source_apps()}</li>
            </ul>
            <p class="hint-label">{m.github_lens_foreign_next()}</p>
            <p class="hint-links">
              <a
                href="https://github.com/settings/applications"
                target="_blank"
                rel="noopener noreferrer">{m.github_lens_foreign_link_apps()}</a
              >
              <span aria-hidden="true">·</span>
              <a
                href="https://github.com/settings/security-log"
                target="_blank"
                rel="noopener noreferrer">{m.github_lens_foreign_link_log()}</a
              >
            </p>
          </div>
        {/if}
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

  .split-block {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    margin-top: 0.25rem;
  }

  .split-legend {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.25rem 0.5rem;
    font-size: var(--fs-meta);
    color: var(--color-ink);
    font-variant-numeric: tabular-nums;
  }

  /* Swatches match SplitBar's default tones: blue = Shepherd server, amber = everything else. */
  .split-own::before,
  .split-other::before {
    content: "";
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 2px;
    margin-right: 0.375rem;
  }

  .split-own::before {
    background: var(--color-blue);
  }

  .split-other::before {
    background: var(--color-amber);
  }

  .split-sep {
    color: var(--color-faint);
  }

  .foreign-hint {
    border: 1px solid var(--color-warn);
    border-radius: 3px;
    background: var(--color-inset);
    font-size: var(--fs-meta);
    line-height: 1.5;
    padding: 8px 10px;
    color: var(--color-ink);
  }

  .foreign-hint p {
    margin: 0;
  }

  .hint-title {
    font-weight: 600;
    color: var(--color-warn);
  }

  .hint-text {
    color: var(--color-muted);
  }

  .foreign-hint .hint-label {
    margin-top: 0.5rem;
    font-weight: 600;
    color: var(--color-ink-bright);
  }

  .hint-list {
    margin: 0;
    padding-left: 1.1rem;
    list-style: disc;
  }

  .hint-links {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .hint-links a {
    color: var(--color-blue);
  }
</style>
