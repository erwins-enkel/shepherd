<script lang="ts">
  // The content of an `ok`/`thin` steering report (#4175): both tables, intent × phase, findings
  // and example cards. The header and state handling live in SteeringLens.
  import type { SteeringReport, SteeringTables } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import SteeringTable from "./SteeringTable.svelte";
  import SteeringExampleCard from "./SteeringExampleCard.svelte";
  import { intentLabel, styleLabel } from "./steering";

  const { report, tables }: { report: SteeringReport; tables: SteeringTables } = $props();

  const repoOf = $derived(new Map(report.sessions.map((s) => [s.desig, s.repo])));
  const findings = $derived((report.labels?.findings ?? []).slice(0, 3));
  const examples = $derived(report.labels?.examples ?? []);
</script>

{#if findings.length > 0}
  <section class="panel steering-section">
    <h3 class="section-heading">{m.usage_steering_findings_heading()}</h3>
    <ul class="findings">
      {#each findings as f, i (i)}
        <li class="finding">
          <span>{f.text}</span>
          <span class="chips">
            {#each f.desigs as d (d)}<span class="chip">{d}</span>{/each}
          </span>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<section class="panel steering-section">
  <SteeringTable
    heading={m.usage_steering_by_style()}
    keyHeader={m.usage_steering_col_style()}
    rows={tables.byStyle}
    labelOf={styleLabel}
  />
  <SteeringTable
    heading={m.usage_steering_by_type()}
    keyHeader={m.usage_steering_col_type()}
    rows={tables.byType}
  />
  <p class="caption">{m.usage_steering_medians_caption()}</p>
</section>

<section class="panel steering-section">
  <div class="table-wrap">
    <table class="intent-table">
      <caption>{m.usage_steering_intents_heading()}</caption>
      <thead>
        <tr>
          <th scope="col">{m.usage_steering_col_intent()}</th>
          <th scope="col" class="num">{m.usage_steering_phase_start()}</th>
          <th scope="col" class="num">{m.usage_steering_phase_mid()}</th>
          <th scope="col" class="num">{m.usage_steering_phase_end()}</th>
        </tr>
      </thead>
      <tbody>
        {#each tables.intents as row (row.intent)}
          <tr>
            <th scope="row">{intentLabel(row.intent)}</th>
            <td class="num">{row.start}</td>
            <td class="num">{row.mid}</td>
            <td class="num">{row.end}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>

{#if examples.length > 0}
  <section class="panel steering-section">
    <h3 class="section-heading">{m.usage_steering_examples_heading()}</h3>
    <div class="examples">
      {#each examples as ex, i (i)}
        <SteeringExampleCard example={ex} repo={repoOf.get(ex.desig) ?? null} />
      {/each}
    </div>
  </section>
{/if}

<style>
  .steering-section {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .section-heading {
    font-size: var(--fs-base);
    font-weight: 600;
    color: var(--color-ink-bright);
    margin: 0;
  }

  .caption {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    margin: 0;
  }

  .findings {
    margin: 0;
    padding-left: 1.1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    font-size: var(--fs-meta);
    color: var(--color-ink);
  }

  .finding {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.5rem;
    align-items: baseline;
  }

  .chips {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }

  .chip {
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    color: var(--color-slate);
    border: 1px solid var(--color-faint);
    border-radius: 2px;
    padding: 0 0.3rem;
  }

  .table-wrap {
    overflow-x: auto;
  }

  .intent-table {
    border-collapse: collapse;
    font-size: var(--fs-meta);
    color: var(--color-ink);
    min-width: 18rem;
  }

  .intent-table caption {
    text-align: left;
    font-size: var(--fs-base);
    font-weight: 600;
    color: var(--color-ink-bright);
    padding-bottom: 0.4rem;
  }

  .intent-table th,
  .intent-table td {
    padding: 0.25rem 0.5rem;
    border-bottom: 1px solid var(--color-line);
    text-align: left;
    font-weight: 400;
  }

  .intent-table thead th {
    font-size: var(--fs-micro);
    color: var(--color-muted);
  }

  .intent-table .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .intent-table td.num {
    font-family: var(--font-mono);
  }

  .examples {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr));
    gap: 0.75rem;
  }
</style>
