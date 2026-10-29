<script lang="ts">
  import type { AutoMergeStatus, HeavySlotSnapshot } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { chipModel, slotActive } from "../heavy-slot/heavy-slot";
  import { activeMergeTrain, mergeTrainIsAttention } from "../queue-strip";
  import { gaugeColor, type HottestCapacityWindow } from "../usage-gauges";

  type TallyStatus = "running" | "idle" | "blocked";

  // The phone's whole top bar (docs/design/mobile-herd, variant E): a READ-ONLY status
  // line. Every action lives in the thumb zone (bottom bar, FABs, Menu sheet), so nothing
  // here is focusable — the ≥44px touch floor never has to be paid in the top band.
  let {
    total,
    working,
    idle,
    blocked,
    statusFilter = null,
    heavySlot = null,
    autoMerge = {},
    heldCount = 0,
    hottest = null,
    holdPct = null,
  }: {
    total: number;
    working: number;
    idle: number;
    blocked: number;
    /** The active status filter, underlined on its tally (display only). */
    statusFilter?: TallyStatus | null;
    heavySlot?: HeavySlotSnapshot | null;
    autoMerge?: Record<string, AutoMergeStatus>;
    heldCount?: number;
    /** The window nearest its cap across both CLIs; drives the % readout and the hairline. */
    hottest?: HottestCapacityWindow | null;
    /** The usage hold limit (null = off); drawn as a tick on the hairline. */
    holdPct?: number | null;
  } = $props();

  const slot = $derived(heavySlot && slotActive(heavySlot) ? chipModel(heavySlot) : null);
  const trains = $derived(activeMergeTrain(autoMerge));
  const trainAttention = $derived(trains.some((t) => mergeTrainIsAttention(t.state!)));
  const pct = $derived(hottest ? Math.round(hottest.window.usedPct) : null);
  const period = $derived(
    hottest?.window.key === "WK"
      ? m.topbar_gauge_period_weekly_short()
      : m.topbar_gauge_period_5h_short(),
  );
</script>

<div class="status-line" role="group" aria-label={m.topbar_status_line_label()}>
  <div class="row">
    <span class="seg"><span class="sr-only">{m.topbar_herd_label()}</span>{total}</span>
    <span class="seg" class:on={statusFilter === "running"}
      ><span class="g amber" aria-hidden="true">●</span><span class="sr-only"
        >{m.topbar_working_label()}</span
      >{working}</span
    >
    <span class="seg" class:on={statusFilter === "idle"} class:zero={idle === 0}
      ><span class="g" aria-hidden="true">◌</span><span class="sr-only"
        >{m.topbar_idle_label()}</span
      >{idle}</span
    >
    <span class="seg" class:on={statusFilter === "blocked"} class:zero={blocked === 0}
      ><span class="g red" aria-hidden="true">!</span><span class="sr-only"
        >{m.topbar_blocked_label()}</span
      >{blocked}</span
    >
    {#if slot}
      <span class="seg meta" class:warm={slot.braking}
        >{#if slot.held > 0}<span class="live" aria-hidden="true"></span>{/if}<span
          aria-hidden="true">▤</span
        ><span class="sr-only">{m.heavyslot_label()}</span
        >{slot.held}/{slot.capacity}{#if slot.waiting > 0}
          <span aria-hidden="true">◔</span>{slot.waiting}{/if}</span
      >
    {/if}
    {#if trains.length > 0}
      <span class="seg meta" class:warm={trainAttention}
        ><span aria-hidden="true">↣</span><span class="sr-only"
          >{m.automation_automerge_name()}</span
        >{trains.length}</span
      >
    {/if}
    {#if heldCount > 0}
      <span class="seg meta held"
        ><span aria-hidden="true">⏸</span><span class="sr-only"
          >{m.topbar_held_badge({ count: heldCount })}</span
        ><span aria-hidden="true">{heldCount}</span></span
      >
    {/if}
    {#if pct !== null}
      <span class="seg usage"
        ><span class="period">{period}</span>
        <b style:color={pct > 50 ? gaugeColor(pct) : undefined}>{pct}%</b></span
      >
    {/if}
  </div>
  {#if pct !== null}
    <div class="hair" aria-hidden="true">
      <i style:width="{Math.min(pct, 100)}%" style:background={gaugeColor(pct)}></i>
      {#if holdPct !== null}<u style:left="{holdPct}%"></u>{/if}
    </div>
  {/if}
</div>

<style>
  .status-line {
    background: var(--color-head);
    border-bottom: 1px solid var(--color-line);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 14px;
    height: 30px;
    padding: 0 max(14px, env(safe-area-inset-right, 0px)) 0
      max(14px, env(safe-area-inset-left, 0px));
    font-size: var(--fs-meta);
    color: var(--color-ink-bright);
    white-space: nowrap;
    overflow: hidden;
  }
  /* Every segment is a numeric readout: mono on the readout itself, not the row. */
  .seg {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    height: 100%;
    box-shadow: inset 0 -2px 0 transparent;
  }
  .seg.on {
    box-shadow: inset 0 -2px 0 var(--color-amber);
  }
  .seg.zero {
    color: var(--color-muted);
  }
  .g {
    color: var(--color-muted);
  }
  .g.amber {
    color: var(--color-amber);
  }
  .g.red {
    color: var(--color-red);
  }
  .meta {
    color: var(--color-muted);
  }
  .meta.warm,
  .held {
    color: var(--color-amber);
  }
  .live {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-amber);
    animation: pulse 1.6s infinite;
  }
  @media (prefers-reduced-motion: reduce) {
    .live {
      animation: none;
    }
  }
  @keyframes pulse {
    50% {
      opacity: 0.25;
    }
  }
  .usage {
    margin-left: auto;
    gap: 5px;
    color: var(--color-muted);
  }
  .usage .period {
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .usage b {
    font-weight: 500;
    color: var(--color-ink-bright);
  }
  .hair {
    position: relative;
    height: 2px;
    background: var(--color-line);
  }
  .hair i {
    position: absolute;
    inset: 0 auto 0 0;
  }
  .hair u {
    position: absolute;
    top: -2px;
    bottom: -2px;
    width: 1px;
    background: var(--color-ink-bright);
    opacity: 0.6;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
