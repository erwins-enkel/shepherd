<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import { DOCS_URL, version } from "$lib/build-info";
  import type { FeedbackKind } from "$lib/feedback-link";
  import type { UsageLimits } from "$lib/types";
  import { isMacPlatform } from "$lib/platform";
  import { coachTarget } from "$lib/actions/coachTarget.svelte";
  import { settingsChordHint } from "../herd-keynav";
  import type { GaugeKey } from "../usage-gauges";
  import GearMenuUsage from "./GearMenuUsage.svelte";

  type GearPipTier = "red" | "yellow" | null;

  let {
    mobile,
    haltable,
    gearPipTier,
    armed,
    connected,
    menuOpen = $bindable(),
    gearWrap = $bindable(null),
    gearBtn = $bindable(null),
    menuEl = $bindable(null),
    clickGear,
    clickHalt,
    chooseSettings,
    chooseUsage,
    learningsPresent,
    learnings,
    learningsCurate,
    learningsLabel,
    learningsCount,
    chooseLearnings,
    onMenuKey,
    onFeedback,
    pluginItems = [],
    onPluginItem,
    onManagePlugins,
    limits,
    nowMs,
    creditFill,
    creditColor,
    creditAmount,
    refreshing,
    refreshError,
    onRefresh,
    periodLabel,
  }: {
    mobile: boolean;
    haltable: number;
    gearPipTier: GearPipTier;
    armed: boolean;
    connected: boolean;
    menuOpen: boolean;
    gearWrap: HTMLElement | null;
    gearBtn: HTMLButtonElement | null;
    menuEl: HTMLElement | null;
    clickGear: () => void;
    clickHalt: () => void;
    chooseSettings: () => void;
    chooseUsage: () => void;
    learningsPresent: boolean;
    learnings: number;
    learningsCurate: number;
    learningsLabel: string;
    learningsCount: number;
    chooseLearnings: () => void;
    onMenuKey: (e: KeyboardEvent) => void;
    onFeedback: (kind: FeedbackKind) => void;
    pluginItems?: { id: string; label: string; icon?: string; hint?: string }[];
    onPluginItem?: (id: string) => void;
    onManagePlugins?: () => void;
    limits: UsageLimits | null;
    nowMs: number;
    creditFill: number;
    creditColor: string;
    creditAmount: string;
    refreshing: boolean;
    refreshError: boolean;
    onRefresh: () => void;
    periodLabel: (k: GaugeKey) => string;
  } = $props();

  const chordHint = settingsChordHint(isMacPlatform());

  // Clamp the popover to the space below its anchor (the gear sits near the viewport
  // top, so no flip-up branch) — same recipe as the held-tasks popover in TopBar.
  const EDGE_GAP = 12;
  $effect(() => {
    const el = menuEl;
    if (!el || mobile) return;
    const clamp = () => {
      const anchor = gearWrap;
      if (!anchor) return;
      const below = window.innerHeight - anchor.getBoundingClientRect().bottom - 6 - EDGE_GAP;
      el.style.maxHeight = `${Math.max(120, below)}px`;
    };
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        clamp();
      });
    };
    clamp();
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", schedule);
    };
  });
</script>

<div class="gear-wrap" bind:this={gearWrap}>
  <button
    bind:this={gearBtn}
    class="gear tip"
    class:mobile
    class:open={menuOpen}
    type="button"
    use:coachTarget={"gear-menu"}
    onclick={clickGear}
    data-tip={m.topbar_menu_aria()}
    aria-haspopup="dialog"
    aria-expanded={menuOpen}
    aria-label={m.topbar_menu_aria()}
    >⚙{#if mobile && gearPipTier}<span class="gear-pip" data-tier={gearPipTier} aria-hidden="true"
      ></span>{/if}</button
  >
  {#if menuOpen && !mobile}
    <!-- Telemetry popover (design handoff 3b): anchored NON-MODAL dialog — plain
         buttons/links (no role=menuitem), square chrome, grouped rows. Arrow-key
         roving + Esc live in TopBar's onMenuKey over [data-gear-row]. -->
    <div
      class="gear-menu"
      role="dialog"
      tabindex="-1"
      aria-label={m.topbar_menu_label()}
      bind:this={menuEl}
      onkeydown={onMenuKey}
    >
      <!-- Identity header: brand mark + version + connection readout. Neutral ink ramp
           for connectivity (brightness carries the cue, per canon — not green). -->
      <div class="ident">
        <span class="ident-brand">SHEPHERD</span>
        <span class="ident-conn">
          v{version} · <span class="ident-dot" class:on={connected} aria-hidden="true">●</span>
          {connected ? m.gearmenu_conn_live() : m.gearmenu_conn_offline()}
        </span>
      </div>

      <!-- Hero action: halt herd. Two-step arm→confirm; natively disabled (and
           chip-less) when nothing is running. -->
      <button
        class="hero"
        class:armed
        type="button"
        data-gear-row
        disabled={haltable === 0}
        onclick={clickHalt}
        aria-label={haltable === 0
          ? m.gearmenu_halt_herd()
          : armed
            ? m.halt_arm_aria({ count: haltable })
            : m.halt_all_aria({ count: haltable })}
      >
        <span class="hero-glyph" aria-hidden="true">■</span>
        <span class="hero-label"
          >{armed ? m.halt_arm({ count: haltable }) : m.gearmenu_halt_herd()}</span
        >
        {#if haltable > 0}
          <span class="chip">{m.gearmenu_working_chip({ count: haltable })}</span>
        {/if}
      </button>

      <!-- Live token-usage gauge block; "all ▾" discloses the per-window breakdown. -->
      <GearMenuUsage
        {limits}
        {nowMs}
        {creditFill}
        {creditColor}
        {creditAmount}
        {refreshing}
        {refreshError}
        {onRefresh}
        {periodLabel}
        onOpenUsage={chooseUsage}
        coachId="usage-link"
      />

      <!-- Workspace rows -->
      <div class="grp">
        {#if learningsPresent}
          <button
            class="row"
            type="button"
            data-gear-row
            aria-label={learnings > 0
              ? m.learnings_open_aria({ count: learnings })
              : m.learnings_open_curate_aria({ count: learningsCurate })}
            onclick={chooseLearnings}
          >
            <span class="glyph" aria-hidden="true">✦</span>
            <span class="row-label">{learningsLabel}</span>
            <span class="row-meta">{learningsCount}</span>
          </button>
        {/if}
        <button class="row" type="button" data-gear-row onclick={chooseSettings}>
          <span class="glyph" aria-hidden="true">⚙</span>
          <span class="row-label">{m.settings_title()}</span>
          <span class="row-meta faint">{chordHint}</span>
        </button>
        <a
          class="row"
          data-gear-row
          href={DOCS_URL}
          target="_blank"
          rel="external noreferrer noopener"
          onclick={() => (menuOpen = false)}
        >
          <span class="glyph" aria-hidden="true">↗</span>
          <span class="row-label">{m.topbar_docs()}</span>
        </a>
      </div>

      <!-- Plugins group: dynamic — one row per installed plugin with a gear item. -->
      {#if pluginItems.length > 0}
        <div class="grp plugins">
          <div class="grp-head">
            <span class="grp-label">{m.gearmenu_plugins_label()} · {pluginItems.length}</span>
            <button
              class="grp-action"
              type="button"
              data-gear-row
              aria-haspopup="dialog"
              onclick={() => onManagePlugins?.()}
            >
              {m.gearmenu_plugins_manage()} ▾
            </button>
          </div>
          {#each pluginItems as item (item.id)}
            <button class="row" type="button" data-gear-row onclick={() => onPluginItem?.(item.id)}>
              <span class="glyph" aria-hidden="true">{item.icon ?? "⌁"}</span>
              <span class="row-label">{item.label}</span>
              {#if item.hint && item.hint !== item.label}
                <span class="row-meta faint">{item.hint}</span>
              {/if}
            </button>
          {/each}
        </div>
      {/if}

      <!-- Support group, demoted onto the darker head ground. -->
      <div class="grp support">
        <div class="grp-head">
          <span class="grp-label">{m.gearmenu_support_label()}</span>
        </div>
        <button class="row" type="button" data-gear-row onclick={() => onFeedback("bug")}>
          <span class="glyph" aria-hidden="true">⚠</span>
          <span class="row-label">{m.feedback_dialog_title_bug()}</span>
        </button>
        <button class="row" type="button" data-gear-row onclick={() => onFeedback("feature")}>
          <span class="glyph" aria-hidden="true">✧</span>
          <span class="row-label">{m.feedback_dialog_title_feature()}</span>
        </button>
        <button class="row" type="button" data-gear-row onclick={() => onFeedback("feedback")}>
          <span class="glyph" aria-hidden="true">↵</span>
          <span class="row-label">{m.feedback_dialog_title_feedback()}</span>
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  .gear-wrap {
    position: relative;
    display: inline-flex;
  }
  /* Telemetry popover: square (radius 0 — popovers earn a shadow, never a radius),
     300px, panel ground, bright hairline, canonical popover shadow. */
  .gear-menu {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 30;
    width: 300px;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    border-radius: 0;
    box-shadow: var(--shadow-popover);
    overflow-y: auto;
  }
  .ident {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: var(--color-head);
    border-bottom: 1px solid var(--color-line);
    flex-shrink: 0;
  }
  .ident-brand {
    font-size: var(--fs-micro);
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .ident-conn {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: var(--fs-micro);
    color: var(--color-muted);
    font-variant-numeric: tabular-nums;
  }
  /* Connectivity stays in the neutral ink ramp: brightness, not a status hue. */
  .ident-dot {
    color: var(--color-faint);
  }
  .ident-dot.on {
    color: var(--color-ink-bright);
  }
  .hero {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 9px 12px;
    background: transparent;
    border: 0;
    border-bottom: 1px solid var(--color-line);
    font: inherit;
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
    text-align: left;
    cursor: pointer;
  }
  .hero-glyph {
    width: 16px;
    text-align: center;
    color: var(--color-amber);
    flex-shrink: 0;
  }
  .hero:disabled {
    color: var(--color-muted);
    cursor: default;
    opacity: 0.4;
  }
  .hero:disabled .hero-glyph {
    color: var(--color-muted);
  }
  .hero:hover:not(:disabled) {
    background: var(--color-hover);
  }
  .chip {
    margin-left: auto;
    border: 1px solid color-mix(in srgb, var(--color-amber) 62%, var(--color-line));
    color: var(--color-amber);
    font-size: var(--fs-micro);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    padding: 1px 6px;
    border-radius: 2px;
    font-variant-numeric: tabular-nums;
  }
  /* Armed e-stop: loud red confirm state, same convention as the old menu row. */
  .hero.armed {
    background: color-mix(in srgb, var(--color-red) 22%, transparent);
    color: var(--color-red);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-size: var(--fs-meta);
  }
  .hero.armed .hero-glyph,
  .hero.armed .chip {
    color: var(--color-red);
    border-color: var(--color-red);
  }
  .grp {
    padding: 4px 0;
    flex-shrink: 0;
  }
  .grp.plugins {
    border-top: 1px solid var(--color-line);
  }
  .grp.support {
    border-top: 1px solid var(--color-line);
    background: var(--color-head);
    padding: 4px 0 6px;
  }
  .grp-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 6px 12px 2px;
  }
  .grp-label {
    font-size: var(--fs-micro);
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--color-faint);
    font-variant-numeric: tabular-nums;
  }
  .grp-action {
    margin-left: auto;
    background: transparent;
    border: 0;
    padding: 0 2px;
    font: inherit;
    font-size: var(--fs-micro);
    color: var(--color-faint);
    cursor: pointer;
  }
  .grp-action:hover {
    color: var(--color-ink);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 7px 12px;
    background: transparent;
    border: 0;
    font: inherit;
    font-size: var(--fs-base);
    color: var(--color-ink);
    text-align: left;
    cursor: pointer;
    white-space: nowrap;
    text-decoration: none;
    box-sizing: border-box;
  }
  .grp.support .row {
    padding: 6px 12px;
  }
  .glyph {
    width: 16px;
    text-align: center;
    color: var(--color-muted);
    flex-shrink: 0;
  }
  .row-meta {
    margin-left: auto;
    font-size: var(--fs-micro);
    color: var(--color-muted);
    font-variant-numeric: tabular-nums;
  }
  .row-meta.faint {
    color: var(--color-faint);
  }
  /* Flat tonal states only: hover lift, focus = same lift + brightened hairline ring
     ("no glow rings" per the handoff — but never no-indicator). */
  .row:hover {
    background: var(--color-hover);
  }
  .row:focus-visible,
  .hero:focus-visible,
  .grp-action:focus-visible {
    outline: none;
    background: var(--color-hover);
    box-shadow: inset 0 0 0 1px var(--color-line-bright);
  }
  .gear {
    box-sizing: border-box;
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    /* shared bar control height — its 20px glyph defined the token, so it's unchanged;
       border-box keeps this button level with the 1px-bordered badges */
    min-height: var(--topbar-ctl-h);
    background: transparent;
    border: 1px solid transparent;
    color: var(--color-muted);
    font-size: var(--fs-xl);
    line-height: 1;
    padding: 0 8px;
    cursor: pointer;
  }
  .gear:hover {
    color: var(--color-amber);
  }
  /* Active (menu open): selected ground + bright hairline, per the handoff. */
  .gear.open {
    background: var(--color-sel);
    border-color: var(--color-line-bright);
    color: var(--color-ink-bright);
  }
  /* Mobile only: single settings-attention dot for diagnostics surfaced inside
     the gear sheet. Session state has its own stronger affordances elsewhere. */
  .gear-pip {
    position: absolute;
    top: 2px;
    right: 2px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    box-shadow: 0 0 0 2px var(--color-panel);
  }
  .gear-pip[data-tier="red"] {
    background: var(--color-red);
  }
  .gear-pip[data-tier="yellow"] {
    background: var(--color-amber);
  }
  /* Mobile: finger-sized tap targets (≥44px). */
  .gear.mobile {
    min-height: 44px;
    min-width: 44px;
    padding: 0 11px;
    font-size: var(--fs-xl);
  }

  /* Coarse pointers (touch, any layout width): secondary icon buttons need ≥44px hit area. */
  @media (pointer: coarse) {
    .gear {
      min-height: 44px;
      min-width: 44px;
    }
    .row,
    .hero {
      min-height: 44px;
    }
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
      background: var(--color-panel);
      border: 1px solid var(--color-line-bright);
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
      color: var(--color-ink-bright);
      font-size: var(--fs-meta);
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
    /* Menu open: the popover's identity header sits where the tooltip lands —
       the open state already answers what the button does. */
    .gear.open::after {
      display: none;
    }
  }
</style>
