<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { getLocale } from "#lib/i18n.js";
  import { basename } from "#lib/basename.js";
  import { schedules, cadenceSummary, outcomeLabel } from "#lib/schedules.svelte.js";
  import type { Schedule } from "#lib/types.js";

  // One operator schedule (#3469): cadence, next run, last outcome, run now / edit / delete and the
  // enable switch. Shared by a repo's Repo automation list and Settings → Schedules (#3475), which
  // also shows the repo (`showRepo`).
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

  // Delete is two-step: the first click arms it (the label asks to confirm), the second deletes.
  let armed = $state(false);
  function clickDelete() {
    if (armed) {
      armed = false;
      void schedules.remove(s);
      return;
    }
    armed = true;
    setTimeout(() => (armed = false), 4000);
  }
</script>

<li class="sc-row">
  <div class="sc-meta">
    <div class="sc-title">
      {#if showRepo}<span class="sc-repo" title={s.repoPath}>{basename(s.repoPath)}</span>{/if}
      {s.name}
    </div>
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
    {#if s.lastRun?.outcome === "noop" && s.lastRun.reason}
      <!-- The agent's own one-line summary: data, shown verbatim. -->
      <div class="sc-desc sc-summary">{s.lastRun.reason}</div>
    {/if}
    <div class="sc-actions">
      <button type="button" class="sc-link" onclick={() => void schedules.runNow(s)}
        >{m.schedules_run_now()}</button
      >
      <button type="button" class="sc-link" onclick={onedit}>{m.schedules_edit()}</button>
      <button type="button" class={["sc-link", { armed }]} onclick={clickDelete}
        >{armed ? m.schedules_delete_confirm() : m.schedules_delete()}</button
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

<style>
  /* Mirrors AutomationBootstrap's row / switch (scoped there, so not reachable from here). */
  .sc-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
    padding: 8px 12px 8px 22px;
    border-top: 1px solid var(--color-line);
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
  .sc-repo {
    font-family: var(--font-mono);
    color: var(--color-muted);
    margin-right: 6px;
  }
  .sc-desc {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    margin: 2px 0 0;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
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
  .sc-summary {
    overflow-wrap: anywhere;
  }
  .sc-actions {
    display: flex;
    gap: 10px;
    margin-top: 4px;
  }
  .sc-link {
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
