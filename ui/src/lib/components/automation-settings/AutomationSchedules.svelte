<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { schedules } from "#lib/schedules.svelte.js";
  import { schedulesExplanation } from "#lib/tooltips/explanations.js";
  import InfoTip from "../InfoTip.svelte";
  import ScheduleDialog from "./ScheduleDialog.svelte";
  import ScheduleRow from "./ScheduleRow.svelte";
  import type { Schedule } from "#lib/types.js";

  // Operator schedules (#3469): this repo's recurring prompts — list, enable switch, run now, and
  // add/edit in ScheduleDialog; rows are ScheduleRow. Self-contained so AutomationSettings'
  // template, which sits at its complexity bar, only gains one tag.
  let { repoPath }: { repoPath: string } = $props();

  $effect(() => {
    void schedules.load(repoPath);
  });

  const list = $derived(schedules.listFor(repoPath) ?? []);
  /** null = closed; "new" = add; a schedule = edit it. */
  let editing = $state<Schedule | "new" | null>(null);
</script>

<div class="sc-head">
  <div class="sc-name">
    ⏱ {m.schedules_title()}
    <InfoTip text={schedulesExplanation()} label={m.tooltip_schedules_title()} />
  </div>
  <button type="button" class="sc-btn" onclick={() => (editing = "new")}>{m.schedules_add()}</button
  >
</div>
{#if list.length === 0}
  <p class="sc-empty">{m.schedules_empty()}</p>
{:else}
  <ul class="sc-list">
    {#each list as s (s.id)}
      <ScheduleRow schedule={s} onedit={() => (editing = s)} />
    {/each}
  </ul>
{/if}
{#if editing}
  <ScheduleDialog
    {repoPath}
    schedule={editing === "new" ? null : editing}
    onclose={() => (editing = null)}
  />
{/if}

<style>
  .sc-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
    padding: 8px 12px;
    border-top: 1px solid var(--color-line);
  }
  .sc-name {
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-mono);
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
  }
  .sc-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .sc-empty {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    margin: 2px 0 0;
    padding: 0 12px 8px 22px;
  }
  .sc-btn {
    font: inherit;
    font-size: var(--fs-meta);
    background: transparent;
    border: 1px solid var(--color-line);
    padding: 2px 8px;
    color: var(--color-ink);
    cursor: pointer;
  }
</style>
