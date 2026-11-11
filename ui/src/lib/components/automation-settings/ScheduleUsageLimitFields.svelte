<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { getLocale } from "#lib/i18n.js";
  import { usageLimitPreview, usageLimitVerdict } from "#lib/schedules.svelte.js";
  import type { AgentProvider, ScheduleUsageLimit, UsageLimits } from "#lib/types.js";

  let {
    value = $bindable(null),
    provider,
    limits,
    holdPct,
    valid,
  }: {
    value: ScheduleUsageLimit | null;
    provider: AgentProvider;
    limits: UsageLimits | null;
    holdPct: number;
    valid: boolean;
  } = $props();
  const preview = $derived(value ? usageLimitPreview(value, provider, limits) : null);
  const providerName = $derived(provider === "claude" ? "Claude Code" : "Codex");
  const start = $derived(value?.kind === "from" ? value.startPct : 0);
  const stop = $derived(value?.stopPct ?? 100);
  const pct = $derived(preview?.markerPct ?? null);
  const windowName = (window: "week" | "5h") =>
    window === "week" ? m.schedules_limit_weekly() : m.schedules_limit_5hour();
  const clamp = (n: number) => Math.max(0, Math.min(100, n));
  const meterText = $derived(
    m.schedules_limit_meter({
      start,
      stop,
      now: pct === null ? m.schedules_limit_unknown() : m.schedules_limit_now({ pct }),
    }),
  );
</script>

<h3>{m.schedules_limit_section()}</h3>
<div class="limit-segments" role="group" aria-label={m.schedules_limit_section()}>
  <button type="button" aria-pressed={value === null} onclick={() => (value = null)}
    >{m.schedules_limit_none()}</button
  >
  <button
    type="button"
    aria-pressed={value?.kind === "upTo"}
    onclick={() => {
      if (value?.kind !== "upTo") value = { kind: "upTo", stopPct: 70 };
    }}>{m.schedules_limit_up()}</button
  >
  <button
    type="button"
    aria-pressed={value?.kind === "from"}
    onclick={() => {
      if (value?.kind !== "from")
        value = { kind: "from", startPct: 80, startWindow: "week", stopPct: 95 };
    }}>{m.schedules_limit_from()}</button
  >
</div>
{#if value}
  {#if value.kind === "from"}
    <label class="field"
      ><span>{m.schedules_limit_start()} (%) · {m.schedules_limit_used()}</span>
      <input type="number" min="0" max="95" step="5" required bind:value={value.startPct} />
    </label>
    <div class="limit-segments" role="group" aria-label={m.schedules_limit_window()}>
      <button
        type="button"
        aria-pressed={value.startWindow === "week"}
        onclick={() => {
          if (value?.kind === "from") value.startWindow = "week";
        }}>{m.schedules_limit_week()}</button
      >
      <button
        type="button"
        aria-pressed={value.startWindow === "5h"}
        onclick={() => {
          if (value?.kind === "from") value.startWindow = "5h";
        }}>{m.schedules_limit_5h()}</button
      >
    </div>
  {/if}
  <label class="field"
    ><span>{m.schedules_limit_stop()} (%) · {m.schedules_limit_used()}</span>
    <input
      type="number"
      min={value.kind === "from" ? value.startPct + 5 : 5}
      max="100"
      step="5"
      required
      bind:value={value.stopPct}
    />
  </label>
  <div
    class="usage-meter"
    role={pct === null ? "group" : "meter"}
    aria-label={pct === null ? meterText : m.schedules_limit_section()}
    aria-valuemin={pct === null ? undefined : 0}
    aria-valuemax={pct === null ? undefined : 100}
    aria-valuenow={pct === null ? undefined : clamp(pct)}
    aria-valuetext={pct === null ? undefined : meterText}
  >
    <div
      class="allowed"
      style:left={`${clamp(start)}%`}
      style:width={`${Math.max(0, clamp(stop) - clamp(start))}%`}
    ></div>
    <div
      class="stop-zone"
      style:left={`${clamp(stop)}%`}
      style:width={`${100 - clamp(stop)}%`}
    ></div>
    {#if pct !== null}<span class="marker" style:left={`${clamp(pct)}%`}></span>{/if}
  </div>
  <div class="meter-scale">
    <span>0 %</span><span
      >{pct === null ? m.schedules_limit_unknown() : m.schedules_limit_now({ pct })}</span
    ><span>100 %</span>
  </div>
  <p>
    {value.kind === "upTo"
      ? m.schedules_limit_up_body({ provider: providerName, stop })
      : m.schedules_limit_from_body({
          provider: providerName,
          start,
          stop,
          window: windowName(value.startWindow),
        })}
  </p>
  {#if preview}
    <p class="verdict">{usageLimitVerdict(preview)}</p>
    {#if preview.resetAt !== null}
      <p>
        {m.schedules_limit_reset({
          window: windowName(preview.resetWindow),
          when: new Date(preview.resetAt).toLocaleString(getLocale()),
        })}
      </p>
    {/if}
  {/if}
  <p>{m.schedules_limit_replaces({ hold: holdPct })}</p>
{:else}
  <p>
    {provider === "codex"
      ? m.schedules_limit_none_codex()
      : m.schedules_limit_none_body({ hold: holdPct })}
  </p>
{/if}

{#if !valid}<p class="error">{m.schedules_limit_invalid()}</p>{/if}

<style>
  h3 {
    margin: 0;
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
  }
  p {
    margin: 0;
    font-size: var(--fs-meta);
    line-height: 1.5;
    color: var(--color-muted);
  }
  .error {
    color: var(--color-red);
  }
  .verdict {
    color: var(--color-ink);
  }
  .limit-segments {
    display: flex;
    gap: 4px;
  }
  .limit-segments button {
    flex: 1;
    padding: 8px 4px;
    min-height: 36px;
    border: 1px solid var(--color-line);
    background: var(--color-inset);
    color: var(--color-muted);
    font-size: var(--fs-meta);
    cursor: pointer;
  }
  .limit-segments button[aria-pressed="true"] {
    color: var(--color-amber);
    border-color: var(--color-amber);
  }
  .limit-segments button:hover {
    background: var(--color-hover);
  }
  .usage-meter {
    position: relative;
    height: 16px;
    border: 1px solid var(--color-line-bright);
    background: var(--color-inset);
  }
  .allowed,
  .stop-zone {
    position: absolute;
    top: 0;
    height: 100%;
  }
  .allowed {
    background: var(--color-slate);
  }
  .stop-zone {
    background: repeating-linear-gradient(
      135deg,
      var(--color-line-bright) 0 2px,
      transparent 2px 6px
    );
  }
  .marker {
    position: absolute;
    height: 24px;
    top: -5px;
    width: 2px;
    background: var(--color-ink-bright);
    transform: translateX(-50%);
  }
  .meter-scale {
    display: flex;
    justify-content: space-between;
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    color: var(--color-muted);
    gap: 4px;
  }
  @media (max-width: 768px) {
    .limit-segments button {
      min-height: 44px;
    }
  }
</style>
