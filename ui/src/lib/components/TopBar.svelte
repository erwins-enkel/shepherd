<script lang="ts">
  import type { Session, UsageLimits, UpdateStatus, HerdrUpdateStatus } from "$lib/types";
  import { formatReset } from "$lib/format";
  import { gaugeList, hotterGauge, type GaugeKey } from "./usage-gauges";
  import { m } from "$lib/paraglide/messages";

  let {
    sessions,
    nowMs,
    connected = false,
    mobile = false,
    touch = false,
    limits = null,
    onsettings,
    needsYou = 0,
    ontriage,
    update = null,
    onupdate,
    herdrUpdate = null,
    onherdrupdate,
  }: {
    sessions: Session[];
    nowMs: number;
    connected?: boolean;
    mobile?: boolean;
    touch?: boolean;
    limits?: UsageLimits | null;
    onsettings?: () => void;
    needsYou?: number;
    ontriage?: () => void;
    update?: UpdateStatus | null;
    onupdate?: () => void;
    herdrUpdate?: HerdrUpdateStatus | null;
    onherdrupdate?: () => void;
  } = $props();

  const updateAvailable = $derived(!!update && update.behind > 0);
  const herdrUpdateAvailable = $derived(!!herdrUpdate && herdrUpdate.updateAvailable);

  const working = $derived(sessions.filter((s) => s.status === "running").length);
  const idle = $derived(sessions.filter((s) => s.status === "idle").length);
  const blocked = $derived(sessions.filter((s) => s.status === "blocked").length);
  const clock = $derived(new Date(nowMs).toTimeString().slice(0, 8));
  const connText = $derived(
    connected ? m.topbar_clock_tip_connected() : m.topbar_clock_tip_disconnected(),
  );

  function gaugeColor(pct: number): string {
    if (pct >= 90) return "var(--color-red)";
    if (pct >= 70) return "var(--color-amber)";
    return "var(--color-green)";
  }

  const periodLabel = (k: GaugeKey) =>
    k === "5H" ? m.topbar_gauge_period_5h() : m.topbar_gauge_period_weekly();

  function gaugeTip(k: GaugeKey, pct: number, resetAt: number): string {
    return `${m.topbar_gauge_title({
      period: periodLabel(k),
      pct,
      reset: formatReset(resetAt, nowMs),
    })}${limits?.stale ? m.topbar_gauge_stale_suffix() : ""}`;
  }

  // Desktop (fine pointer) shows both windows with hover tooltips. Touch has no
  // hover, so it collapses to the window closest to its cap and exposes the full
  // breakdown — including reset times — through a tap popover instead.
  const gauges = $derived(gaugeList(limits));
  const hotter = $derived(hotterGauge(limits));
  let popoverOpen = $state(false);
  let gaugeWrap = $state<HTMLElement | null>(null);
  $effect(() => {
    // close the popover when it can no longer be opened (gauge gone / switched off touch)
    if (!touch || !hotter) popoverOpen = false;
  });

  function dismissOnEscape(e: KeyboardEvent) {
    if (popoverOpen && e.key === "Escape") popoverOpen = false;
  }
  function dismissOnOutside(e: MouseEvent) {
    if (popoverOpen && gaugeWrap && !gaugeWrap.contains(e.target as Node)) popoverOpen = false;
  }
</script>

<svelte:window onkeydown={dismissOnEscape} onclick={dismissOnOutside} />

<div class="hud bracket" class:mobile>
  <div class="logo">SHEP<b>HERD</b></div>
  {#if !mobile && !touch}
    <!-- hidden on phones AND unfolded foldables: the label crowds the bar and
         pushes the gear out on touch layouts narrower than a real desktop -->
    <div class="sep"></div>
    <div class="micro">Mission&nbsp;Control</div>
  {/if}
  <div class="sep"></div>
  {#if mobile}
    <div class="tallies compact">
      <span class="n">{sessions.length}</span>
      <span class="cdot" style="color:var(--color-amber)">●</span><span class="n">{working}</span>
      <span class="csep">·</span><span class="n">{idle}</span>
      <span class="cdot" style="color:var(--color-red)">!</span><span class="n">{blocked}</span>
    </div>
  {:else}
    <div class="tallies">
      <div class="tally">
        <span class="micro">{m.topbar_herd_label()}</span><span class="n">{sessions.length}</span>
      </div>
      <div class="tally">
        <span class="micro" style="color:var(--color-amber)">{m.topbar_working_label()}</span><span
          class="n">{working}</span
        >
      </div>
      <div class="tally">
        <span class="micro">{m.topbar_idle_label()}</span><span class="n">{idle}</span>
      </div>
      <div class="tally">
        <span class="micro" style="color:var(--color-red)">{m.topbar_blocked_label()}</span><span
          class="n">{blocked}</span
        >
      </div>
    </div>
  {/if}
  <div class="rightside">
    {#if needsYou > 0}
      <button
        class="needsyou"
        class:compact={mobile}
        onclick={() => ontriage?.()}
        aria-label={m.common_needs_you({ count: needsYou })}
      >
        {#if mobile}
          <span class="ny-icon" aria-hidden="true">!</span><span class="ny-n">{needsYou}</span>
        {:else}
          {m.common_needs_you({ count: needsYou })}
        {/if}
      </button>
    {/if}
    {#if touch}
      {#if hotter}
        <!-- touch: collapse to the hotter window; tap for the full breakdown -->
        <div class="gauge-wrap" bind:this={gaugeWrap}>
          <button
            class="gauge gauge-btn"
            class:stale={limits?.stale}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={popoverOpen}
            aria-label={m.topbar_gauge_toggle_aria({
              period: periodLabel(hotter.label),
              pct: hotter.w.pct,
            })}
            onclick={() => (popoverOpen = !popoverOpen)}
          >
            <span class="g-label micro">{hotter.label}</span>
            <span class="g-bar"
              ><span
                class="g-fill"
                style="width:{hotter.w.pct}%;background:{gaugeColor(hotter.w.pct)}"
              ></span></span
            >
            <span class="g-pct" style="color:{gaugeColor(hotter.w.pct)}">{hotter.w.pct}%</span>
          </button>
          {#if popoverOpen}
            <div
              class="gauge-pop"
              role="dialog"
              aria-label={m.topbar_gauge_popover_title()}
              class:stale={limits?.stale}
            >
              <div class="gauge-pop-title micro">
                {m.topbar_gauge_popover_title()}{limits?.stale ? m.topbar_gauge_stale_suffix() : ""}
              </div>
              {#each gauges as g (g.label)}
                <div class="gauge-pop-row">
                  <span class="g-label micro">{g.label}</span>
                  <span class="g-bar g-bar-wide"
                    ><span class="g-fill" style="width:{g.w.pct}%;background:{gaugeColor(g.w.pct)}"
                    ></span></span
                  >
                  <span class="g-pct" style="color:{gaugeColor(g.w.pct)}">{g.w.pct}%</span>
                </div>
                <div class="gauge-pop-reset micro">
                  {m.topbar_gauge_reset({ reset: formatReset(g.w.resetAt, nowMs) })}
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    {:else if gauges.length}
      <div class="gauges" class:stale={limits?.stale}>
        {#each gauges as g (g.label)}
          {@const tip = gaugeTip(g.label, g.w.pct, g.w.resetAt)}
          <div class="gauge tip" data-tip={tip} aria-label={tip}>
            <span class="g-label micro">{g.label}</span>
            <span class="g-bar"
              ><span class="g-fill" style="width:{g.w.pct}%;background:{gaugeColor(g.w.pct)}"
              ></span></span
            >
            <span class="g-pct" style="color:{gaugeColor(g.w.pct)}">{g.w.pct}%</span>
          </div>
        {/each}
      </div>
    {/if}
    <div class="clock tip" data-tip={connText} aria-label={connText}>
      <span class="dot" class:on={connected}>●</span><span class="time">{clock}</span>
    </div>
    {#if updateAvailable}
      <button
        class="update-badge"
        class:mobile
        onclick={() => onupdate?.()}
        title="{update!.behind} {update!.behind === 1 ? 'neuer Commit' : 'neue Commits'} auf main"
      >
        <span class="up-dot">▲</span>
        {#if !mobile}<span class="up-label">Update</span>{/if}
        <span class="up-n">{update!.behind}</span>
      </button>
    {/if}
    <!-- Desktop keeps the inline HERDR badge; on a phone it folds into the gear
         (green dot below) to free a slot in the single-row control cluster. -->
    {#if herdrUpdateAvailable && !mobile}
      <button
        class="update-badge herdr"
        onclick={() => onherdrupdate?.()}
        title={m.topbar_herdr_update_title({
          current: herdrUpdate!.current ?? "?",
          latest: herdrUpdate!.latest ?? "?",
        })}
      >
        <span class="up-dot">▲</span>
        <span class="up-label">{m.topbar_herdr_update_badge()}</span>
      </button>
    {/if}
    <button
      class="gear tip"
      class:has-update={herdrUpdateAvailable && mobile}
      type="button"
      onclick={() => onsettings?.()}
      data-tip={m.settings_title()}
      aria-label={m.topbar_settings_aria()}
      >⚙{#if herdrUpdateAvailable && mobile}<span class="gear-dot" aria-hidden="true"
        ></span>{/if}</button
    >
  </div>
</div>

<style>
  .hud {
    position: relative;
    border: 1px solid var(--color-line);
    background: linear-gradient(180deg, var(--color-panel), var(--color-panel-2));
    padding: 12px 16px;
    display: flex;
    align-items: center;
    gap: 22px;
  }
  .bracket::before,
  .bracket::after {
    content: "";
    position: absolute;
    width: 9px;
    height: 9px;
    border: 1px solid var(--color-line-bright);
  }
  .bracket::before {
    top: -1px;
    left: -1px;
    border-right: 0;
    border-bottom: 0;
  }
  .bracket::after {
    bottom: -1px;
    right: -1px;
    border-left: 0;
    border-top: 0;
  }
  .logo {
    font-weight: 700;
    letter-spacing: 0.34em;
    color: var(--color-ink-bright);
    font-size: 15px;
    flex-shrink: 0;
  }
  .logo b {
    color: var(--color-amber);
  }
  .sep {
    width: 1px;
    height: 20px;
    background: var(--color-line-bright);
  }
  .micro {
    font-size: 10.5px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .tallies {
    display: flex;
    gap: 18px;
    align-items: center;
  }
  .tally {
    display: flex;
    gap: 7px;
    align-items: center;
  }
  .tally .n {
    color: var(--color-ink-bright);
    font-weight: 500;
  }
  .needsyou {
    background: color-mix(in srgb, var(--color-red) 18%, transparent);
    border: 1px solid var(--color-red);
    color: var(--color-red);
    letter-spacing: 0.14em;
    font-size: 11px;
    padding: 5px 10px;
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .rightside {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 16px;
  }
  .gear {
    position: relative;
    background: transparent;
    border: 1px solid var(--color-line-bright);
    color: var(--color-muted);
    font-size: 14px;
    line-height: 1;
    padding: 5px 8px;
    border-radius: 2px;
    cursor: pointer;
  }
  .gear:hover {
    color: var(--color-amber);
    border-color: var(--color-amber);
  }
  /* phone-only: the folded HERDR-update cue — a green pip on the gear that mirrors
     the calm green of the desktop badge and rings against the panel to stay legible */
  .gear-dot {
    position: absolute;
    top: 3px;
    right: 3px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--color-green);
    box-shadow: 0 0 0 2px var(--color-panel);
  }
  .gear.has-update {
    border-color: var(--color-green);
  }
  .gauges {
    display: flex;
    gap: 14px;
    align-items: center;
  }
  .gauges.stale {
    opacity: 0.5;
  }
  .gauge {
    display: flex;
    align-items: center;
    gap: 6px;
    font-variant-numeric: tabular-nums;
  }
  .g-label {
    color: var(--color-muted);
  }
  .g-bar {
    width: 46px;
    height: 5px;
    background: var(--color-line);
    border: 1px solid var(--color-line-bright);
    overflow: hidden;
  }
  .g-fill {
    display: block;
    height: 100%;
    transition: width 0.6s ease;
  }
  .g-pct {
    font-size: 11.5px;
    min-width: 30px;
    text-align: right;
  }
  /* Touch: a single collapsed gauge rendered as a tappable button. */
  .gauge-wrap {
    position: relative;
  }
  .gauge-btn {
    background: transparent;
    border: 1px solid transparent;
    border-radius: 2px;
    cursor: pointer;
    font: inherit;
    /* finger-sized tap target, matching the gear on touch HUDs */
    min-height: 40px;
    padding: 0 8px;
  }
  .gauge-btn:hover,
  .gauge-btn[aria-expanded="true"] {
    border-color: var(--color-line-bright);
  }
  .gauge-btn.stale {
    opacity: 0.5;
  }
  /* Popover: full breakdown of every window, anchored under the gauge. */
  .gauge-pop {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    z-index: 50;
    min-width: 200px;
    background: linear-gradient(180deg, var(--color-panel), var(--color-panel-2));
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
    padding: 10px 11px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .gauge-pop.stale {
    opacity: 0.5;
  }
  .gauge-pop-title {
    margin-bottom: 6px;
  }
  .gauge-pop-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-variant-numeric: tabular-nums;
  }
  .gauge-pop-row .g-bar-wide {
    flex: 1;
    width: auto;
    height: 6px;
  }
  .gauge-pop-row .g-pct {
    min-width: 34px;
  }
  .gauge-pop-reset {
    margin: 0 0 6px 30px;
    text-transform: none;
    letter-spacing: 0.04em;
    color: var(--color-faint);
  }
  .gauge-pop-reset:last-child {
    margin-bottom: 0;
  }
  .update-badge {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 11px;
    background: color-mix(in srgb, var(--color-amber) 14%, transparent);
    border: 1px solid var(--color-amber);
    color: var(--color-amber);
    cursor: pointer;
    font: inherit;
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    border-radius: 2px;
    animation: update-pulse 2.4s ease-in-out infinite;
  }
  .update-badge .up-dot {
    font-size: 8px;
  }
  .update-badge .up-n {
    font-variant-numeric: tabular-nums;
    font-weight: 700;
  }
  .update-badge.mobile {
    padding: 4px 8px;
    gap: 4px;
    letter-spacing: 0.08em;
  }
  /* herdr badge: informational (operator updates manually), so it reads as a
     calmer green and doesn't pulse like the actionable self-update badge */
  .update-badge.herdr {
    background: color-mix(in srgb, var(--color-green) 14%, transparent);
    border-color: var(--color-green);
    color: var(--color-green);
    animation: none;
  }
  @keyframes update-pulse {
    0%,
    100% {
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-amber) 40%, transparent);
    }
    50% {
      box-shadow: 0 0 0 4px transparent;
    }
  }
  .clock {
    color: var(--color-ink-bright);
    letter-spacing: 0.16em;
    display: flex;
    gap: 9px;
    align-items: center;
    font-variant-numeric: tabular-nums;
  }
  .clock .dot {
    color: var(--color-faint);
  }
  .clock .dot.on {
    color: var(--color-green);
  }
  .hud.mobile {
    /* wrap instead of overflowing: on fold-cover (~280px) and phones the
       logo+tallies sit on line 1, the right-side controls drop to line 2
       rather than forcing horizontal page scroll or clipping the gear */
    flex-wrap: wrap;
    gap: 7px;
    row-gap: 8px;
    padding: 10px 12px;
  }
  .hud.mobile .logo {
    font-size: 13px;
    letter-spacing: 0.12em;
  }
  .tallies.compact {
    display: flex;
    align-items: center;
    gap: 4px;
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }
  .tallies.compact .cdot {
    font-size: 9px;
  }
  .tallies.compact .csep {
    color: var(--color-faint);
  }
  /* Mobile: drop the numeric time and let the bare connection dot ride inline at
     the head of the right-side cluster (order:-1) — vertically centred with the
     gauge/gear instead of floating off-centre in the corner. */
  .hud.mobile .clock {
    order: -1;
    gap: 0;
  }
  .hud.mobile .clock .time {
    display: none;
  }
  .hud.mobile .rightside {
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 5px;
    row-gap: 8px;
  }
  /* finger-sized tap targets on touch HUDs (≥40px) — the desktop sizes are
     tuned for a cursor and are too small to hit reliably on a phone */
  .hud.mobile .gear {
    min-height: 40px;
    min-width: 40px;
    padding: 5px 11px;
    font-size: 16px;
  }
  .hud.mobile .gauge-btn {
    padding: 0 6px;
    gap: 5px;
  }
  .hud.mobile .gauge-btn .g-bar {
    width: 28px;
  }
  /* Phone: collapse the gauge to a bare colour bar — drop both the numeric
     percentage and the period label. The bar fill + colour carry the level at a
     glance and the tap popover still shows the labelled windows with exact
     numbers — so the control row holds one line down to ~360px phones. */
  .hud.mobile .gauge-btn .g-pct,
  .hud.mobile .gauge-btn .g-label {
    display: none;
  }
  .hud.mobile .needsyou {
    min-height: 40px;
    padding: 8px 12px;
  }
  /* Phone: collapse the badge to an icon+count chip so the NEEDS YOU call-out
     fits on line 1 next to the gauge/gear instead of forcing the right-side
     controls to wrap to a second row. Full label stays as the aria-label. */
  .needsyou.compact {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    min-width: 40px;
    padding: 8px 10px;
    letter-spacing: 0;
    font-variant-numeric: tabular-nums;
  }
  .needsyou.compact .ny-icon {
    font-weight: 700;
    line-height: 1;
  }
  .needsyou.compact .ny-n {
    font-weight: 600;
  }
  .hud.mobile .update-badge {
    min-height: 40px;
  }

  /* Desktop-only hover tooltips — never shown on touch / mobile devices. */
  @media (hover: hover) and (pointer: fine) {
    .tip {
      position: relative;
    }
    .tip::after {
      content: attr(data-tip);
      position: absolute;
      top: calc(100% + 9px);
      right: 0;
      white-space: nowrap;
      background: linear-gradient(180deg, var(--color-panel), var(--color-panel-2));
      border: 1px solid var(--color-line-bright);
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
      color: var(--color-ink-bright);
      font-size: 10.5px;
      letter-spacing: 0.06em;
      text-transform: none;
      padding: 5px 9px;
      border-radius: 2px;
      pointer-events: none;
      opacity: 0;
      transform: translateY(-3px);
      transition:
        opacity 0.12s ease,
        transform 0.12s ease;
      z-index: 50;
    }
    .tip:hover::after,
    .tip:focus-visible::after {
      opacity: 1;
      transform: translateY(0);
    }
  }
</style>
