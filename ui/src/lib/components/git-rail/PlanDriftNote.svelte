<script lang="ts">
  // #2155 — the critic's plan-drift measurement, rendered inside the review popover.
  //
  // It is a MEASUREMENT, never a verdict: no chip, no badge, no tone that competes with the
  // decision the popover is actually reporting. Nothing shows when the diff followed the plan, or
  // when the run measured nothing (no plan shown, or an errored critic).
  //
  // Its own component rather than an {#if} in GitRail's markup: that template sits at the Tier-1
  // Svelte complexity bar, where a branch nested this deep costs far more than the two lines it
  // renders (see .fallowrc.jsonc thresholdOverrides).
  import type { ReviewVerdict } from "$lib/types";
  import { m } from "$lib/paraglide/messages";

  const { verdict }: { verdict: ReviewVerdict } = $props();

  const drift = $derived(verdict.planDrift);
  const label = $derived(
    drift === "major" ? m.gitrail_plan_drift_major() : m.gitrail_plan_drift_minor(),
  );
  // The note is the critic's own prose (data), so it is appended rather than interpolated into a
  // catalog string — nothing to translate in it, and no message key can carry it.
  const note = $derived(verdict.planDriftNote ? ` — ${verdict.planDriftNote}` : "");
</script>

{#if drift && drift !== "none"}
  <p class="rv-drift">{label}{note}</p>
{/if}

<style>
  .rv-drift {
    margin: 0;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    /* pinned alongside head/footer; only .rv-body scrolls */
    flex-shrink: 0;
  }
</style>
