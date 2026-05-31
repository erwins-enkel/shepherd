<script lang="ts">
  import type { Session, UsageLimits, UpdateStatus } from "$lib/types";
  import { formatReset } from "$lib/format";
  import { theme, type ThemePref } from "$lib/theme.svelte";
  import { m } from "$lib/paraglide/messages";

  // mobile shows a single compact cycle glyph; desktop's switcher lives in the ActionBar
  const GLYPHS = { dark: "☾", light: "☀", system: "◐" } as const;
  const themeLabel = (p: ThemePref) =>
    p === "dark" ? m.theme_dark() : p === "light" ? m.theme_light() : m.theme_system();

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
  } = $props();

  const updateAvailable = $derived(!!update && update.behind > 0);

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

  const gauges = $derived(
    [
      { label: "5H", w: limits?.session5h },
      { label: "WK", w: limits?.week },
    ].filter((g) => g.w),
  );
</script>

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
      <button class="needsyou" onclick={() => ontriage?.()}
        >{m.common_needs_you({ count: needsYou })}</button
      >
    {/if}
    {#if gauges.length}
      <div class="gauges" class:mobile class:stale={limits?.stale}>
        {#each gauges as g (g.label)}
          {@const tip = `${m.topbar_gauge_title({
            period: g.label === "5H" ? m.topbar_gauge_period_5h() : m.topbar_gauge_period_weekly(),
            pct: g.w!.pct,
            reset: formatReset(g.w!.resetAt, nowMs),
          })}${limits?.stale ? m.topbar_gauge_stale_suffix() : ""}`}
          <div class="gauge tip" data-tip={tip} aria-label={tip}>
            <span class="g-label micro">{g.label}</span>
            <span class="g-bar"
              ><span class="g-fill" style="width:{g.w!.pct}%;background:{gaugeColor(g.w!.pct)}"
              ></span></span
            >
            <span class="g-pct" style="color:{gaugeColor(g.w!.pct)}">{g.w!.pct}%</span>
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
    {#if mobile}
      <button
        class="theme-cycle"
        type="button"
        onclick={() => theme.cycle()}
        title={m.topbar_theme_cycle({ label: themeLabel(theme.pref) })}
        aria-label={m.topbar_theme_cycle_aria({ label: themeLabel(theme.pref) })}
        >{GLYPHS[theme.pref]}</button
      >
    {/if}
    <button
      class="gear tip"
      type="button"
      onclick={() => onsettings?.()}
      data-tip={m.settings_title()}
      aria-label={m.topbar_settings_aria()}>⚙</button
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
  .gauges.mobile {
    gap: 8px;
  }
  .gauges.mobile .g-bar {
    width: 28px;
  }
  .gauges.mobile .g-pct {
    min-width: 26px;
    font-size: 10.5px;
  }
  .theme-cycle {
    background: transparent;
    border: 1px solid var(--color-line-bright);
    color: var(--color-muted);
    font-size: 13px;
    line-height: 1;
    padding: 5px 8px;
    border-radius: 2px;
    cursor: pointer;
  }
  .theme-cycle:hover {
    color: var(--color-amber);
    border-color: var(--color-amber);
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
    gap: 10px;
    row-gap: 8px;
    padding: 10px 12px;
  }
  .hud.mobile .logo {
    font-size: 13px;
    letter-spacing: 0.22em;
  }
  .tallies.compact {
    display: flex;
    align-items: center;
    gap: 5px;
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }
  .tallies.compact .cdot {
    font-size: 9px;
  }
  .tallies.compact .csep {
    color: var(--color-faint);
  }
  /* Mobile keeps the connection dot but hides the time to save space. */
  .hud.mobile .clock .time {
    display: none;
  }
  .hud.mobile .rightside {
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 9px;
    row-gap: 8px;
  }
  /* finger-sized tap targets on touch HUDs (≥40px) — the desktop sizes are
     tuned for a cursor and are too small to hit reliably on a phone */
  .hud.mobile .gear,
  .hud.mobile .theme-cycle {
    min-height: 40px;
    min-width: 40px;
    padding: 5px 11px;
    font-size: 16px;
  }
  .hud.mobile .needsyou {
    min-height: 40px;
    padding: 8px 12px;
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
      background: linear-gradient(180deg, var(--color-panel), #0c100f);
      border: 1px solid var(--color-line-bright);
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
