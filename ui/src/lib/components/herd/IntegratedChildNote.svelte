<script lang="ts">
  // #3016: the chip on a session its epic integrated (merged into the epic branch). Local: that it
  // is integrated. On another machine: also how its settle there stands — explained, with what the
  // operator can do, in the structured tooltip.
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import {
    integratedNoteExplanation,
    integratedNoteLabel,
    integratedNoteTone,
    type IntegratedNoteInput,
  } from "#lib/integrated-child-note.js";

  let { note }: { note: IntegratedNoteInput } = $props();

  const label = $derived(integratedNoteLabel(note));
  const tip = $derived(integratedNoteExplanation(note));
  const tone = $derived(integratedNoteTone(note));
</script>

<span
  class="chip-integrated chip-integrated--{tone}"
  data-testid="integrated-note"
  use:statusTip={{ text: tip, wide: true, pinOnClick: false }}>{label}</span
>

<style>
  /* Settled work, not an error: slate like a finished session (--status-done). A settle that waits
     on the operator takes the manual-steps warn recipe. statusTip raises it above the row's hit
     overlay so it can explain itself. */
  .chip-integrated {
    flex: none;
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    padding: 1px 6px;
    border: 1px solid var(--status-done);
    border-radius: 2px;
    color: var(--status-done);
    background: color-mix(in oklab, var(--status-done) 12%, transparent);
    cursor: help;
  }
  .chip-integrated--warn {
    border-color: var(--status-warn);
    color: var(--status-warn);
    background: color-mix(in oklab, var(--status-warn) 12%, transparent);
  }
</style>
