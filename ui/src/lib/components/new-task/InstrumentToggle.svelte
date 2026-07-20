<script lang="ts">
  import GlossaryText from "$lib/components/GlossaryText.svelte";
  import { statusTip } from "$lib/actions/statusTip.svelte";
  import { m } from "$lib/paraglide/messages";

  // Instrument-style switch row (26×14 track, 10×10 knob) for the Guards group.
  //
  // Accessibility contract (see .shepherd-plan.md): the transparent full-row
  // button[role=switch] is the ONLY hit + keyboard target; the visual layer is a
  // pointer-events:none sibling. The two interactive raisers — the glossary term
  // inside the label and the statusTip'd ON/OFF suffix — are DOM SIBLINGS of the
  // switch (never nested), raised above the hit layer, so their activation can
  // never toggle. The switch is named by the visible label (aria-labelledby) and
  // described by a visually-hidden copy of the repo-default text.
  let {
    checked,
    labelMarkup,
    disabled = false,
    loading = false,
    defaultTip,
    onchange,
  }: {
    checked: boolean;
    /** Message value with a glossary marker, e.g. "[[plan-gate|Plan gate]]". */
    labelMarkup: string;
    disabled?: boolean;
    loading?: boolean;
    /** "Repo default: on/off" text derived from the REAL repo default. */
    defaultTip: string;
    onchange: (checked: boolean) => void;
  } = $props();

  const uid = $props.id();
</script>

<div class="toggle-row">
  <button
    type="button"
    role="switch"
    class="hit"
    aria-checked={checked}
    aria-labelledby="{uid}-label"
    aria-describedby="{uid}-default"
    disabled={disabled || loading}
    onclick={() => onchange(!checked)}
  ></button>
  <span class="visual" class:dim={disabled || loading}>
    <span class="track" class:on={checked} aria-hidden="true">
      <span class="knob"></span>
    </span>
    <span class="label" id="{uid}-label"><GlossaryText text={labelMarkup} /></span>
    {#if loading}
      <span class="status loading">{m.common_loading()}</span>
    {:else}
      <span class="status" class:on={checked} use:statusTip={{ text: defaultTip }}
        >{checked ? m.newtask_toggle_on() : m.newtask_toggle_off()}</span
      >
    {/if}
  </span>
  <span class="sr-only" id="{uid}-default">{defaultTip}</span>
</div>

<style>
  .toggle-row {
    position: relative;
    display: flex;
    align-items: center;
    min-height: 18px;
  }
  /* Full-row hit + keyboard target. Transparent; the visual layer renders beneath. */
  .hit {
    position: absolute;
    inset: 0;
    z-index: 0;
    margin: 0;
    padding: 0;
    background: transparent;
    border: 0;
    cursor: pointer;
  }
  .hit:disabled {
    cursor: not-allowed;
  }
  .hit:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .visual {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    pointer-events: none;
  }
  .visual.dim {
    opacity: 0.6;
  }
  .track {
    flex-shrink: 0;
    box-sizing: border-box;
    width: 26px;
    height: 14px;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    background: var(--color-inset);
    padding: 1px;
    display: inline-flex;
    align-items: center;
    justify-content: flex-start;
  }
  .track.on {
    border-color: color-mix(in srgb, var(--color-amber) 62%, var(--color-line));
    justify-content: flex-end;
  }
  .knob {
    width: 10px;
    height: 10px;
    border-radius: 1px;
    background: var(--color-slate);
  }
  .track.on .knob {
    background: var(--color-amber);
  }
  .label {
    min-width: 0;
    font-size: var(--fs-meta);
    color: var(--color-ink-bright);
    white-space: nowrap;
  }
  /* The glossary term's own button must stay clickable above the hit layer. */
  .label :global(button) {
    pointer-events: auto;
    position: relative;
    z-index: 1;
  }
  .status {
    margin-left: auto;
    flex-shrink: 0;
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    color: var(--color-faint);
    white-space: nowrap;
    /* statusTip's inline position/z-index raise it; pointer-events must be on for it. */
    pointer-events: auto;
  }
  .status.on {
    color: var(--color-amber);
  }
  .status.loading {
    pointer-events: none;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
