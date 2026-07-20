<script lang="ts">
  import type { Issue } from "$lib/types";
  import { m } from "$lib/paraglide/messages";

  // Inline `#` issue search for the New Task prompt — same anchored-menu pattern as
  // SlashCommandMenu (absolute below the field, mousedown-pick to keep textarea focus,
  // parent drives activeIndex from arrow keys). Epic-parent rows render disabled: they
  // are not pickable as manual tasks (they'd collide with the Epic Runner).
  let {
    issues,
    activeIndex,
    epicParents = new Set(),
    onpick,
    onhover,
  }: {
    issues: Issue[];
    activeIndex: number;
    epicParents?: Set<number>;
    onpick: (issue: Issue) => void;
    onhover: (index: number) => void;
  } = $props();

  let listEl = $state<HTMLUListElement | null>(null);
  $effect(() => {
    const row = listEl?.children[activeIndex] as HTMLElement | undefined;
    row?.scrollIntoView({ block: "nearest" });
  });
</script>

<div class="ism-panel" role="presentation">
  {#if issues.length === 0}
    <div class="ism-empty">{m.issuesearch_menu_empty()}</div>
  {:else}
    <ul class="ism-list" bind:this={listEl} role="listbox" aria-label={m.issuesearch_menu_label()}>
      {#each issues as issue, i (issue.number)}
        {@const epic = epicParents.has(issue.number)}
        <li
          class="ism-row"
          class:active={i === activeIndex}
          class:epic
          role="option"
          aria-selected={i === activeIndex}
          aria-disabled={epic || undefined}
          tabindex="-1"
          title={epic ? m.promptsources_epic_hint() : undefined}
          onmousedown={(e) => {
            e.preventDefault(); // keep focus in the textarea
            if (!epic) onpick(issue);
          }}
          onmousemove={() => onhover(i)}
        >
          <span class="ism-number">#{issue.number}</span>
          <span class="ism-title">{issue.title}</span>
          {#if epic}<span class="ism-epic-tag">{m.promptsources_epic_tag()}</span>{/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .ism-panel {
    position: absolute;
    z-index: 40;
    top: calc(100% + 2px);
    left: 0;
    right: 0;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    box-shadow: var(--shadow-popover);
  }
  .ism-list {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 220px;
    overflow-y: auto;
    overflow-x: hidden;
  }
  .ism-row {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 5px 10px;
    cursor: pointer;
    border-bottom: 1px solid var(--color-line);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
  }
  .ism-row:last-child {
    border-bottom: 0;
  }
  .ism-row.active,
  .ism-row:hover {
    background: var(--color-hover);
  }
  .ism-row.epic {
    cursor: default;
  }
  .ism-number {
    flex-shrink: 0;
    color: var(--color-faint);
    font-variant-numeric: tabular-nums;
  }
  .ism-title {
    flex: 1;
    min-width: 0;
    color: var(--color-ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ism-row.epic .ism-title,
  .ism-row.epic .ism-number {
    color: var(--color-faint);
  }
  .ism-epic-tag {
    flex-shrink: 0;
    padding: 0 4px;
    border: 1px solid var(--status-running);
    border-radius: 2px;
    color: var(--status-running);
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .ism-empty {
    font-family: var(--font-mono);
    padding: 8px 10px;
    color: var(--color-faint);
    font-size: var(--fs-meta);
    font-style: italic;
  }
  @media (max-width: 768px) {
    .ism-row {
      min-height: 44px;
      align-items: center;
    }
  }
</style>
