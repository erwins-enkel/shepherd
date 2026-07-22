<script lang="ts">
  import type { Snippet } from "svelte";
  import { m } from "$lib/paraglide/messages";

  // Collapsed per-CLI group as a ROW, not a box (5a spec): ▸ caret, uppercase
  // name, right-aligned "N settings" count; expands in place. Controlled by the
  // parent (expanded + ontoggle) so search can auto-expand matching groups
  // without clobbering the user's own expand state. Content stays mounted and
  // toggles via `hidden` — same contract as the accordion it replaces (stable
  // aria-controls id, no remount on toggle).
  let {
    label,
    count,
    expanded,
    ontoggle,
    children,
  }: {
    label: string;
    count: number;
    expanded: boolean;
    ontoggle: () => void;
    children: Snippet;
  } = $props();

  const uid = $props.id();
  const contentId = `${uid}-content`;
</script>

<section class="sgroup">
  <h3>
    <!-- aria-label keeps the accessible name to the group label alone; the
         visible "N settings" count is supplementary. -->
    <button
      type="button"
      aria-label={label}
      aria-expanded={expanded}
      aria-controls={contentId}
      onclick={ontoggle}
    >
      <span class="caret" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
      <span class="name">{label}</span>
      <span class="count">
        {count === 1 ? m.settings_group_count_one() : m.settings_group_count({ count })}
      </span>
    </button>
  </h3>
  <div id={contentId} class="content" hidden={!expanded}>
    {@render children()}
  </div>
</section>

<style>
  h3 {
    margin: 0;
  }
  button {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 11px 2px;
    border: 0;
    border-bottom: 1px solid var(--color-line);
    background: transparent;
    cursor: pointer;
    font: inherit;
    text-align: left;
  }
  button:hover {
    background: var(--color-hover);
  }
  button:focus-visible {
    outline: 1px solid var(--color-line-bright);
    outline-offset: -2px;
  }
  .caret {
    font-size: var(--fs-micro);
    color: var(--color-faint);
    flex-shrink: 0;
  }
  .name {
    font-size: var(--fs-meta);
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--color-ink);
  }
  .count {
    margin-left: auto;
    font-size: var(--fs-micro);
    color: var(--color-faint);
    font-variant-numeric: tabular-nums;
  }
  .content:not([hidden]) {
    display: flex;
  }
  .content {
    flex-direction: column;
  }

  @media (max-width: 768px) {
    button {
      min-height: 48px;
      gap: 10px;
    }
    .name {
      font-size: var(--fs-base);
    }
    .count,
    .caret {
      font-size: var(--fs-meta);
    }
  }
</style>
