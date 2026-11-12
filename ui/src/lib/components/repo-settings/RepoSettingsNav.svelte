<script lang="ts" module>
  import type { RepoSettingsSection } from "./sections";

  export interface NavItem {
    id: RepoSettingsSection;
    label: string;
    /** The section's short status line. */
    summary: string;
    /** A hint at the window's top concerns this section. */
    flagged: boolean;
  }
</script>

<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";

  // The repo settings window's sections (#3443): a rail with each section's short status on
  // wide container, one sideways-scrolling row of chips in a narrow one. A tablist: arrow keys / Home / End move between sections.
  let {
    items,
    active = $bindable(),
    panelId,
  }: {
    items: NavItem[];
    active: RepoSettingsSection;
    /** The tabpanel's id, and the prefix of each tab's. */
    panelId: string;
  } = $props();

  let tabs = $state<HTMLButtonElement[]>([]);
  let nav = $state<HTMLDivElement>();

  // Narrow, the chips are one row that scrolls sideways: keep the active one fully in view. Set
  // scrollLeft directly — scrollIntoView would also scroll the settings vertically.
  $effect(() => {
    const i = items.findIndex((item) => item.id === active);
    const tab = tabs[i];
    if (!nav || !tab || nav.scrollWidth <= nav.clientWidth) return;
    const pad = 12;
    const left = tab.offsetLeft; // .nav is the offsetParent: content coordinates
    const right = left + tab.offsetWidth;
    if (left - pad < nav.scrollLeft) nav.scrollLeft = left - pad;
    else if (right + pad > nav.scrollLeft + nav.clientWidth)
      nav.scrollLeft = right + pad - nav.clientWidth;
  });

  function onKey(e: KeyboardEvent, i: number) {
    const last = items.length - 1;
    let next: number;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") next = i === last ? 0 : i + 1;
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") next = i === 0 ? last : i - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    else return;
    e.preventDefault();
    active = items[next]!.id;
    tabs[next]?.focus();
  }
</script>

<!-- data-swipe-ignore: narrow, the strip scrolls sideways — a drag on it must scroll the chips,
     not page the session (Viewport's phone page-swipe) -->
<div
  bind:this={nav}
  class="nav"
  role="tablist"
  aria-label={m.reposettings_nav_label()}
  data-swipe-ignore
>
  {#each items as item, i (item.id)}
    <button
      bind:this={tabs[i]}
      class={["tab", { on: active === item.id, flagged: item.flagged }]}
      type="button"
      role="tab"
      id="{panelId}-tab-{item.id}"
      aria-selected={active === item.id}
      aria-controls={panelId}
      tabindex={active === item.id ? 0 : -1}
      onclick={() => (active = item.id)}
      onkeydown={(e) => onKey(e, i)}
    >
      <span class="label">
        {item.label}
        {#if item.flagged}
          <span class="mark" aria-hidden="true">⚠</span>
          <span class="vh">({m.reposettings_section_flagged()})</span>
        {/if}
      </span>
      {#if item.summary}<span class="summary">{item.summary}</span>{/if}
    </button>
  {/each}
</div>

<style>
  .nav {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 8px 6px;
  }
  .tab {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 1px;
    width: 100%;
    padding: 6px 8px;
    border: 0;
    border-left: 2px solid transparent;
    border-radius: 0;
    background: transparent;
    color: var(--color-muted);
    font: inherit;
    font-size: var(--fs-base);
    text-align: left;
    cursor: pointer;
  }
  .tab:hover {
    color: var(--color-ink-bright);
    background: var(--color-hover);
  }
  .tab:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .tab.on {
    color: var(--color-ink-bright);
    border-left-color: var(--color-amber);
    background: var(--color-hover);
  }
  .label {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .mark {
    color: var(--status-warn);
    font-size: var(--fs-meta);
  }
  .summary {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-micro);
    color: var(--color-faint);
  }
  .vh {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  /* Narrow container (a phone, or a narrow pane): one row of chips that scrolls sideways and
     sticks above the section — the next chip peeking at the edge says there is more. */
  @container repo-settings (max-width: 640px) {
    .nav {
      flex-direction: row;
      flex-wrap: nowrap;
      gap: 6px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--color-line);
      overflow-x: auto;
      overscroll-behavior-x: contain;
      scrollbar-width: none;
    }
    .nav::-webkit-scrollbar {
      display: none;
    }
    .tab {
      flex: 0 0 auto;
      width: auto;
      white-space: nowrap;
      min-height: 44px;
      justify-content: center;
      padding: 4px 12px;
      border: 1px solid var(--color-line);
      border-radius: 2px;
    }
    .tab.on {
      border-color: var(--color-amber);
      color: var(--color-amber);
    }
    .tab.flagged:not(.on) {
      border-color: var(--status-warn);
    }
    /* the chip names the section; its status stays for assistive tech */
    .summary {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
    }
  }
</style>
