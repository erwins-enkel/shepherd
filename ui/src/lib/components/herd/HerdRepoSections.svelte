<script lang="ts">
  import type { Session } from "#lib/types.js";
  import type { HerdStatus } from "../herd-status";
  import type { StageTag } from "../herd-repo-groups";
  import type { HerdRowCtx } from "./HerdGroup.svelte";
  import HerdRepoSection from "./HerdRepoSection.svelte";
  import { herdLayout } from "#lib/herd-layout.svelte.js";
  import { m } from "#lib/paraglide/messages.js";

  // The Repo layout's sections (#4228), alphabetical, each folding per the persisted
  // herdLayout.collapsed set it shares with the page's keyboard nav and jump reveal. The Stage
  // layout's group-header bulk actions (Merge train, clear merged) follow in a trailing row,
  // labelled as covering every repo so it never reads as the last section's (#4235).
  type BulkAction = { class: string; title: string; label: string; onclick: () => void };

  let {
    sections,
    actions = [],
    onrevealsession,
    statusFilter,
    onstatusfilter,
    tagFor,
    ctx,
    touchTarget = false,
    flow = false,
  }: {
    sections: {
      key: string;
      name: string;
      iconPath: string | null;
      rows: Session[];
      aboveIds: string[];
      counts: Record<HerdStatus, number>;
    }[];
    actions?: BulkAction[];
    onrevealsession?: (id: string) => void;
    statusFilter: HerdStatus | null;
    onstatusfilter?: (status: HerdStatus | null) => void;
    tagFor: (session: Session) => StageTag | null;
    ctx: HerdRowCtx;
    touchTarget?: boolean;
    flow?: boolean;
  } = $props();
</script>

{#each sections as section (section.key)}
  <HerdRepoSection
    name={section.name}
    iconPath={section.iconPath}
    rows={section.rows}
    aboveIds={section.aboveIds}
    {onrevealsession}
    counts={section.counts}
    collapsed={herdLayout.collapsed.has(section.key)}
    ontoggle={() => herdLayout.toggleRepo(section.key)}
    {statusFilter}
    {onstatusfilter}
    {tagFor}
    {ctx}
    {touchTarget}
    {flow}
  />
{/each}
{#if actions.length > 0}
  <div class="repo-actions" class:touch={touchTarget}>
    <span class="scope">{m.herd_repo_actions_scope()}</span>
    {#each actions as action (action.class)}
      <button type="button" class={action.class} title={action.title} onclick={action.onclick}>
        {action.label}
      </button>
    {/each}
  </div>
{/if}

<style>
  /* The bulk actions the Stage layout carries in its Ready / Merged headers, as one quiet row:
     green for the merge train (actionable-complete), blue for clearing landed PRs. */
  .repo-actions {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 8px 4px;
    margin-top: 12px;
    border-top: 1px solid var(--color-line);
  }
  /* quiet scope label on the left; the actions sit on the right */
  .scope {
    margin-right: auto;
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-faint);
  }
  .repo-actions button {
    border: 0;
    background: none;
    font-family: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    cursor: pointer;
    padding: 0 2px;
    transition: color 0.12s ease;
  }
  .repo-actions.touch button {
    min-height: 44px;
    padding-inline: 8px;
  }
  .repo-actions button:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .merge-train {
    color: color-mix(in srgb, var(--color-green) 70%, var(--color-faint));
  }
  .merge-train:hover {
    color: var(--color-green);
  }
  .clear-merged {
    color: color-mix(in srgb, var(--color-blue) 70%, var(--color-faint));
  }
  .clear-merged:hover {
    color: var(--color-blue);
  }
</style>
