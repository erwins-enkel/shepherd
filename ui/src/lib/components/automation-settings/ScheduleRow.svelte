<script lang="ts">
  import { onDestroy } from "svelte";
  import { resolve } from "$app/paths";
  import { m } from "#lib/paraglide/messages.js";
  import { getLocale } from "#lib/i18n.js";
  import { basename } from "#lib/basename.js";
  import {
    schedules,
    cadenceSummary,
    outcomeLabel,
    outcomeTone,
    usageLimitChip,
  } from "#lib/schedules.svelte.js";
  import { listScheduleRuns } from "#lib/api.js";
  import { relativeTimeAgo } from "#lib/format.js";
  import { clock } from "#lib/now.svelte.js";
  import { scheduleUsageLimitExplanation } from "#lib/tooltips/explanations.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import type { Schedule, ScheduleRun } from "#lib/types.js";

  // Shared by Repo automation and Settings → Schedules (which also shows the repo).
  let {
    schedule: s,
    showRepo = false,
    onedit,
  }: { schedule: Schedule; showRepo?: boolean; onedit: () => void } = $props();

  const timeFmt = $derived(
    new Intl.DateTimeFormat(getLocale(), {
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    }),
  );
  const historyFmt = $derived(
    new Intl.DateTimeFormat(getLocale(), { dateStyle: "short", timeStyle: "short" }),
  );
  const scheduleId = $derived(s.id);
  const historyRevision = $derived(schedules.revisionFor(s.repoPath));
  const historyId = $props.id();
  let historyOpen = $state(false);
  let loading = $state(false);
  let failed = $state(false);
  let runs = $state<ScheduleRun[]>([]);

  $effect(() => {
    if (!historyOpen) return;
    void historyRevision;
    let current = true;
    loading = true;
    failed = false;
    void listScheduleRuns(scheduleId)
      .then((list) => {
        if (current) runs = list.slice(0, 20);
      })
      .catch(() => {
        if (current) failed = true;
      })
      .finally(() => {
        if (current) loading = false;
      });
    // A newer request, closing the disclosure or unmounting invalidates this response.
    return () => {
      current = false;
    };
  });

  let armed = $state(false);
  let deleteTimer: ReturnType<typeof setTimeout> | undefined;
  const deleteLabel = $derived(armed ? m.schedules_delete_confirm() : m.schedules_delete());
  onDestroy(() => clearTimeout(deleteTimer));

  function clickDelete() {
    clearTimeout(deleteTimer);
    if (armed) {
      armed = false;
      void schedules.remove(s);
      return;
    }
    armed = true;
    deleteTimer = setTimeout(() => (armed = false), 4000);
  }
</script>

<li class="sc-row">
  <div class="sc-meta">
    <div class="sc-title">
      {#if showRepo}<span class="sc-repo" title={s.repoPath}>{basename(s.repoPath)}</span>{/if}
      {s.name}
    </div>
    <div class="sc-cadence">{cadenceSummary(s.days, s.times, getLocale(), s.interval)}</div>
    <div class="sc-chips">
      {#if s.usageLimit}
        <button
          type="button"
          class="sc-chip"
          use:statusTip={{ text: scheduleUsageLimitExplanation(s.usageLimit), wide: true }}
          >{usageLimitChip(s.usageLimit)}</button
        >
      {/if}
      <span class="sc-chip"
        >{s.launch.agentProvider === "claude"
          ? m.agent_provider_claude()
          : s.launch.agentProvider === "codex"
            ? m.agent_provider_codex()
            : m.schedules_default_engine()}</span
      >
      <span class="sc-chip"
        >{s.launch.research ? m.schedules_mode_research() : m.schedules_mode_code()}</span
      >
    </div>
    <div class="sc-times">
      {#if s.nextAt !== null}
        <span>{m.schedules_next({ when: timeFmt.format(new Date(s.nextAt)) })}</span>
      {/if}
      {#if s.lastRun}
        <button
          type="button"
          class={["sc-last", "sc-outcome", outcomeTone(s.lastRun.outcome)]}
          aria-expanded={historyOpen}
          aria-controls={historyId}
          onclick={() => (historyOpen = !historyOpen)}
          >{m.schedules_last_ago({
            outcome: outcomeLabel(s.lastRun.outcome, s.lastRun.reason, s.lastRun.usage),
            ago: relativeTimeAgo(s.lastRun.at, clock.current, getLocale()),
          })}</button
        >
      {/if}
    </div>
    {#if s.lastRun?.outcome === "noop" && s.lastRun.reason}
      <div class="sc-summary">{s.lastRun.reason}</div>
    {/if}
  </div>
  <div class="sc-controls">
    <button
      type="button"
      class="sc-history-button"
      aria-expanded={historyOpen}
      aria-controls={historyId}
      onclick={() => (historyOpen = !historyOpen)}>{m.schedules_history()}</button
    >
    <div class="sc-actions">
      <button
        type="button"
        class="icon-btn"
        aria-label={m.schedules_run_now()}
        use:statusTip={{
          text: m.schedules_run_now(),
          pinOnClick: false,
          stopClickPropagation: false,
        }}
        onclick={() => void schedules.runNow(s)}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"><path d="m8 5 11 7-11 7z" /></svg
        >
      </button>
      <button
        type="button"
        class="icon-btn"
        aria-label={m.schedules_edit()}
        use:statusTip={{ text: m.schedules_edit(), pinOnClick: false, stopClickPropagation: false }}
        onclick={onedit}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"><path d="m16 3 5 5-12 12-6 1 1-6zM14 5l5 5" /></svg
        >
      </button>
      <button
        type="button"
        class={["icon-btn", { armed }]}
        aria-label={deleteLabel}
        use:statusTip={{ text: deleteLabel, pinOnClick: false, stopClickPropagation: false }}
        onclick={clickDelete}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></svg
        >
      </button>
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
  </div>
  {#if historyOpen}
    <div class="sc-history" id={historyId} aria-busy={loading}>
      {#if loading}
        <p>{m.common_loading()}</p>
      {:else if failed}
        <p role="alert">{m.schedules_history_failed()}</p>
      {:else if runs.length === 0}
        <p>{m.schedules_history_empty()}</p>
      {:else}
        <ul>
          {#each runs as run (run.id)}
            <li>
              <time datetime={new Date(run.at).toISOString()}
                >{historyFmt.format(new Date(run.at))}</time
              >
              <span class={["sc-outcome", outcomeTone(run.outcome)]}
                >{outcomeLabel(run.outcome, run.reason, run.usage)}</span
              >
              {#if run.outcome === "noop" && run.reason}<span class="sc-summary">{run.reason}</span
                >{/if}
              {#if run.sessionId}<a
                  data-sveltekit-reload
                  href={resolve(`/?session=${encodeURIComponent(run.sessionId)}`)}
                  >{run.sessionId}</a
                >{/if}
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</li>

<style>
  .sc-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px 12px;
    padding: 10px 12px 10px 22px;
    border-top: 1px solid var(--color-line);
    background: var(--color-panel);
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .sc-meta {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .sc-title {
    color: var(--color-ink);
    font-weight: 600;
  }
  .sc-repo {
    font-family: var(--font-mono);
    color: var(--color-muted);
    margin-right: 6px;
    font-weight: 400;
  }
  .sc-cadence {
    font-family: var(--font-mono);
    margin-top: 3px;
  }
  .sc-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 6px;
  }
  .sc-chip {
    padding: 1px 6px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
  }
  .sc-times {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    margin-top: 6px;
  }
  .sc-last,
  .sc-history-button {
    font: inherit;
    color: inherit;
    background: transparent;
    border: 0;
    padding: 0;
    text-align: left;
    cursor: pointer;
  }
  .sc-last:hover,
  .sc-history-button:hover {
    text-decoration: underline;
  }
  .sc-last:focus-visible,
  .sc-history-button:focus-visible,
  .sc-sw:focus-visible {
    outline: 1px solid var(--color-amber);
    outline-offset: 2px;
  }
  .sc-outcome.red {
    color: var(--color-red);
  }
  .sc-outcome.amber {
    color: var(--color-amber);
  }
  .sc-summary {
    overflow-wrap: anywhere;
  }
  .sc-meta > .sc-summary {
    margin-top: 3px;
  }
  .sc-controls {
    display: flex;
    align-items: center;
    align-self: start;
    gap: 8px;
  }
  .sc-actions {
    display: flex;
    flex-shrink: 0;
    gap: 2px;
  }
  .icon-btn {
    color: var(--color-muted);
  }
  .icon-btn:hover {
    color: var(--color-ink-bright);
  }
  .icon-btn.armed {
    color: var(--color-red);
  }
  .sc-history {
    grid-column: 1 / -1;
    min-width: 0;
    border-top: 1px solid var(--color-line);
    padding-top: 8px;
  }
  .sc-history p {
    margin: 0;
  }
  .sc-history ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .sc-history li {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    padding: 4px 0;
    overflow-wrap: anywhere;
  }
  .sc-history time,
  .sc-history a {
    font-family: var(--font-mono);
  }
  .sc-history a {
    color: var(--color-blue);
  }
  .sc-sw {
    flex: 0 0 auto;
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
  @media (max-width: 768px) {
    .sc-row {
      grid-template-columns: minmax(0, 1fr);
      padding-left: 12px;
    }
    .sc-controls {
      flex-wrap: wrap;
    }
    .sc-sw {
      margin-left: auto;
    }
    .icon-btn {
      width: var(--mobile-actionbar-hit);
      height: var(--mobile-actionbar-hit);
    }
    .sc-history-button {
      min-height: var(--mobile-actionbar-hit);
    }
  }
</style>
