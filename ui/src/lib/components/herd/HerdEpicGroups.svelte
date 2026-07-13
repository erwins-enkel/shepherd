<script lang="ts">
  import type { Epic } from "$lib/types";
  import HerdGroup from "./HerdGroup.svelte";
  import type { HerdRowCtx } from "./HerdGroup.svelte";
  import EpicGroupHeader from "../EpicGroupHeader.svelte";

  type EpicGroupEntry = {
    key: string;
    epic: Epic;
    sessions: import("$lib/types").Session[];
  };

  let {
    groups,
    collapsedKeys,
    cuesFor,
    onepic,
    oncollapsetoggle,
    ctx,
  }: {
    groups: EpicGroupEntry[];
    collapsedKeys: Set<string>;
    cuesFor: (g: { key: string; sessions: import("$lib/types").Session[] }) => {
      ciFailed: number;
      needsRework: number;
      branchProtectionBlocked: number;
      ready: number;
      blocked: number;
    };
    onepic?: (repoPath: string, issueNumber: number) => void;
    oncollapsetoggle?: (key: string) => void;
    ctx: HerdRowCtx;
  } = $props();
</script>

{#each groups as g (g.key)}
  <EpicGroupHeader
    epic={g.epic}
    collapsed={collapsedKeys.has(g.key)}
    cues={cuesFor(g)}
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
  /* Child rows of an epic group sit lightly inset under their headline so the
     group reads as one unit. A hairline rail on the leading edge reinforces the
     nesting without a heavy indent. Token-based; no raw px color. */
  .epic-children {
    padding-left: 10px;
    margin-left: 4px;
    border-left: 1px solid color-mix(in srgb, var(--color-blue) 30%, var(--color-line));
  }
</style>
