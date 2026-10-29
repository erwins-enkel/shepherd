<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { basename } from "#lib/basename.js";
  import { schedules, upcomingOrder } from "#lib/schedules.svelte.js";
  import { schedulesExplanation } from "#lib/tooltips/explanations.js";
  import InfoTip from "../InfoTip.svelte";
  import HighlightText from "./HighlightText.svelte";
  import ScheduleRow from "../automation-settings/ScheduleRow.svelte";
  import ScheduleDialog from "../automation-settings/ScheduleDialog.svelte";
  import "./settings-controls.css";
  import type { Schedule } from "#lib/types.js";

  // Settings → Schedules (#3475): every repo's schedules in one list, soonest run first, with the
  // same row as a repo's Repo automation list. Adding stays per repo. Mounted only while shown;
  // the store re-reads the list on `schedules:changed`.
  let { query = "" }: { query?: string } = $props();

  $effect(() => {
    void schedules.loadAll();
  });

  const all = $derived(schedules.all());
  const repos = $derived([...new Set((all ?? []).map((s) => s.repoPath))].sort());
  /** "" = all repos. */
  let filter = $state("");
  // Back to all once the chosen repo has no schedules left, so the select never shows a blank and
  // the list doesn't silently narrow again when that repo gets a schedule back.
  $effect(() => {
    if (filter && !repos.includes(filter)) filter = "";
  });
  const list = $derived(upcomingOrder((all ?? []).filter((s) => !filter || s.repoPath === filter)));
  let editing = $state<Schedule | null>(null);
</script>

<div class="ssp-head">
  <HighlightText text={m.settings_tab_schedules()} {query} />
  <InfoTip text={schedulesExplanation()} label={m.tooltip_schedules_title()} />
</div>
<p class="ssp-intro"><HighlightText text={m.settings_schedules_intro()} {query} /></p>

{#if all === null && schedules.allFailed()}
  <p class="ssp-intro">
    {m.settings_schedules_load_failed()}
    <button type="button" class="set-gbtn" onclick={() => void schedules.loadAll()}
      >{m.common_retry()}</button
    >
  </p>
{:else if all === null}
  <p class="ssp-intro">{m.common_loading()}</p>
{:else if all.length === 0}
  <p class="ssp-intro">{m.settings_schedules_empty()}</p>
{:else}
  {#if repos.length > 1}
    <label class="ssp-filter">
      <span><HighlightText text={m.settings_schedules_filter_label()} {query} /></span>
      <span class="set-select">
        <select bind:value={filter}>
          <option value="">{m.settings_schedules_filter_all()}</option>
          {#each repos as r (r)}
            <option value={r}>{basename(r)}</option>
          {/each}
        </select>
        <span class="set-chev" aria-hidden="true">▾</span>
      </span>
    </label>
  {/if}
  <ul class="ssp-list">
    {#each list as s (s.id)}
      <ScheduleRow schedule={s} showRepo onedit={() => (editing = s)} />
    {/each}
  </ul>
{/if}
{#if editing}
  <ScheduleDialog repoPath={editing.repoPath} schedule={editing} onclose={() => (editing = null)} />
{/if}

<style>
  .ssp-head {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
  }
  .ssp-intro {
    color: var(--color-faint);
    font-size: var(--fs-meta);
    margin: 6px 0 12px;
  }
  .ssp-filter {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0 0 12px;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .ssp-filter .set-select {
    width: auto;
    min-width: 180px;
  }
  .ssp-list {
    list-style: none;
    margin: 0;
    padding: 0;
    border-bottom: 1px solid var(--color-line);
  }
</style>
