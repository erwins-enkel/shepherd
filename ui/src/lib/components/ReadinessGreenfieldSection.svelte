<script lang="ts">
  import { getGreenfieldReadiness } from "#lib/api.js";
  import type { GreenfieldItem, GreenfieldReport } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { coachTarget } from "#lib/actions/coachTarget.svelte.js";
  import { greenfieldGroups, greenfieldHint, greenfieldTitle } from "./readiness-greenfield-view";

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
</script>

{#snippet rows(items: GreenfieldItem[])}
  <ul class="list">
    {#each items as it (it.id)}
      <li class="row">
        <span class="dot" class:present={it.present} aria-hidden="true"
          >{it.present ? "●" : "○"}</span
        >
        <div class="row-body">
          <div class="row-title">{greenfieldTitle(it.id)}</div>
          {#if it.present}
            <div class="row-evidence">{it.evidence.join(" · ")}</div>
          {:else}
            <div class="row-hint">{greenfieldHint(it.id)}</div>
          {/if}
        </div>
      </li>
    {/each}
  </ul>
{/snippet}

<div class="section" use:coachTarget={"readiness-greenfield"}>
  <div class="section-head">{m.readiness_gf_heading()}</div>
  {#if intro}<div class="note">{m.readiness_gf_intro()}</div>{/if}
  {#if loading}
    <div class="note">{m.common_loading()}</div>
  {:else if loadError || !report}
    <div class="note error">{m.readiness_gf_load_error()}</div>
  {:else}
    <div class="progress">
      <div
        class="bar"
        role="progressbar"
        aria-label={m.readiness_gf_heading()}
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={report.score}
      >
        <div class="fill" style:width="{report.score}%"></div>
      </div>
      <span class="pct">{report.score}%</span>
    </div>
    <div class="note">
      {m.readiness_gf_summary({
        green: groups.must.length - report.mustHavesMissing.length,
        total: groups.must.length,
      })}
    </div>
    <div class="group-head">{m.readiness_gf_must_heading()}</div>
    {@render rows(groups.must)}
    <div class="group-head">{m.readiness_gf_nice_heading()}</div>
    {@render rows(groups.nice)}
  {/if}
</div>

<style>
  .section {
    padding: 12px 0;
    border-bottom: 1px solid var(--color-line);
  }
  .section-head,
  .group-head {
    font-size: var(--fs-micro);
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--color-muted);
    margin-bottom: 8px;
  }
  .group-head {
    margin-top: 12px;
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
  .progress {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 4px 0 6px;
  }
  .bar {
    flex: 1;
    height: 6px;
    border-radius: 3px;
    background: var(--color-line);
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: var(--color-amber);
  }
  .pct {
    font-size: var(--fs-meta);
    color: var(--color-ink);
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
  .dot {
    line-height: 1.4;
    font-size: var(--fs-meta);
    color: var(--color-faint);
  }
  .dot.present {
    color: var(--color-green);
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
