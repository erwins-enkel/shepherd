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
  // wide container, wrapping chips in a narrow one. A tablist: arrow keys / Home / End move between sections.
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

<div class="nav" role="tablist" aria-label={m.reposettings_nav_label()}>
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
  /* Narrow container (a phone, or a narrow pane; the body is the query container): wrapping
     chips — every section stays reachable without sideways scrolling. */
  @container (max-width: 640px) {
    .nav {
      flex-direction: row;
      flex-wrap: wrap;
      gap: 6px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--color-line);
    }
    .tab {
      width: auto;
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
