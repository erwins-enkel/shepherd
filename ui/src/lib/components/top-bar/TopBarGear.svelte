<script lang="ts">
  import { m } from "$lib/paraglide/messages";

  type GearPipTier = "red" | "orange" | "yellow" | "blue" | null;

  let {
    mobile,
    haltable,
    blocked,
    gearPipTier,
    gearOpensMenu,
    armed,
    menuOpen = $bindable(),
    gearWrap = $bindable(null),
    gearBtn = $bindable(null),
    menuEl = $bindable(null),
    clickGear,
    clickHalt,
    chooseSettings,
    onMenuKey,
  }: {
    mobile: boolean;
    haltable: number;
    blocked: number;
    gearPipTier: GearPipTier;
    gearOpensMenu: boolean;
    armed: boolean;
    menuOpen: boolean;
    gearWrap: HTMLElement | null;
    gearBtn: HTMLButtonElement | null;
    menuEl: HTMLElement | null;
    clickGear: () => void;
    clickHalt: () => void;
    chooseSettings: () => void;
    onMenuKey: (e: KeyboardEvent) => void;
  } = $props();
</script>

<div class="gear-wrap" bind:this={gearWrap}>
  <button
    bind:this={gearBtn}
    class="gear tip"
    class:mobile
    type="button"
    onclick={clickGear}
    data-tip={gearOpensMenu ? m.topbar_menu_aria() : m.settings_title()}
    aria-haspopup={gearOpensMenu ? (mobile ? "dialog" : "menu") : undefined}
    aria-expanded={gearOpensMenu ? menuOpen : undefined}
    aria-label={gearOpensMenu ? m.topbar_menu_aria() : m.topbar_settings_aria()}
    >⚙{#if !mobile && haltable > 0}<span
        class="halt-pip"
        class:alert={blocked > 0}
        aria-hidden="true"
      ></span>{/if}{#if mobile && gearPipTier}<span
        class="gear-pip"
        data-tier={gearPipTier}
        aria-hidden="true"
      ></span>{/if}</button
  >
  {#if menuOpen && !mobile}
    <!-- Desktop dropdown: role=menu/menuitem + arrow-key cycling. Zero change vs before. -->
    <div
      class="gear-menu"
      role="menu"
      tabindex="-1"
      aria-label={m.topbar_menu_label()}
      bind:this={menuEl}
      onkeydown={onMenuKey}
    >
      {#if haltable > 0}
        <!-- e-stop row: first activation arms (red "Halt N?"), a second commits.
             Full intent stays in the aria-label. -->
        <button
          class="menu-item halt-item"
          class:armed
          type="button"
          role="menuitem"
          onclick={clickHalt}
          aria-label={armed
            ? m.halt_arm_aria({ count: haltable })
            : m.halt_all_aria({ count: haltable })}
        >
          <svg class="menu-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 2 H16 L22 8 V16 L16 22 H8 L2 16 V8 Z" fill="currentColor" />
          </svg>
          <span class="menu-label"
            >{armed ? m.halt_arm({ count: haltable }) : m.halt_menu_item({ count: haltable })}</span
          >
        </button>
        <div class="menu-sep" role="separator"></div>
      {/if}
      <button class="menu-item" type="button" role="menuitem" onclick={chooseSettings}>
        <span class="menu-glyph" aria-hidden="true">⚙</span>
        <span class="menu-label">{m.settings_title()}</span>
      </button>
    </div>
  {/if}
</div>

<style>
  /* Gear menu: a small popup hung below-right of the gear, holding the e-stop (when
     working) above the Settings entry. Quiet panel chrome matching the gauge popover. */
  .gear-wrap {
    position: relative;
    display: inline-flex;
  }
  .gear-menu {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 30;
    min-width: 184px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 5px;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    border-radius: 3px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
  }
  .menu-item {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 2px;
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-base);
    text-align: left;
    padding: 8px 10px;
    cursor: pointer;
    white-space: nowrap;
  }
  .menu-item:hover,
  .menu-item:focus-visible {
    background: color-mix(in srgb, var(--color-line-bright) 40%, transparent);
    outline: none;
  }
  .menu-icon {
    width: var(--fs-lg);
    height: var(--fs-lg);
    display: block;
    flex-shrink: 0;
  }
  .menu-glyph {
    width: var(--fs-lg);
    text-align: center;
    flex-shrink: 0;
  }
  .menu-label {
    font-variant-numeric: tabular-nums;
  }
  /* e-stop row: muted by default, goes loud (red) only on hover/focus and once armed —
     so a rarely-pressed control never dominates the menu. */
  .halt-item {
    color: var(--color-muted);
  }
  .halt-item:hover,
  .halt-item:focus-visible {
    background: color-mix(in srgb, var(--color-red) 14%, transparent);
    color: var(--color-red);
  }
  .halt-item.armed {
    background: color-mix(in srgb, var(--color-red) 22%, transparent);
    border-color: var(--color-red);
    color: var(--color-red);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-size: var(--fs-meta);
  }
  /* Keep the octagon glyph at full size even when arming drops the row font-size. */
  .halt-item.armed .menu-icon {
    width: var(--fs-lg);
    height: var(--fs-lg);
  }
  .menu-sep {
    height: 1px;
    margin: 3px 2px;
    background: var(--color-line);
  }
  .gear {
    position: relative;
    background: transparent;
    border: none;
    color: var(--color-muted);
    font-size: var(--fs-xl);
    line-height: 1;
    padding: 5px 8px;
    cursor: pointer;
  }
  .gear:hover {
    color: var(--color-amber);
  }
  /* Pip on the gear: the only at-rest cue that there's a herd to halt. Amber while
     agents merely work; red (.alert) only when something is blocked, so red stays
     reserved for "needs you" rather than the normal running state. */
  .halt-pip {
    position: absolute;
    top: 2px;
    right: 2px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--color-amber);
    box-shadow: 0 0 0 2px var(--color-panel);
  }
  .halt-pip.alert {
    background: var(--color-red);
  }
  /* Mobile only: single severity dot on the gear — red > orange > yellow > blue.
     One dot replaces the old three-pip "measles" layout on mobile. */
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
  .gear-pip[data-tier="orange"] {
    background: var(--color-warn);
  }
  .gear-pip[data-tier="yellow"] {
    background: var(--color-amber);
  }
  .gear-pip[data-tier="blue"] {
    background: var(--color-blue);
  }
  /* Mobile: finger-sized tap targets (≥44px) — the desktop sizes are tuned for a
     cursor and are too small to hit reliably on a phone. These rules (.gear.mobile)
     outrank the @media (pointer: coarse) block below on specificity, so the 44px
     floor must live here too. */
  .gear.mobile {
    min-height: 44px;
    min-width: 44px;
    padding: 5px 11px;
    font-size: var(--fs-xl);
  }

  /* Coarse pointers (touch, any layout width): secondary icon buttons need ≥44px hit area. */
  @media (pointer: coarse) {
    .gear {
      min-height: 44px;
      min-width: 44px;
    }
    /* Menu rows get the same ≥44px touch floor without enlarging the desktop layout. */
    .menu-item {
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
  }
</style>
