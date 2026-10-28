<script lang="ts">
  import type { Epic } from "#lib/types.js";
  import HerdGroup from "./HerdGroup.svelte";
  import type { HerdRowCtx } from "./HerdGroup.svelte";
  import EpicGroupHeader from "../EpicGroupHeader.svelte";

  type EpicGroupEntry = {
    key: string;
    epic: Epic;
    sessions: import("#lib/types.js").Session[];
  };

  let {
    groups,
    collapsedKeys,
    cuesFor,
    onepic,
    oncollapsetoggle,
    slotsFor = () => null,
    ctx,
  }: {
    groups: EpicGroupEntry[];
    collapsedKeys: Set<string>;
    cuesFor: (g: { key: string; sessions: import("#lib/types.js").Session[] }) => {
      ciFailed: number;
      needsRework: number;
      branchProtectionBlocked: number;
      ready: number;
      blocked: number;
    };
    onepic?: (repoPath: string, issueNumber: number) => void;
    oncollapsetoggle?: (key: string) => void;
    /** A repo's agent slots (its drain cap); null when unknown. */
    slotsFor?: (repoPath: string) => number | null;
    ctx: HerdRowCtx;
  } = $props();
</script>

{#each groups as g, i (g.key)}
  <!-- Only the first badge anchors the coachmark: coachTargets keys one node per id. -->
  <EpicGroupHeader
    epic={g.epic}
    collapsed={collapsedKeys.has(g.key)}
    cues={cuesFor(g)}
    nowMs={ctx.nowMs}
    slots={slotsFor(g.epic.repoPath)}
    coachId={i === 0 ? "epic-timing" : ""}
    ontoggle={() => oncollapsetoggle?.(g.key)}
    {onepic}
  />
  {#if !collapsedKeys.has(g.key)}
    <div class="epic-children">
      <HerdGroup sessions={g.sessions} withPreview={true} {ctx} />
    </div>
  {/if}
{/each}

<style>
  /* Child rows of an epic group nest by indentation alone: their pips shift one --nest step
     right of the top-level pips. No rail — a vertical line here doubled up with the rows'
     own edges. */
  .epic-children {
    --nest: 20px;
  }
  .epic-children :global(.unit) {
    padding-left: calc(14px + var(--nest));
  }
  @container herd (max-width: 300px) {
    .epic-children {
      --nest: 12px;
    }
  }
</style>
