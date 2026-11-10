<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import type { ScheduleInterval } from "#lib/types.js";
  import type { intervalStats } from "#lib/schedules.svelte.js";

  let {
    everyMinutes = $bindable(),
    intervalFrom = $bindable(),
    intervalUntil = $bindable(),
    allDay = $bindable(),
    stats,
  }: {
    everyMinutes: ScheduleInterval["everyMinutes"];
    intervalFrom: string;
    intervalUntil: string;
    allDay: boolean;
    stats: ReturnType<typeof intervalStats>;
  } = $props();
  const uid = $props.id();
</script>

<div class="field">
  <label for={`${uid}-every`}>{m.schedules_cadence_interval()}</label>
  <select id={`${uid}-every`} bind:value={everyMinutes}>
    {#each [5, 10, 15, 30, 60] as n (n)}
      <option value={n}>{m.schedules_every_minutes({ n })}</option>
    {/each}
  </select>
</div>
<label class="all-day"
  ><input type="checkbox" bind:checked={allDay} />{m.schedules_interval_all_day()}</label
>
{#if !allDay}
  <div class="interval-window">
    <div class="field">
      <label for={`${uid}-from`}>{m.schedules_interval_from()}</label>
      <input
        id={`${uid}-from`}
        type="time"
        required
        bind:value={intervalFrom}
        aria-invalid={!stats}
        aria-describedby={!stats ? `${uid}-interval-error` : undefined}
      />
    </div>
    <div class="field">
      <label for={`${uid}-until`}>{m.schedules_interval_until()}</label>
      <input
        id={`${uid}-until`}
        type="time"
        required
        bind:value={intervalUntil}
        aria-invalid={!stats}
        aria-describedby={!stats ? `${uid}-interval-error` : undefined}
      />
    </div>
  </div>
  {#if !stats}<p class="error" id={`${uid}-interval-error`}>
      {m.schedules_interval_end_error()}
    </p>{/if}
{/if}
{#if stats}<p class="hint">{m.schedules_interval_stats(stats)}</p>{/if}
<p class="hint">{m.schedules_interval_overlap()}</p>
<p class="hint">{m.schedules_times_hint()}</p>

<style>
  .interval-window {
    display: flex;
    gap: 8px;
  }
  .interval-window .field {
    flex: 1;
    min-width: 0;
  }
  .all-day {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 44px;
    font-size: var(--fs-base);
  }
  .all-day input {
    width: auto;
  }
  .hint {
    margin: 0;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    line-height: 1.5;
  }
  .error {
    margin: 0;
    font-size: var(--fs-meta);
    color: var(--color-red);
  }
  input[aria-invalid="true"] {
    border-color: var(--color-red);
  }
</style>
