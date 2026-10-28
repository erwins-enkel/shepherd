<script lang="ts">
  import type { Snippet } from "svelte";
  import { formatReset, formatResetIn } from "#lib/format.js";
  import { m } from "#lib/paraglide/messages.js";
  import { gaugeColor, type GaugeKey, type HottestCapacityWindow } from "../usage-gauges";

  // The usage panel's hero: the window nearest its cap, the hold limit drawn on its bar, and what
  // crossing that limit is holding back right now — cause and effect in one block.
  let {
    hottest,
    pending,
    nowMs,
    periodLabel,
    holdPct,
    heldCount,
    pausedCount,
    action,
  }: {
    hottest: HottestCapacityWindow;
    /** Past its reset, awaiting the provider's confirmation (Claude observed windows only). */
    pending: boolean;
    nowMs: number;
    periodLabel: (k: GaugeKey) => string;
    /** The hold limit (`usageHoldPct`); null = none known. */
    holdPct: number | null;
    heldCount: number;
    pausedCount: number;
    /** The capacity-failover action, rendered under the reset line. */
    action: Snippet;
  } = $props();

  // Promoting this window is the whole point of the layout: the limit that decides whether you can
  // start another agent used to be indistinguishable from three idle ones, and could sit at the
  // very bottom of the panel.
  const bindingColor = $derived(gaugeColor(hottest.window.usedPct));
  const bindingProvider = $derived(
    hottest.provider === "codex" ? m.agent_provider_codex() : m.agent_provider_claude(),
  );
  // Holding compares Claude's 5-hour and weekly windows against the limit, so only a Claude hero
  // carries the tick; a hotter Codex window is measured by its own capacity check instead.
  const heroLimit = $derived(holdPct !== null && hottest.provider === "claude" ? holdPct : null);
  const heroOver = $derived(heroLimit !== null && hottest.window.usedPct >= heroLimit);
  // Keep the tick's caption inside the bar near either end.
  const limitShift = $derived(
    heroLimit === null ? "-50%" : heroLimit >= 88 ? "-100%" : heroLimit <= 12 ? "0%" : "-50%",
  );
</script>

<!-- Deliberately ALSO left in its own section of the panel: the sections stay complete lists while
     the hero moves between them as load shifts, so a promoted row must not leave a hole. -->
<!-- Dimmed with its source row: `hottest.stale` is the staleness of the provider row the window was
     selected from, so the promoted copy and the copy still sitting in its section always read the
     same. Without it a stale window would be shown at full strength up here while its twin is dimmed. -->
<div class="usage-hero" class:stale={hottest.stale}>
  <span class="hero-glow" aria-hidden="true"></span>
  <span class="hero-scan" aria-hidden="true"></span>
  <div class="hero-body">
    <div class="hero-eyebrow">{m.topbar_usage_binding_title()}</div>
    <div class="hero-head">
      <span class="hero-pct" style="color:{bindingColor}"
        >{hottest.window.usedPct}<span class="hero-unit">%</span></span
      >
      <span class="hero-window">{bindingProvider} · {periodLabel(hottest.window.key)}</span>
    </div>
    <!-- What the limit is doing right now, named beside the number that causes it. -->
    {#if pausedCount > 0 || heldCount > 0}
      <div class="hero-effects">
        {#if pausedCount > 0}
          <span class="effect effect-paused">
            <svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"
              ><rect x="2.5" y="2" width="2.5" height="8" /><rect
                x="7"
                y="2"
                width="2.5"
                height="8"
              /></svg
            >{m.capacity_effect_paused()}
          </span>
        {/if}
        {#if heldCount > 0}
          <span class="effect effect-held">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M5 2h14M5 22h14" />
              <path d="M7 2v4.2a2 2 0 0 0 .6 1.4L12 12l4.4-4.4a2 2 0 0 0 .6-1.4V2" />
              <path d="M17 22v-4.2a2 2 0 0 0-.6-1.4L12 12l-4.4 4.4a2 2 0 0 0-.6 1.4V22" />
            </svg>{m.topbar_held_badge({ count: heldCount })}
          </span>
        {/if}
      </div>
    {:else if heroLimit !== null}
      <div class="hero-effects">
        <span class="effect-quiet"
          >{heroOver ? m.capacity_over_limit() : m.capacity_below_limit()}</span
        >
      </div>
    {/if}
    <div class="hero-track" class:limited={heroLimit !== null}>
      {#if heroLimit !== null}
        <span class="hero-limit-label" style="left:{heroLimit}%;--shift:{limitShift}"
          >{m.capacity_limit({ pct: heroLimit })}</span
        >
      {/if}
      <span class="hero-bar"
        ><span
          class="hero-fill"
          style="transform:scaleX({hottest.window.usedPct / 100});background:{bindingColor}"
        ></span>{#if heroOver && heroLimit !== null}<span
            class="hero-over"
            style="left:{heroLimit}%;width:{Math.min(hottest.window.usedPct, 100) - heroLimit}%"
            aria-hidden="true"
          ></span>{/if}</span
      >
      {#if heroLimit !== null}
        <span class="hero-tick" style="left:{heroLimit}%" aria-hidden="true"></span>
      {/if}
    </div>
    <div class="hero-foot">
      {#if pending}
        <span>{m.topbar_usage_reset_checking()}</span>
      {:else}
        <span>{m.topbar_usage_free_in({ rel: formatResetIn(hottest.window.resetAt, nowMs) })}</span>
        <span>{formatReset(hottest.window.resetAt, nowMs, { withTime: true })}</span>
      {/if}
    </div>
    {@render action()}
  </div>
</div>

<style>
  .usage-hero.stale {
    opacity: 0.5;
  }
  .usage-hero {
    position: relative;
    overflow: hidden;
    margin-bottom: 17px;
    padding: 12px 13px 13px;
    border: 1px solid color-mix(in srgb, var(--color-amber) 26%, var(--color-line-bright));
    border-radius: 2px;
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--color-amber) 7%, var(--color-panel-2)),
      var(--color-panel-2)
    );
  }
  .hero-glow {
    position: absolute;
    inset: 0;
    background: radial-gradient(
      120% 90% at 8% 30%,
      color-mix(in srgb, var(--color-amber) 20%, transparent),
      transparent 62%
    );
  }
  .hero-scan {
    position: absolute;
    inset: 0;
    background: repeating-linear-gradient(
      180deg,
      color-mix(in srgb, var(--color-amber) 6%, transparent) 0 1px,
      transparent 1px 3px
    );
  }
  .hero-body {
    position: relative;
  }
  .hero-eyebrow {
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    margin-bottom: 7px;
  }
  .hero-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 11px;
    font-variant-numeric: tabular-nums;
  }
  .hero-pct {
    font-size: calc(2.125 * var(--fs-lg));
    font-weight: 700;
    line-height: 1;
    letter-spacing: -0.02em;
  }
  .hero-unit {
    font-size: var(--fs-lg);
    font-weight: 400;
    margin-left: 3px;
    opacity: 0.72;
  }
  .hero-window {
    color: var(--color-ink);
    font-size: var(--fs-meta);
    text-align: right;
  }
  /* The consequence line: what the limit is holding back right now, beside the number. */
  .hero-effects {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 8px;
    margin: -3px 0 12px;
  }
  .effect {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 9px;
    border: 1px solid;
    border-radius: var(--radius-chip);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .effect svg {
    width: 10px;
    height: 10px;
    flex-shrink: 0;
  }
  /* Subordinate red (text + hairline + tint, no halo): a paused drain, not a blocked agent. */
  .effect-paused {
    color: var(--color-red);
    border-color: color-mix(in srgb, var(--color-red) 50%, var(--color-line));
    background: color-mix(in srgb, var(--color-red) 10%, transparent);
  }
  .effect-held {
    color: var(--color-amber);
    border-color: color-mix(in srgb, var(--color-amber) 55%, var(--color-line));
    background: color-mix(in srgb, var(--color-amber) 8%, transparent);
  }
  .effect-quiet {
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }
  .hero-track {
    position: relative;
  }
  /* Room above the bar for the limit's caption. */
  .hero-track.limited {
    margin-top: 24px;
  }
  .hero-limit-label {
    position: absolute;
    bottom: calc(100% + 7px);
    transform: translateX(var(--shift));
    color: var(--color-ink-bright);
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .hero-tick {
    position: absolute;
    top: -5px;
    bottom: -5px;
    width: 2px;
    margin-left: -1px;
    background: var(--color-ink-bright);
  }
  /* The share of the bar past the limit is hatched: the part that is holding work back. */
  .hero-over {
    position: absolute;
    top: 0;
    bottom: 0;
    background: repeating-linear-gradient(
      135deg,
      color-mix(in srgb, var(--color-bg) 60%, transparent) 0 2px,
      transparent 2px 4px
    );
  }
  .hero-bar {
    position: relative;
    display: block;
    height: 11px;
    background: var(--color-line);
    border: 1px solid var(--color-line-bright);
    overflow: hidden;
  }
  .hero-fill {
    display: block;
    width: 100%;
    height: 100%;
    transform-origin: left;
    transition: transform 0.6s ease;
  }
  .hero-foot {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    margin-top: 9px;
    color: var(--color-faint);
    font-size: var(--fs-micro);
    letter-spacing: 0.06em;
  }
</style>
