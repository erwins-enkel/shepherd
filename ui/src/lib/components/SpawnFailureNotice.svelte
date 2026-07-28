<script lang="ts">
  // #1944: the ONE surface a REFUSED plan-gate spawn has.
  //
  // Split out of PlanPanel deliberately, not just for its template budget: this block is rendered
  // INDEPENDENTLY of `planStalled`, because canShowPlanStallActions requires
  // `gate?.decision === "changes_requested" && round >= cap` and a refusal writes no gate row at
  // all. Borrowing that predicate would leave the operator with no surface whatsoever —
  // planGateChip yields "planning" and the Resume/Dismiss menu never opens.
  //
  // It names the required action in plain words rather than implying Retry resolves it: under
  // clamp-only scope the substantive fix is shortening the plan; Retry only re-attempts.
  import type { SpawnNotice } from "$lib/types";
  import { retrySpawnNotice } from "$lib/api";
  import { m } from "$lib/paraglide/messages";

  // Nullable + self-guarding: the caller renders this unconditionally, so PlanPanel's template
  // gains no branch of its own (it sits exactly on the Tier-1 cognitive bar).
  let { notice }: { notice: SpawnNotice | null } = $props();

  let busy = $state(false);
  let outcome = $state<"done" | "error" | null>(null);

  async function retry() {
    if (!notice || busy) return;
    busy = true;
    outcome = null;
    try {
      await retrySpawnNotice(notice.sessionId, notice.kind);
      outcome = "done";
    } catch {
      outcome = "error";
    } finally {
      busy = false;
    }
  }
</script>

{#if notice}
  <div class="spawn-failure" role="alert">
    <p class="sf-title">{m.spawnnotice_plan_failed_title()}</p>
    <p class="sf-detail">{notice.detail}</p>
    <p class="sf-action">{m.spawnnotice_plan_failed_action()}</p>
    <div class="sf-actions">
      <button type="button" class="sf-btn" onclick={retry} disabled={busy}>
        {busy ? m.spawnnotice_retrying() : m.spawnnotice_retry()}
      </button>
    </div>
    {#if outcome === "done"}
      <p class="sf-note" role="status">{m.spawnnotice_retry_queued()}</p>
    {:else if outcome === "error"}
      <p class="sf-note err" role="alert">{m.spawnnotice_retry_failed()}</p>
    {/if}
  </div>
{/if}

<style>
  /* Reads as a genuine blocker — blocked hue + the attention wash — so it is distinct from the
     amber in-flight/stall tones it sits beside. Tokens only, per the design system. */
  .spawn-failure {
    border: 1px solid color-mix(in srgb, var(--status-blocked) 45%, transparent);
    background: var(--wash-attention);
    border-radius: 3px;
    padding: 8px 10px;
    margin: 8px 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .sf-title {
    font-size: var(--fs-base);
    font-weight: 600;
    color: var(--status-blocked);
    margin: 0;
  }
  .sf-detail {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    margin: 0;
  }
  .sf-action {
    font-size: var(--fs-base);
    color: var(--color-ink);
    margin: 0;
  }
  .sf-actions {
    display: flex;
    gap: 6px;
    margin-top: 2px;
  }
  .sf-btn {
    font-size: var(--fs-meta);
    font-family: inherit;
    padding: 3px 10px;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    background: transparent;
    color: var(--color-ink);
    cursor: pointer;
  }
  .sf-btn:hover:not(:disabled) {
    color: var(--color-ink-bright);
  }
  .sf-btn:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .sf-note {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    margin: 0;
  }
  .sf-note.err {
    color: var(--status-blocked);
  }
</style>
