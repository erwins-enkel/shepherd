<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { getLocale } from "#lib/i18n.js";
  import { schedules, cadenceSummary, outcomeLabel } from "#lib/schedules.svelte.js";
  import { schedulesExplanation } from "#lib/tooltips/explanations.js";
  import InfoTip from "../InfoTip.svelte";
  import ScheduleDialog from "./ScheduleDialog.svelte";
  import type { Schedule } from "#lib/types.js";

  // Operator schedules (#3469): this repo's recurring prompts — list, enable switch, run now, and
  // add/edit in ScheduleDialog. Self-contained (own row + switch styles) so AutomationSettings'
  // template, which sits at its complexity bar, only gains one tag.
  let { repoPath }: { repoPath: string } = $props();

  $effect(() => {
    void schedules.load(repoPath);
  });

  const list = $derived(schedules.listFor(repoPath) ?? []);
  /** null = closed; "new" = add; a schedule = edit it. */
  let editing = $state<Schedule | "new" | null>(null);

  const timeFmt = $derived(
    new Intl.DateTimeFormat(getLocale(), {
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    }),
  );

  // Delete is two-step: the first click arms it (the label asks to confirm), the second deletes.
  let armedDelete = $state<string | null>(null);
  function clickDelete(s: Schedule) {
    if (armedDelete === s.id) {
      armedDelete = null;
      void schedules.remove(s);
      return;
    }
    armedDelete = s.id;
    setTimeout(() => {
      if (armedDelete === s.id) armedDelete = null;
    }, 4000);
  }
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
      <li class="sc-row">
        <div class="sc-meta">
          <div class="sc-title">{s.name}</div>
          <div class="sc-desc">{cadenceSummary(s.days, s.times, getLocale())}</div>
          <div class="sc-desc">
            {#if s.nextAt !== null}
              {m.schedules_next({ when: timeFmt.format(new Date(s.nextAt)) })}
            {/if}
            {#if s.lastRun}
              <span class={["sc-outcome", s.lastRun.outcome.replace(":", "-")]}
                >{m.schedules_last({ outcome: outcomeLabel(s.lastRun.outcome) })}</span
              >
            {/if}
          </div>
          <div class="sc-actions">
            <button type="button" class="sc-link" onclick={() => void schedules.runNow(s)}
              >{m.schedules_run_now()}</button
            >
            <button type="button" class="sc-link" onclick={() => (editing = s)}
              >{m.schedules_edit()}</button
            >
            <button
              type="button"
              class={["sc-link", { armed: armedDelete === s.id }]}
              onclick={() => clickDelete(s)}
              >{armedDelete === s.id ? m.schedules_delete_confirm() : m.schedules_delete()}</button
            >
          </div>
        </div>
        <button
          class={["sc-sw", { on: s.enabled }]}
          type="button"
          role="switch"
          aria-checked={s.enabled}
          aria-label={m.schedules_enabled_aria({ name: s.name })}
          onclick={() => void schedules.setEnabled(s, !s.enabled)}
        >
          <span class="knob"></span>
        </button>
      </li>
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
  /* Mirrors AutomationBootstrap's row / switch (scoped there, so not reachable from here). */
  .sc-head,
  .sc-row {
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
  .sc-row {
    padding-left: 22px;
    background: var(--color-panel);
  }
  .sc-meta {
    min-width: 0;
  }
  .sc-title {
    font-size: var(--fs-meta);
    color: var(--color-ink);
    overflow-wrap: anywhere;
  }
  .sc-desc,
  .sc-empty {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    margin: 2px 0 0;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .sc-empty {
    padding: 0 12px 8px 22px;
  }
  .sc-outcome.error,
  .sc-outcome.claimed {
    color: var(--color-red);
  }
  .sc-outcome.skipped-overlap,
  .sc-outcome.skipped-stale,
  .sc-outcome.held {
    color: var(--color-amber);
  }
  .sc-actions {
    display: flex;
    gap: 10px;
    margin-top: 4px;
  }
  .sc-link,
  .sc-btn {
    font: inherit;
    font-size: var(--fs-meta);
    background: transparent;
    border: 0;
    padding: 0;
    color: var(--color-blue);
    cursor: pointer;
  }
  .sc-link.armed {
    color: var(--color-red);
  }
  .sc-btn {
    border: 1px solid var(--color-line);
    padding: 2px 8px;
    color: var(--color-ink);
  }
  .sc-sw {
    flex: 0 0 auto;
    margin-top: 2px;
    width: 30px;
    height: 17px;
    border-radius: 2px;
    border: 1px solid var(--color-line);
    background: var(--color-faint);
    position: relative;
    cursor: pointer;
    padding: 0;
    transition: background 0.12s;
  }
  .sc-sw .knob {
    position: absolute;
    top: 1px;
    left: 1px;
    width: 13px;
    height: 13px;
    border-radius: 2px;
    background: var(--color-slate);
    transition:
      left 0.12s,
      background 0.12s;
  }
  .sc-sw.on {
    background: var(--color-amber);
  }
  .sc-sw.on .knob {
    left: 15px;
    background: var(--color-inset);
  }
</style>
