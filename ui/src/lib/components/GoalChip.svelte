<script lang="ts">
  import type { Session } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import type { TooltipExplanation } from "#lib/tooltips/content.js";
  import { coachTarget } from "#lib/actions/coachTarget.svelte.js";
  import { goalChip } from "./goal-chip";

  // #2596: the session's Claude Code `/goal`, beside the plan-gate chip. Read-only: the
  // accessible name carries state + condition; statusTip adds the structured explanation.
  // `compact` (Herd card): the held variant drops its "· held" suffix and reads by its
  // dashed border instead, so the dense badge row stays short.
  // `coach`: register as the What's-New coachmark anchor (focused view only).
  let {
    session,
    compact = false,
    coach = false,
  }: {
    session: Pick<Session, "planPhase" | "goalState" | "goalCondition">;
    compact?: boolean;
    coach?: boolean;
  } = $props();

  const chip = $derived(goalChip(session));

  const label = $derived(
    chip.kind === "held" && !compact ? m.goalchip_label_held() : m.goalchip_label(),
  );

  const ariaLabel = $derived(
    chip.kind === "held"
      ? m.goalchip_aria_held({ condition: chip.condition })
      : chip.kind === "active"
        ? m.goalchip_aria_active({ condition: chip.condition })
        : "",
  );

  const tip = $derived.by((): TooltipExplanation | null => {
    if (chip.kind === "held")
      return {
        title: m.goalchip_tip_held_title(),
        summary: m.goalchip_tip_held_summary(),
        sections: [
          { label: m.goalchip_tip_condition(), text: chip.condition },
          { label: m.goalchip_tip_why_held(), text: m.goalchip_tip_why_held_body() },
          { label: m.goalchip_tip_on_go(), text: m.goalchip_tip_on_go_body() },
        ],
      };
    if (chip.kind === "active")
      return {
        title: m.goalchip_tip_active_title(),
        summary: m.goalchip_tip_active_summary(),
        sections: [
          { label: m.goalchip_tip_condition(), text: chip.condition },
          { label: m.goalchip_tip_what_it_does(), text: m.goalchip_tip_what_it_does_body() },
        ],
      };
    return null;
  });
</script>

{#if chip.kind !== "none" && tip}
  <span
    class="goal-chip goal-{chip.kind}"
    role="img"
    aria-label={ariaLabel}
    use:statusTip={{ text: tip }}
    use:coachTarget={coach ? "goal-chip" : ""}>{label}</span
  >
{/if}

<style>
  /* Same chip geometry as the plan-gate badge it sits beside. Hues stay quiet: a goal is
     noted info, not a verdict — never green (READY) and never amber (in-flight review). */
  .goal-chip {
    display: inline-block;
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 1px 6px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    white-space: nowrap;
    color: var(--color-muted);
    cursor: default;
  }
  /* waiting for Go: dashed + muted, so it reads as parked even without the suffix */
  .goal-held {
    border-style: dashed;
    border-color: var(--color-line-bright);
  }
  /* running in the agent: the slate "noted info" tier (matches the Research badge) */
  .goal-active {
    border-color: var(--color-slate);
    color: var(--color-slate);
    font-weight: 600;
  }
</style>
