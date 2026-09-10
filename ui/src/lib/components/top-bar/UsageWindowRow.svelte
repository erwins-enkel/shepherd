<script lang="ts">
  import { formatResetIn } from "$lib/format";
  import { m } from "$lib/paraglide/messages";
  import { gaugeColor } from "../usage-gauges";

  // The usage popover's row: label, bar, percentage and the countdown to the reset, on ONE line.
  //
  // Deliberately its own component rather than a mode on LimitGaugeRow: that row is shared with the
  // usage dashboard and the gear menu, where the reset and provider-confirmation lines under each
  // bar have room and earn their place. Here four windows meant eight extra lines repeating the
  // same two facts, so the countdown moves into the row and the age is stamped once in the header.
  //
  // Takes primitives rather than a LimitWindow so per-model passthroughs (nullable resetAt) render
  // through the same row instead of forking a near-identical one.
  let {
    label,
    pct,
    resetAt,
    nowMs,
    pending = false,
    age = null,
  }: {
    label: string;
    pct: number;
    resetAt: number | null;
    nowMs: number;
    /** Past its reset, awaiting the confirming scrape — `pct` still describes the OLD window. */
    pending?: boolean;
    /**
     * This window's OWN provider-confirmation age, rendered only when the popover could not
     * honestly collapse every window's age into its one header stamp. Never a sibling's.
     */
    age?: string | null;
  } = $props();

  const fill = $derived(Math.min(Math.max(pct, 0), 100) / 100);
  const color = $derived(gaugeColor(pct));
</script>

<div class="uw-row">
  <span class="uw-label">{label}</span>
  <span class="uw-bar"
    ><span class="uw-fill" style="transform:scaleX({fill});background:{color}"></span></span
  >
  <!-- Past its reset, the number describes the window BEFORE the rollover, so it must never be
       presented as a bare current value. The countdown cell is empty then, so the qualified label
       borrows its width. -->
  <span class="uw-pct" class:before-reset={pending} style="color:{color}"
    >{pending ? m.topbar_usage_before_reset({ pct }) : `${pct}%`}</span
  >
  {#if !pending}
    <span class="uw-rest">{resetAt === null ? "" : formatResetIn(resetAt, nowMs)}</span>
  {/if}
</div>
{#if pending}
  <!-- Alert by exception: the one case that still earns a second line, because the number above it
       is knowingly describing the window before the reset. -->
  <div class="reset-pending">{m.topbar_usage_reset_checking()}</div>
{/if}
{#if age !== null}
  <div class="uw-age">
    {age === "now" ? m.topbar_usage_observed_now() : m.topbar_usage_observed_age({ age })}
  </div>
{/if}

<style>
  .uw-row {
    display: grid;
    grid-template-columns: 46px 1fr 34px 28px;
    column-gap: 8px;
    align-items: center;
    font-variant-numeric: tabular-nums;
  }
  .uw-label {
    color: var(--color-ink);
    font-size: var(--fs-micro);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .uw-bar {
    display: block;
    height: 9px;
    background: var(--color-line);
    border: 1px solid var(--color-line-bright);
    overflow: hidden;
  }
  .uw-fill {
    display: block;
    width: 100%;
    height: 100%;
    transform-origin: left;
    transition: transform 0.6s ease;
  }
  .uw-pct {
    font-size: var(--fs-meta);
    text-align: right;
  }
  .uw-pct.before-reset {
    grid-column: 3 / span 2;
    white-space: nowrap;
  }
  .uw-rest {
    color: var(--color-faint);
    font-size: var(--fs-micro);
    text-align: right;
  }
  .uw-age,
  .reset-pending {
    margin: 5px 0 0 54px;
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.04em;
  }
</style>
