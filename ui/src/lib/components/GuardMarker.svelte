<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import type { GuardStepKind } from "#lib/guard-timeline.js";

  // The "who acts here" marker — ▲ YOU / ⚙ AUTO / ◈ CONDITIONAL. Shared by the New Task guard
  // timeline and the epic landing card's "who's handling it" bar (#2872), so both read alike.
  let { kind }: { kind: GuardStepKind } = $props();

  const glyph = $derived(kind === "human" ? "▲" : kind === "auto" ? "⚙" : "◈");
  const label = $derived(
    kind === "human"
      ? m.guardtl_marker_you()
      : kind === "auto"
        ? m.guardtl_marker_auto()
        : m.guardtl_marker_conditional(),
  );
</script>

<span class="gtl-marker {kind}">
  <span class="gtl-glyph" aria-hidden="true">{glyph}</span>
  {label}
</span>

<style>
  .gtl-marker {
    flex-shrink: 0;
    display: inline-flex;
    align-items: baseline;
    gap: 3px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--color-slate);
  }
  /* Semantic, not decorative: amber is the "needs you" accent already carried by the
     guard toggles' ON readout; blue marks a condition without reading as a failure
     (red) or as actionable-complete (green, reserved). */
  .gtl-marker.human {
    color: var(--color-amber);
  }
  .gtl-marker.conditional {
    color: var(--color-blue);
  }
  .gtl-glyph {
    font-size: var(--fs-micro);
  }
</style>
