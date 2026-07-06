<script lang="ts">
  import type { Session } from "$lib/types";
  import { planGates } from "$lib/reviews.svelte";
  import { composePlanGateTooltip, planGateChip } from "./plan-gate-badge";
  import PlanPanel from "./PlanPanel.svelte";
  import { m } from "$lib/paraglide/messages";

  // allowView (default true): whether to surface the read-only "view"/PLAN chip during
  // execution. The dense session-list surfaces (UnitRow/UnitTile) pass false so this chip
  // lives only in the per-session top bar (issue #809); see plan-gate-badge.ts.
  let { session, allowView = true }: { session: Session; allowView?: boolean } = $props();

  const gate = $derived(planGates.map[session.id]);
  const reviewing = $derived(planGates.isReviewing(session.id));
  const chip = $derived(planGateChip(session, gate, reviewing, { allowView }));

  let open = $state(false);

  const title = $derived(
    composePlanGateTooltip(chip, gate, {
      fallback: m.plangate_title(),
      planning: m.plangate_tip_planning(),
      reviewing: m.plangate_tip_reviewing(),
      changes: m.plangate_tip_changes(),
      changesStalled: m.plangate_tip_changes_stalled(),
      ready: m.plangate_tip_ready(),
      error: m.plangate_tip_error(),
      view: m.plangate_tip_view(),
    }),
  );
</script>

{#if chip.kind !== "none"}
  <button
    type="button"
    class="pg-badge pg-{chip.kind}"
    {title}
    onclick={(e) => {
      e.stopPropagation();
      open = true;
    }}
  >
    {#if chip.kind === "reviewing"}
      <span class="rev-dot" aria-hidden="true"></span>{m.plangate_reviewing()}
    {:else if chip.kind === "changes"}
      {m.plangate_changes({ round: chip.round, cap: chip.cap })}
    {:else if chip.kind === "ready"}
      {m.plangate_ready()}
    {:else if chip.kind === "error"}
      {m.plangate_error()}
    {:else if chip.kind === "view"}
      {m.plangate_view()}
    {:else}
      {m.plangate_planning()}
    {/if}
  </button>
{/if}

{#if open}
  <PlanPanel {session} onclose={() => (open = false)} />
{/if}

<style>
  .pg-badge {
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 1px 6px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    white-space: nowrap;
    color: var(--color-muted);
    background: transparent;
    font-family: inherit;
    cursor: pointer;
  }
  .pg-badge:hover {
    border-color: var(--color-line-bright);
  }
  .pg-changes {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .pg-ready {
    border-color: var(--color-green);
    color: var(--color-green);
    font-weight: 600;
  }
  .pg-error {
    color: var(--color-faint);
  }
  /* read-only re-open of the signed-off plan during execution (issue #809). Lives only in
     the per-session top bar (the dense list cards opt out via allowView=false), so it can
     afford to read as a real control rather than a whisper: legible ink + a visible resting
     border. Stays NEUTRAL — green is reserved for READY, amber for in-flight; a parked,
     read-only plan is passive, so it must not borrow a semantic hue. */
  .pg-view {
    color: var(--color-ink);
    border-color: var(--color-line-bright);
    font-weight: 500;
  }
  .pg-view:hover {
    color: var(--color-ink-bright);
  }
  /* plan reviewer running now: amber outline + pulsing dot (mirrors CriticBadge) */
  .pg-reviewing {
    border-color: var(--color-amber);
    color: var(--color-amber);
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .rev-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-amber);
    /* functional status motion — exempt from the reduced-motion blanket (app.css) */
    animation: pg-pulse 1.1s ease-in-out infinite !important;
  }
  @keyframes pg-pulse {
    0%,
    100% {
      opacity: 0.3;
    }
    50% {
      opacity: 1;
    }
  }
</style>
