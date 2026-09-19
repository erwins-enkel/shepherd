<script lang="ts">
  import { m } from "$lib/paraglide/messages";

  // The one place that says "this merge is someone else's" — shared by the merge confirmation,
  // the decommission dialog's merge choice and the merge-train confirmation, so the three can
  // never drift into three different explanations of the same state.
  let {
    handoff,
    handoffWho,
    reviewBlockBy,
    compact = false,
  }: {
    handoff?: "reviewer" | "merger" | null;
    handoffWho?: string | null;
    /** Reported on its own line: an outstanding review block is a separate fact from whose turn
     *  it is, and both can hold at once. */
    reviewBlockBy?: string | null;
    /** Tighter type + spacing for use inside a row or an already-dense dialog. */
    compact?: boolean;
  } = $props();
</script>

{#if handoff || reviewBlockBy}
  <div class={["notice", compact ? "compact" : ""]} role="note">
    {#if handoff === "merger" && handoffWho}
      <p class="lead">{m.mergeconfirm_handoff_merger({ who: handoffWho })}</p>
    {:else if handoff === "reviewer" && handoffWho}
      <p class="lead">{m.mergeconfirm_handoff_reviewer({ who: handoffWho })}</p>
    {:else if handoff}
      <p class="lead">{m.mergeconfirm_handoff_other()}</p>
    {/if}
    {#if reviewBlockBy}
      <p class="sub">{m.mergeconfirm_review_block({ who: reviewBlockBy })}</p>
    {/if}
  </div>
{/if}

<style>
  .notice {
    border: 1px solid color-mix(in srgb, var(--color-amber) 40%, transparent);
    background: var(--color-inset);
    border-radius: 2px;
    padding: 9px 10px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .notice.compact {
    padding: 6px 8px;
  }
  .lead {
    margin: 0;
    color: var(--color-amber);
    font-size: var(--fs-base);
    line-height: 1.4;
  }
  .compact .lead {
    font-size: var(--fs-meta);
  }
  .sub {
    margin: 0;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    line-height: 1.4;
  }
</style>
