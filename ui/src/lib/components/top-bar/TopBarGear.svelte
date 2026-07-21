<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import { DOCS_URL } from "$lib/build-info";
  import type { FeedbackKind } from "$lib/feedback-link";
  import type { UsageLimits } from "$lib/types";
  import { isMacPlatform } from "$lib/platform";
  import { coachTarget } from "$lib/actions/coachTarget.svelte";
  import { settingsChordHint } from "../herd-keynav";
  import type { GaugeKey } from "../usage-gauges";
  import GearMenuUsage from "./GearMenuUsage.svelte";
  import GearIdent from "./GearIdent.svelte";
  import GearHaltHero from "./GearHaltHero.svelte";
  import GearGroupHead from "./GearGroupHead.svelte";
  import GearRow from "./GearRow.svelte";

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
  // top, so no flip-up branch). Direct resize handling — a transient 300px popover
  // needs no rAF coalescing.
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
    clamp();
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  });
</script>

<div class="gear-wrap" bind:this={gearWrap}>
  <!-- No tooltip on the gear: the always-menu redesign made "Open menu" on a gear
       glyph informationless (the old tip disambiguated the ADAPTIVE settings-vs-menu
       click), and an anchored tip would overlap the popover's identity header. -->
  <button
    bind:this={gearBtn}
    class="gear"
    class:mobile
    class:open={menuOpen}
    type="button"
    use:coachTarget={"gear-menu"}
    onclick={clickGear}
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
      <GearIdent {connected} />

      <GearHaltHero {haltable} {armed} onclick={clickHalt} />

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
          <GearRow
            glyph="✦"
            label={learningsLabel}
            meta={String(learningsCount)}
            ariaLabel={learnings > 0
              ? m.learnings_open_aria({ count: learnings })
              : m.learnings_open_curate_aria({ count: learningsCurate })}
            onclick={chooseLearnings}
          />
        {/if}
        <GearRow
          glyph="⚙"
          label={m.settings_title()}
          meta={chordHint}
          metaFaint
          onclick={chooseSettings}
        />
        <GearRow
          glyph="↗"
          label={m.topbar_docs()}
          href={DOCS_URL}
          onclick={() => (menuOpen = false)}
        />
      </div>

      <!-- Plugins group: dynamic — one row per installed plugin with a gear item. -->
      {#if pluginItems.length > 0}
        <div class="grp plugins">
          <GearGroupHead
            label={`${m.gearmenu_plugins_label()} · ${pluginItems.length}`}
            action={m.gearmenu_plugins_manage()}
            onAction={onManagePlugins}
          />
          {#each pluginItems as item (item.id)}
            <GearRow
              glyph={item.icon ?? "⌁"}
              label={item.label}
              meta={item.hint && item.hint !== item.label ? item.hint : ""}
              metaFaint
              onclick={() => onPluginItem?.(item.id)}
            />
          {/each}
        </div>
      {/if}

      <!-- Support group, demoted onto the darker head ground. -->
      <div class="grp support">
        <GearGroupHead label={m.gearmenu_support_label()} />
        <GearRow
          support
          glyph="⚠"
          label={m.feedback_dialog_title_bug()}
          onclick={() => onFeedback("bug")}
        />
        <GearRow
          support
          glyph="✧"
          label={m.feedback_dialog_title_feature()}
          onclick={() => onFeedback("feature")}
        />
        <GearRow
          support
          glyph="↵"
          label={m.feedback_dialog_title_feedback()}
          onclick={() => onFeedback("feedback")}
        />
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
  }
</style>
