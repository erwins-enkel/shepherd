<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import type { UpNextPrActions } from "#lib/up-next-pr-actions.svelte.js";
  import { upNextPrKey, upNextUi } from "#lib/up-next-ui.svelte.js";
  import UpNextBand, { type UpNextPrBandGroup } from "./UpNextBand.svelte";
  import UpNextKindHeader from "./UpNextKindHeader.svelte";

  // Up Next's leading block: the PRs waiting on the operator, under their super-header, one
  // tinted band each for ready, review, blocked and Dependabot. The super-header folds the whole
  // block. Fold and "show all" state stay with the panel, shared with the issue bands.
  let {
    groups,
    count,
    showRepo,
    actions,
    open,
    onfoldblock,
    isOpen,
    isExpanded,
    onfold,
    onexpand,
  }: {
    groups: UpNextPrBandGroup[];
    count: number;
    showRepo: boolean;
    actions: UpNextPrActions;
    /** The whole block unfolded. */
    open: boolean;
    onfoldblock: () => void;
    isOpen: (id: string) => boolean;
    isExpanded: (id: string) => boolean;
    onfold: (id: string) => void;
    onexpand: (id: string) => void;
  } = $props();

  // Ticked PRs the folded block hides — its header says so, so a batch never acts on unseen work.
  const hidden = $derived(
    open
      ? 0
      : groups.flatMap((g) => g.items).filter((pr) => upNextUi.selected.has(upNextPrKey(pr)))
          .length,
  );
</script>

<UpNextKindHeader
  title={m.upnext_pr_kind_title()}
  sub={m.upnext_pr_kind_sub()}
  {count}
  {open}
  {hidden}
  onfold={onfoldblock}
/>
{#if open}
  {#each groups as g (g.id)}
    <UpNextBand
      group={g}
      open={isOpen(g.id)}
      expanded={isExpanded(g.id)}
      {showRepo}
      onfold={() => onfold(g.id)}
      onexpand={() => onexpand(g.id)}
      prActions={actions}
    />
  {/each}
{/if}
