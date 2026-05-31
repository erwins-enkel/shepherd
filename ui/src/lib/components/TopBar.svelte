<script lang="ts">
  import type { Session, UsageLimits } from "$lib/types";
  import { formatReset } from "$lib/format";
  import { theme, type ThemePref } from "$lib/theme.svelte";

  const THEMES: { pref: ThemePref; glyph: string; label: string }[] = [
    { pref: "dark", glyph: "☾", label: "Dark" },
    { pref: "light", glyph: "☀", label: "Light" },
    { pref: "system", glyph: "◐", label: "System" },
  ];
  const current = $derived(THEMES.find((t) => t.pref === theme.pref) ?? THEMES[0]);

  let {
    sessions,
    nowMs,
    connected = false,
    mobile = false,
    limits = null,
    ontriage,
  }: {
    sessions: Session[];
    nowMs: number;
    connected?: boolean;
    mobile?: boolean;
    limits?: UsageLimits | null;
    ontriage?: () => void;
  } = $props();

  const working = $derived(sessions.filter((s) => s.status === "running").length);
  const idle = $derived(sessions.filter((s) => s.status === "idle").length);
  const blocked = $derived(sessions.filter((s) => s.status === "blocked").length);
  const clock = $derived(new Date(nowMs).toTimeString().slice(0, 8));

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
  {#if !mobile}
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
        <span class="micro">Herd</span><span class="n">{sessions.length}</span>
      </div>
      <div class="tally">
        <span class="micro" style="color:var(--color-amber)">Working</span><span class="n"
          >{working}</span
        >
      </div>
      <div class="tally"><span class="micro">Idle</span><span class="n">{idle}</span></div>
      <div class="tally">
        <span class="micro" style="color:var(--color-red)">Blocked</span><span class="n"
          >{blocked}</span
        >
      </div>
    </div>
  {/if}
  {#if blocked > 0}
    <button class="needsyou" onclick={() => ontriage?.()}>NEEDS YOU · {blocked}</button>
  {/if}
  {#if gauges.length}
    <div class="gauges" class:mobile class:stale={limits?.stale}>
      {#each gauges as g (g.label)}
        <div
          class="gauge"
          title="{g.label === '5H' ? '5-hour' : 'weekly'} limit · {g.w!
            .pct}% used · resets {formatReset(g.w!.resetAt, nowMs)}{limits?.stale
            ? ' · stale'
            : ''}"
        >
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
  {#if mobile}
    <button
      class="theme-cycle"
      type="button"
      onclick={() => theme.cycle()}
      title="Theme: {current.label} — tap to cycle"
      aria-label="Theme: {current.label}">{current.glyph}</button
    >
  {:else}
    <div class="theme-seg" role="group" aria-label="Theme">
      {#each THEMES as t (t.pref)}
        <button
          type="button"
          class="t-opt"
          class:on={theme.pref === t.pref}
          aria-pressed={theme.pref === t.pref}
          title="{t.label} theme"
          aria-label="{t.label} theme"
          onclick={() => theme.setPref(t.pref)}>{t.glyph}</button
        >
      {/each}
    </div>
  {/if}
  <div class="clock">
    <span class="dot" class:on={connected}>●</span><span>{clock}</span>
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
  }
  .theme-seg {
    display: flex;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    overflow: hidden;
  }
  .t-opt {
    background: transparent;
    border: 0;
    border-left: 1px solid var(--color-line-bright);
    color: var(--color-muted);
    font-size: 13px;
    line-height: 1;
    padding: 5px 8px;
    cursor: pointer;
  }
  .t-opt:first-child {
    border-left: 0;
  }
  .t-opt:hover {
    color: var(--color-ink-bright);
  }
  .t-opt.on {
    color: var(--color-amber);
    background: var(--color-inset);
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
  .gauges {
    margin-left: auto;
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
    gap: 10px;
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
  }
  .tallies.compact .cdot {
    font-size: 9px;
  }
  .tallies.compact .csep {
    color: var(--color-faint);
  }
  .hud.mobile .clock {
    font-size: 12px;
  }
</style>
