<script lang="ts">
  import { getGreenfieldReadiness } from "#lib/api.js";
  import type { GreenfieldItem, GreenfieldReport } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { coachTarget } from "#lib/actions/coachTarget.svelte.js";
  import { repoBootstrap } from "#lib/repo-bootstrap.svelte.js";
  import {
    greenfieldByOperator,
    greenfieldGroups,
    greenfieldHint,
    greenfieldShort,
    greenfieldTitle,
    redFirst,
  } from "./readiness-greenfield-view";

  let {
    repoPath,
    intro = false,
  }: {
    repoPath: string;
    /** Show the "no manifest yet" intro (the repo has no scaffold). */
    intro?: boolean;
  } = $props();

  let report = $state.raw<GreenfieldReport | null>(null);
  let loading = $state(true);
  let loadError = $state(false);

  // Reload on repo change; drop a stale response that lands after a switch.
  $effect(() => {
    const rp = repoPath;
    loading = true;
    loadError = false;
    report = null;
    getGreenfieldReadiness(rp)
      .then((r) => {
        if (rp !== repoPath) return;
        report = r;
        loading = false;
      })
      .catch(() => {
        if (rp !== repoPath) return;
        loadError = true;
        loading = false;
      });
  });

  let groups = $derived(report ? greenfieldGroups(report) : { must: [], nice: [] });
  let niceGreen = $derived(groups.nice.filter((i) => i.present).length);
  // "By you" only means something while a bootstrap session delivers the rest.
  let bootstrapping = $derived(repoBootstrap.viewFor(repoPath)?.state === "active");
</script>

{#snippet rows(items: GreenfieldItem[], gate: boolean)}
  <ul class="list">
    {#each redFirst(items) as it (it.id)}
      <li class={["row", it.present ? "present" : gate && "open"]}>
        <span class="dot" aria-hidden="true">{it.present ? "●" : "○"}</span>
        <div class="row-body">
          <div class="row-title">{greenfieldTitle(it.id)}</div>
          {#if it.present}
            <div class="row-evidence">{it.evidence.join(" · ")}</div>
          {:else}
            <div class="row-hint">{greenfieldHint(it.id)}</div>
          {/if}
        </div>
        {#if bootstrapping && greenfieldByOperator(it.id)}
          <span class="by-you">{m.readiness_gf_by_operator()}</span>
        {/if}
      </li>
    {/each}
  </ul>
{/snippet}

<div class="section" use:coachTarget={"readiness-greenfield"}>
  <div class="head">
    <span class="section-head">{m.readiness_gf_heading()}</span>
    {#if report}
      <span class="gate-sum">
        {m.readiness_gf_summary({
          green: groups.must.length - report.mustHavesMissing.length,
          total: groups.must.length,
        })}
      </span>
    {/if}
  </div>
  {#if intro}<div class="note">{m.readiness_gf_intro()}</div>{/if}
  {#if loading}
    <div class="note">{m.common_loading()}</div>
  {:else if loadError || !report}
    <div class="note error">{m.readiness_gf_load_error()}</div>
  {:else}
    <!-- The drain gate, one segment per must-have; the summary above and the rows below say it in
         words, so the meter itself stays out of the accessibility tree. -->
    <ol class="gate" aria-hidden="true">
      {#each groups.must as it (it.id)}
        <li class:present={it.present}>
          <span class="seg"></span>
          <span class="seg-label">{greenfieldShort(it.id)}</span>
        </li>
      {/each}
    </ol>
    <div class="group-head">{m.readiness_gf_must_heading()}</div>
    {@render rows(groups.must, true)}
    <!-- Nice-to-haves never hold the gate: folded away, except on a bare repo where the PRD and
         design inputs are the first thing to add. -->
    <details class="nice" open={intro}>
      <summary class="group-head">
        {m.readiness_gf_nice_summary({ green: niceGreen, total: groups.nice.length })}
      </summary>
      {@render rows(groups.nice, false)}
    </details>
  {/if}
</div>

<style>
  .section {
    padding: 12px 0;
    border-bottom: 1px solid var(--color-line);
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 4px 12px;
    margin-bottom: 10px;
  }
  .section-head,
  .group-head {
    font-size: var(--fs-micro);
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .group-head {
    margin: 16px 0 8px;
  }
  .gate-sum {
    font-size: var(--fs-meta);
    color: var(--color-ink);
  }
  .note {
    font-size: var(--fs-meta);
    color: var(--color-faint);
    line-height: 1.45;
    margin-bottom: 6px;
  }
  .note.error {
    color: var(--color-red);
  }

  /* ── the gate meter: green segment = must-have met, dashed amber = still holding the drain ── */
  .gate {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: minmax(0, 1fr);
    gap: 4px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .gate li {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .seg {
    box-sizing: border-box;
    height: 8px;
    border-radius: 2px;
    border: 1px dashed var(--color-amber);
  }
  .gate li.present .seg {
    border: none;
    background: var(--color-green);
  }
  .seg-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-micro);
    color: var(--color-amber);
  }
  .gate li.present .seg-label {
    color: var(--color-muted);
  }
  .nice summary {
    width: fit-content;
    cursor: pointer;
  }
  .nice summary:hover {
    color: var(--color-ink-bright);
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .row {
    display: flex;
    gap: 8px;
    align-items: flex-start;
  }
  /* A red must-have holds the drain: it leads the list and reads as the thing to do. */
  .row.open {
    padding: 8px 10px;
    border: 1px solid color-mix(in srgb, var(--color-amber) 30%, var(--color-line));
    border-radius: 2px;
    background: color-mix(in srgb, var(--color-amber) 5%, var(--color-inset));
  }
  .dot {
    line-height: 1.4;
    font-size: var(--fs-meta);
    color: var(--color-faint);
  }
  .row.present .dot {
    color: var(--color-green);
  }
  .row.open .dot {
    color: var(--color-amber);
  }
  .row.open .row-title {
    color: var(--color-ink-bright);
  }
  .by-you {
    flex: none;
    padding: 1px 6px;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    color: var(--color-muted);
  }
  .row.open .by-you {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .row-body {
    flex: 1;
    min-width: 0;
  }
  .row-title {
    font-size: var(--fs-base);
    color: var(--color-ink);
  }
  .row-hint {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    line-height: 1.45;
    margin-top: 1px;
  }
  .row-evidence {
    font-size: var(--fs-meta);
    color: var(--color-faint);
    word-break: break-word;
  }
</style>
