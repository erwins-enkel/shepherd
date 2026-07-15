<script lang="ts">
  import { labelChipStyle } from "$lib/label-color";
  import { m } from "$lib/paraglide/messages";
  import { ACTIVE_LABEL } from "./issues-panel";

  let {
    labels,
    labelColors = undefined,
  }: { labels: string[]; labelColors?: Record<string, string> } = $props();

  // Claimed work is the one semantic label Shepherd owns. Keep it first so it
  // survives the responsive cap; forge labels retain their source order.
  const ordered = $derived(
    labels.includes(ACTIVE_LABEL)
      ? [ACTIVE_LABEL, ...labels.filter((label) => label !== ACTIVE_LABEL)]
      : labels,
  );

  const chipStyle = (label: string): string | null =>
    label === ACTIVE_LABEL ? null : labelChipStyle(labelColors?.[label] ?? "");
</script>

{#if ordered.length > 0}
  <span class="issue-labels">
    {#each ordered.slice(0, 2) as label, index (label)}
      {@const style = chipStyle(label)}
      <span
        class="issue-label-chip"
        class:issue-label-second={index === 1}
        class:active={label === ACTIVE_LABEL}
        class:hued={style !== null}
        {style}
        title={label === ACTIVE_LABEL ? m.issuespanel_active_label_title() : undefined}
        >{label}</span
      >
    {/each}
    {#if ordered.length > 2}
      <span class="issue-label-chip issue-label-more more-wide" title={ordered.slice(2).join(", ")}
        >{m.issuechips_more({ count: ordered.length - 2 })}</span
      >
    {/if}
    {#if ordered.length > 1}
      <span
        class="issue-label-chip issue-label-more more-narrow"
        title={ordered.slice(1).join(", ")}>{m.issuechips_more({ count: ordered.length - 1 })}</span
      >
    {/if}
  </span>
{/if}

<style>
  .issue-labels {
    display: flex;
    align-items: baseline;
    gap: 3px;
    min-width: 0;
    flex: 0 1 auto;
  }

  .issue-label-chip {
    max-width: 14ch;
    overflow: hidden;
    padding: 0 4px;
    border: 1px solid var(--color-faint);
    border-radius: 2px;
    color: var(--color-slate);
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-overflow: ellipsis;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .issue-label-chip.active {
    border-color: var(--status-running);
    background: color-mix(in srgb, var(--status-running) 14%, transparent);
    color: var(--status-running);
  }

  /* Forge label colors are data, not Shepherd chrome. labelChipStyle()
     normalizes their lightness and supplies the per-theme variables. */
  .issue-label-chip.hued {
    border-color: var(--lc-border-d);
    background: var(--lc-fill-d);
    color: var(--lc-text-d);
  }

  :global([data-theme="light"]) .issue-label-chip.hued {
    border-color: var(--lc-border-l);
    background: var(--lc-fill-l);
    color: var(--lc-text-l);
  }

  .issue-label-more {
    max-width: none;
    flex: none;
    border-color: transparent;
    color: var(--color-muted);
  }

  .more-narrow {
    display: none;
  }

  @container issue-list-row (max-width: 520px) {
    .issue-label-second,
    .more-wide {
      display: none;
    }

    .more-narrow {
      display: inline-block;
    }
  }
</style>
