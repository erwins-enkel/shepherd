<script lang="ts" module>
  import { m } from "#lib/paraglide/messages.js";

  // The plan panel's view modes, in switch order. Only Read ships with #3515; the suggestion-mode
  // issue (#3520) appends Comment and Edit here — the switch renders whatever this list holds.
  const MODES = [
    {
      id: "read",
      label: () => m.planpanel_mode_read(),
      icon: "M8 4.5C6.6 3.6 4.6 3 2 3v9.5c2.6 0 4.6.6 6 1.5 1.4-.9 3.4-1.5 6-1.5V3c-2.6 0-4.6.6-6 1.5Zm0 0V14",
    },
  ] as const;

  export type PlanViewMode = (typeof MODES)[number]["id"];
</script>

<script lang="ts">
  let { mode, onselect }: { mode: PlanViewMode; onselect: (mode: PlanViewMode) => void } = $props();
</script>

<div class="modes" role="group" aria-label={m.planpanel_mode_label()} style:--modes={MODES.length}>
  {#each MODES as item (item.id)}
    <button
      type="button"
      class="mode"
      aria-pressed={mode === item.id}
      onclick={() => onselect(item.id)}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d={item.icon} /></svg
      >
      {item.label()}
    </button>
  {/each}
</div>

<style>
  .modes {
    display: inline-grid;
    grid-template-columns: repeat(var(--modes), auto);
    flex: none;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    overflow: hidden;
  }
  .mode {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    min-height: 44px;
    padding: 0 14px;
    background: transparent;
    border: 0;
    color: var(--color-muted);
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.06em;
    cursor: pointer;
  }
  .mode + .mode {
    border-left: 1px solid var(--color-line-bright);
  }
  .mode:hover,
  .mode:focus-visible {
    color: var(--color-ink-bright);
  }
  .mode[aria-pressed="true"] {
    background: var(--color-sel);
    color: var(--color-ink-bright);
  }
  svg {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linejoin: round;
  }
  /* Phone: the switch takes its own full row under the header, one equal column per mode. */
  @media (max-width: 768px) {
    .modes {
      display: grid;
      grid-template-columns: repeat(var(--modes), minmax(0, 1fr));
      width: 100%;
    }
  }
</style>
