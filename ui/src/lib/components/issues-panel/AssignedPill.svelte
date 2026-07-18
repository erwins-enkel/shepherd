<script lang="ts">
  import { m } from "$lib/paraglide/messages";

  // The plain-issue assignee pill (#1694), extracted from IssueRow so that row's
  // <template> stays under the fallow Tier-1 complexity bar (mirrors EpicOthersPill).
  // Two modes, chosen by the caller from whether the viewer is known:
  //  - framed (viewer known): "assigned to X" — the "someone else's work" signal, X
  //    being the non-viewer assignees. Neutral muted styling (an assignment is not
  //    in-progress work, so NOT the amber EpicOthersPill token).
  //  - neutral (viewer unknown): a factual person-glyph listing of the assignees with
  //    no "assigned to / others" framing, so a null-viewer row (local forge / offline /
  //    unauthed gh) keeps #1046's visibility without a false "others" claim.
  // Renders nothing when `who` is empty. Its class is `.assigned-pill` (distinct from
  // EpicOthersPill's `.others-pill`) so the two never alias in tests/queries.
  let { who = [], framed = false }: { who?: string[]; framed?: boolean } = $props();

  const whoText = $derived(who.join(", "));
</script>

{#if who.length > 0}
  {#if framed}
    <span class="assigned-pill framed" title={m.issuerow_assigned_notice({ who: whoText })}
      >{m.issuerow_assigned_pill({ who: whoText })}</span
    >
  {:else}
    <span class="assigned-pill neutral" title={m.issuerow_assignees_title({ who: whoText })}
      ><span class="glyph" aria-hidden="true">👤</span>{whoText}</span
    >
  {/if}
{/if}

<style>
  /* Neutral "assigned to X" / assignee-listing pill (#1694). Muted informational tone —
     an assignment isn't running work, so it deliberately avoids EpicOthersPill's amber
     --status-running. Follows the muted .label-chip recipe (see /design-system). */
  .assigned-pill {
    flex: 0 1 auto;
    max-width: 18ch;
    overflow: hidden;
    padding: 1px 6px;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    background: color-mix(in srgb, var(--color-muted) 8%, transparent);
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.02em;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Neutral mode leads with a person glyph + the verbatim logins (mixed-case, so no
     uppercasing/extra letter-spacing). */
  .assigned-pill.neutral {
    display: inline-flex;
    align-items: baseline;
    gap: 4px;
  }

  .assigned-pill.neutral .glyph {
    font-size: var(--fs-micro);
  }
</style>
