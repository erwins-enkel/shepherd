<script lang="ts">
  import type { GitState } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import { claudeShipExplanation } from "#lib/tooltips/explanations.js";

  // #4145: Claude Ship (Code Review / PR Steward / Claude Approvals) is active on this open PR.
  // A read-only readout on the Herd card (`card`) or a chip in the git rail (`rail`); hover/focus
  // explains what it is doing and that its checks are review gates, not CI. Amber while the
  // Approvals check waits on a human; muted otherwise. Renders nothing without a signal.
  let {
    git,
    variant = "card",
  }: {
    git?: GitState | null;
    variant?: "card" | "rail";
  } = $props();

  const signal = $derived(git?.state === "open" ? git.claudeShip : undefined);
  const waiting = $derived(signal?.approvals === "pending" || signal?.approvals === "failure");
  const label = $derived(waiting ? m.claude_ship_badge_waiting() : m.claude_ship_badge());
</script>

{#if signal}
  <span
    class={variant === "card" ? "badge cs-badge" : "cs-chip"}
    class:waiting
    role="img"
    aria-label={label}
    use:statusTip={{ text: claudeShipExplanation(signal) }}
  >
    {label}
  </span>
{/if}

<style>
  /* Card segment: the strip's quiet uppercase text. */
  .cs-badge {
    margin: 0;
    font-size: var(--fs-micro);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    white-space: nowrap;
    color: var(--color-muted);
  }
  /* Rail chip: the verdict chip's geometry. */
  .cs-chip {
    margin: 0;
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
    padding: 3px 9px;
    border: 1px solid currentColor;
    border-radius: var(--radius-chip);
    color: var(--color-muted);
  }
  /* Waiting on a human approval: the attention hue, never red — nothing is broken. */
  .waiting {
    color: var(--color-amber);
  }
</style>
