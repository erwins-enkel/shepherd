<script lang="ts">
  import type { Snippet } from "svelte";
  import RequirementChips from "./RequirementChips.svelte";
  import RequirementsDerivation from "./RequirementsDerivation.svelte";
  import PlacementLine from "./PlacementLine.svelte";
  import type { PlacementPreview, RequirementsDerivation as Derivation } from "#lib/types.js";

  // The machine choice in New Task (#2772) as one strip: what the task needs on the left, where it
  // will run on the right — "REQUIREMENTS [Xcode ×] FROM TASK [+]   → MoneyPenny-2 THIS MACHINE".
  // A second line appears only when the operator has to act: a question, an offer to take over,
  // a failed read, no machine, or a machine out of reach. Layout only; the parts own their looks.
  let {
    requirements,
    onrequirements,
    derive,
    derivePending,
    derivation,
    touched,
    onadopt,
    preview,
    previewFailed,
    picker,
  }: {
    requirements: readonly string[];
    onrequirements: (next: string[]) => void;
    /** Whether the requirements are read from the task here (Automatic). */
    derive: boolean;
    derivePending: boolean;
    derivation: Derivation | null;
    touched: boolean;
    onadopt: (next: string[]) => void;
    preview: PlacementPreview | null;
    previewFailed: boolean;
    /** The machine choice, docked onto the route (desktop); without it the route stands alone. */
    picker?: Snippet;
  } = $props();
</script>

{#snippet derived(part: "tag" | "notice")}
  <RequirementsDerivation
    {part}
    pending={derivePending}
    {derivation}
    {touched}
    {requirements}
    onanswer={onrequirements}
    {onadopt}
  />
{/snippet}

{#snippet tag()}
  {@render derived("tag")}
{/snippet}

<div class="nt-strip">
  <RequirementChips
    {requirements}
    onchange={onrequirements}
    quietEmpty={derive && derivePending}
    tag={derive ? tag : undefined}
  />
  <PlacementLine {preview} failed={previewFailed} {picker} />
  {#if derive}
    {@render derived("notice")}
  {/if}
</div>

<style>
  .nt-strip {
    container-type: inline-size;
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    column-gap: 12px;
    row-gap: 8px;
  }
  /* The chips wrap inside their own area, so the route keeps the first line's right end. */
  .nt-strip > :global(.nt-requirements) {
    flex: 1 1 0;
    min-width: 0;
  }
  .nt-strip > :global(.nt-strip-note) {
    flex-basis: 100%;
  }
  /* Too narrow for both (a phone): the route takes its own line, left-aligned. */
  @container (max-width: 420px) {
    .nt-strip > :global(.nt-requirements),
    .nt-strip > :global(.nt-placement) {
      flex-basis: 100%;
    }
  }
</style>
