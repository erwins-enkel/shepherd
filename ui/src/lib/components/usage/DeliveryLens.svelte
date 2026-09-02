<script lang="ts">
  // Delivery metrics (#2151 R1) — the OUTCOME counterpart to the cost lenses. Spend/Overhead say
  // what a task cost; this says whether the process is getting better: how often work lands
  // first try, how many rework rounds it takes, and how long it takes to get there.
  import type {
    BandReading,
    DeliveryMetrics,
    DeliverySample,
    DeliveryStats,
    MaintainRun,
  } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import GlossaryText from "$lib/components/GlossaryText.svelte";
  import Sparkline from "./Sparkline.svelte";
  import { formatPct } from "./format";

  const { metrics }: { metrics: DeliveryMetrics } = $props();

  /** Em dash for an empty sample. NEVER a zero — an unmeasured window must not read as a
   *  measured one, which is the whole reason the payload carries nulls rather than zeros. */
  const EMPTY = "—";

  function pct(s: DeliverySample): string {
    return s.value == null ? EMPTY : formatPct(s.value);
  }

  function count(s: DeliverySample, digits = 1): string {
    return s.value == null ? EMPTY : s.value.toFixed(digits).replace(/\.0$/, "");
  }

  function durationOf(s: DeliverySample): string {
    return s.value == null ? EMPTY : humanMs(s.value);
  }

  /** Compact duration. Locale-independent unit letters are the same convention the wait lines
   *  elsewhere in the app use, so they are not catalog strings. */
  function humanMs(ms: number): string {
    const mins = Math.round(ms / 60_000);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ${String(mins % 60).padStart(2, "0")}m`;
    return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  }

  /** Sample-size caption under a tile; blank when the metric has no sample to qualify. */
  function sampleNote(s: DeliverySample): string {
    return s.n === 0 ? "" : m.usage_delivery_sample({ n: s.n });
  }

  interface Tile {
    key: string;
    label: string;
    value: string;
    note: string;
  }

  function tilesFor(st: DeliveryStats): Tile[] {
    return [
      {
        key: "first-pass",
        label: m.usage_delivery_first_pass(),
        value: pct(st.firstPassRate),
        note: sampleNote(st.firstPassRate),
      },
      {
        key: "first-push-green",
        label: m.usage_delivery_first_push(),
        value: pct(st.firstPushGreenRate),
        note: sampleNote(st.firstPushGreenRate),
      },
      {
        key: "rework",
        label: m.usage_delivery_rework(),
        value: count(st.reworkCyclesMedian),
        note: sampleNote(st.reworkCyclesMedian),
      },
      {
        key: "plan-rework",
        label: m.usage_delivery_plan_rework(),
        value: pct(st.planReworkRate),
        note: sampleNote(st.planReworkRate),
      },
      {
        key: "plan-drift",
        label: m.usage_delivery_plan_drift(),
        value: pct(st.planDriftRate),
        note: sampleNote(st.planDriftRate),
      },
      {
        key: "ttfr",
        label: m.usage_delivery_ttfr(),
        value: durationOf(st.timeToFirstReviewMs),
        note: sampleNote(st.timeToFirstReviewMs),
      },
      {
        key: "lead",
        label: m.usage_delivery_lead_time(),
        value: durationOf(st.leadTimeMs),
        note: sampleNote(st.leadTimeMs),
      },
      {
        key: "merged",
        label: m.usage_delivery_merged(),
        value: String(st.mergedTasks),
        note: st.unreviewed > 0 ? m.usage_delivery_unreviewed({ n: st.unreviewed }) : "",
      },
    ];
  }

  const tiles = $derived(tilesFor(metrics.totals));
  const trendPoints = $derived(
    metrics.trend.map((b) => ({ t: Date.parse(`${b.dayKey}T00:00:00Z`), v: b.mergedTasks })),
  );
  const measuringSince = $derived(
    metrics.measuringSince == null ? null : new Date(metrics.measuringSince).toLocaleDateString(),
  );
  /** Nothing instrumented yet is a DIFFERENT state from "nothing merged in this window", and the
   *  two must not render the same — one is young instrumentation, the other is a quiet week. */
  const uninstrumented = $derived(metrics.measuringSince == null);

  // ── maintain loop (#2157) ──────────────────────────────────────────────────
  // Every band is shown, breached or not: the thresholds shipped as calibrated guesses, so the
  // operator recalibrates them from the live values here rather than from a breach alone.

  const maintain = $derived(metrics.maintain);

  /** Newest run for a band, so a row can link to the issue its own band produced. `recentRuns` is
   *  newest-first and capped server-side, so a scan is cheaper than a keyed structure. */
  function latestRun(bandKey: string): MaintainRun | undefined {
    return maintain?.recentRuns.find((r) => r.bandKey === bandKey);
  }

  function bandLabel(r: BandReading): string {
    if (r.bandId === "critic_error_rate") return m.usage_maintain_band_critic_errors();
    if (r.bandId === "incident_spike")
      return m.usage_maintain_band_incidents({ kind: r.subject ?? "?" });
    return m.usage_maintain_band_first_pass({ repo: r.subject ?? "?" });
  }

  /** The measured quantity in the band's own units — a rate for the two rate bands, a raw count
   *  for the incident band. */
  function bandValue(r: BandReading): string {
    if (r.belowMinSample) return EMPTY;
    return r.bandId === "incident_spike" ? String(r.value) : formatPct(r.value);
  }

  function bandSample(r: BandReading): string {
    return m.usage_maintain_sample({ n: r.sampleN });
  }

  function bandState(r: BandReading): string {
    if (r.belowMinSample) return m.usage_maintain_state_no_data();
    if (r.tier === 2) return m.usage_maintain_state_diagnose();
    if (r.tier === 1) return m.usage_maintain_state_log();
    return m.usage_maintain_state_clear();
  }

  function stateClass(r: BandReading): string {
    if (r.belowMinSample) return "chip";
    return r.tier === 2 ? "chip chip-bad" : r.tier === 1 ? "chip chip-warn" : "chip chip-ok";
  }
</script>

<div class="delivery-lens">
  {#if uninstrumented}
    <p class="muted">{m.usage_delivery_empty()}</p>
  {:else}
    <section class="panel delivery-section">
      <h2 class="section-heading">{m.usage_delivery_heading()}</h2>
      <p class="caption">
        <GlossaryText text={m.usage_delivery_caption()} />
      </p>
      {#if measuringSince}
        <p class="caption">{m.usage_delivery_measuring_since({ date: measuringSince })}</p>
      {/if}

      <div class="tiles">
        {#each tiles as tile (tile.key)}
          <div class="tile">
            <!-- Labels go through GlossaryText: some carry [[term|Label]] markers, which would
                 otherwise render as literal markup. -->
            <span class="tile-label"><GlossaryText text={tile.label} /></span>
            <span class="tile-value">{tile.value}</span>
            <span class="tile-note">{tile.note}</span>
          </div>
        {/each}
      </div>

      {#if metrics.totals.planDriftMajor > 0}
        <p class="caption">
          {m.usage_delivery_plan_drift_major({ n: metrics.totals.planDriftMajor })}
        </p>
      {/if}

      {#if metrics.totals.criticErrors > 0}
        <p class="caption">
          {m.usage_delivery_critic_errors({ n: metrics.totals.criticErrors })}
        </p>
      {/if}
    </section>

    {#if trendPoints.length > 1}
      <section class="panel delivery-section">
        <h2 class="section-heading">{m.usage_delivery_trend_heading()}</h2>
        <Sparkline
          points={trendPoints}
          color="var(--color-blue)"
          width={280}
          height={40}
          ariaLabel={m.usage_delivery_trend_heading()}
        />
        <p class="caption">{m.usage_delivery_trend_caption()}</p>
      </section>
    {/if}

    {#if metrics.repos.length > 0}
      <section class="panel delivery-section">
        <h2 class="section-heading">{m.usage_delivery_repos_heading()}</h2>
        <div class="rows">
          <div class="row row-head">
            <span>{m.usage_delivery_col_repo()}</span>
            <span class="numeric">{m.usage_delivery_col_merged()}</span>
            <span class="numeric">{m.usage_delivery_col_first_pass()}</span>
            <span class="numeric">{m.usage_delivery_col_rework()}</span>
            <span class="numeric">{m.usage_delivery_col_lead()}</span>
          </div>
          {#each metrics.repos as repo (repo.repoPath)}
            <div class="row">
              <span class="repo-name">{repo.repo}</span>
              <span class="numeric">{repo.mergedTasks}</span>
              <span class="numeric">{pct(repo.firstPassRate)}</span>
              <span class="numeric">{count(repo.reworkCyclesMedian)}</span>
              <span class="numeric">{durationOf(repo.leadTimeMs)}</span>
            </div>
          {/each}
        </div>
      </section>
    {/if}

    {#if metrics.incidents.length > 0}
      <section class="panel delivery-section">
        <h2 class="section-heading">{m.usage_delivery_incidents_heading()}</h2>
        <div class="rows">
          {#each metrics.incidents as incident (incident.kind)}
            <div class="row incident-row">
              <span class="repo-name">{incident.kind}</span>
              <span class="numeric"
                >{m.usage_delivery_incident_count({
                  occurrences: incident.occurrences,
                  sessions: incident.sessions,
                })}</span
              >
            </div>
          {/each}
        </div>
        <p class="caption">{m.usage_delivery_incidents_caption()}</p>
      </section>
    {/if}

    {#if maintain}
      <section class="panel delivery-section">
        <h2 class="section-heading">{m.usage_maintain_heading()}</h2>
        <p class="caption">
          {#if !maintain.enabled}
            {m.usage_maintain_disabled()}
          {:else if !maintain.act}
            {m.usage_maintain_observe()}
          {:else}
            {m.usage_maintain_armed()}
          {/if}
        </p>
        {#if maintain.readings.length > 0}
          <div class="rows">
            <div class="row band-row row-head">
              <span>{m.usage_maintain_col_band()}</span>
              <span class="numeric">{m.usage_maintain_col_value()}</span>
              <span class="numeric">{m.usage_maintain_col_sample()}</span>
              <span class="numeric">{m.usage_maintain_col_state()}</span>
            </div>
            {#each maintain.readings as reading (reading.key)}
              {@const run = latestRun(reading.key)}
              <div class="row band-row">
                <span class="repo-name">{bandLabel(reading)}</span>
                <span class="numeric">{bandValue(reading)}</span>
                <span class="numeric">{bandSample(reading)}</span>
                <span class="numeric">
                  <span class={stateClass(reading)}>{bandState(reading)}</span>
                  {#if run?.issueUrl}
                    <!-- eslint-disable svelte/no-navigation-without-resolve -- external forge URL -->
                    <a class="issue-link" href={run.issueUrl} target="_blank" rel="noreferrer"
                      >#{run.issueNumber}</a
                    >
                  {/if}
                </span>
              </div>
            {/each}
          </div>
        {:else}
          <p class="muted">{m.usage_maintain_empty()}</p>
        {/if}
      </section>
    {/if}
  {/if}
</div>

<style>
  .delivery-lens {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .delivery-section {
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

  .caption {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    margin: 0;
  }

  .muted {
    font-size: var(--fs-base);
    color: var(--color-faint);
    margin: 0;
  }

  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr));
    gap: 0.5rem;
  }

  .tile {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    padding: 0.5rem 0.625rem;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 0.375rem;
  }

  .tile-label {
    font-size: var(--fs-micro);
    color: var(--color-muted);
  }

  .tile-value {
    font-size: var(--fs-lg);
    color: var(--color-ink-bright);
    font-variant-numeric: tabular-nums;
  }

  .tile-note {
    font-size: var(--fs-micro);
    color: var(--color-faint);
    min-height: 1em;
  }

  .rows {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .row {
    display: grid;
    grid-template-columns: 1fr 4rem 4.5rem 4.5rem 5.5rem;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0.5rem;
    font-size: var(--fs-meta);
    color: var(--color-ink);
  }

  .incident-row {
    grid-template-columns: 1fr auto;
  }

  .band-row {
    grid-template-columns: 1fr 4.5rem 4rem auto;
  }

  .chip {
    display: inline-block;
    padding: 0 0.375rem;
    border-radius: 0.25rem;
    font-size: var(--fs-micro);
    background: var(--color-inset);
    color: var(--color-muted);
  }

  .chip-ok {
    color: var(--color-green);
  }

  .chip-warn {
    color: var(--color-amber);
  }

  .chip-bad {
    color: var(--color-red);
  }

  .issue-link {
    margin-left: 0.375rem;
    font-size: var(--fs-micro);
    color: var(--color-blue);
  }

  .row-head {
    color: var(--color-muted);
    font-size: var(--fs-micro);
  }

  .repo-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .numeric {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  /* Narrow screens drop the lead-time column from the REPO rows only. Both overrides carry the
     :not(.incident-row) guard: a media query adds no specificity, so a bare `.row` here would
     beat `.incident-row` above on source order alone and squeeze the incident count into the
     repo grid's 3rem track. */
  @media (max-width: 480px) {
    .row:not(.incident-row, .band-row) {
      grid-template-columns: 1fr 3rem 3.5rem 3.5rem;
    }
    .row:not(.incident-row, .band-row) > :last-child {
      display: none;
    }
    .band-row {
      grid-template-columns: 1fr 3.5rem auto;
    }
    /* Sample size is the first thing to go on a narrow screen — the value and the tier state are
       what the card is read for. */
    .band-row > :nth-child(3) {
      display: none;
    }
  }
</style>
