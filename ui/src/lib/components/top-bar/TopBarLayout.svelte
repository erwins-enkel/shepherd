<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import { assistantLayoutExplanation, assistantLayoutName } from "#lib/tooltips/explanations.js";
  import { coachTarget } from "#lib/actions/coachTarget.svelte.js";
  import {
    ASSISTANT_LAYOUTS,
    assistantLayout,
    type AssistantLayout,
  } from "#lib/assistant-layout.svelte.js";

  // The top bar's layout switch while the Operator Assistant is docked: how the grid splits its
  // width between the session column and the panel. Each glyph draws its split (herd, session,
  // assistant) so the choice reads before the tip opens.
  const SPLIT: Record<AssistantLayout, readonly [number, number, number]> = {
    standard: [6, 11, 7],
    half: [6, 9, 9],
    wide: [6, 6, 12],
    talk: [6, 2, 16],
  };
</script>

<div
  class="layout"
  role="group"
  aria-label={m.assistant_layout_group()}
  use:coachTarget={"topbar-layout"}
>
  {#each ASSISTANT_LAYOUTS as layout (layout)}
    {@const [herd, session, panel] = SPLIT[layout]}
    {@const on = assistantLayout.layout === layout}
    <button
      type="button"
      class="seg"
      class:on
      aria-pressed={on}
      aria-label={assistantLayoutName(layout)}
      data-layout={layout}
      onclick={() => assistantLayout.set(layout)}
      use:statusTip={{
        text: assistantLayoutExplanation(layout),
        stopClickPropagation: false,
        pinOnClick: false,
      }}
    >
      <svg viewBox="0 0 29 16" aria-hidden="true">
        <rect class="herd" x="1" y="1" width={herd} height="14" rx="1" />
        <rect class="session" x={2.5 + herd} y="1" width={session} height="14" rx="1" />
        <rect x={4 + herd + session} y="1" width={panel} height="14" rx="1" />
      </svg>
    </button>
  {/each}
</div>

<style>
  /* One chip on the top bar's 6px rung (DESIGN.md), holding a segment per layout. The picked
     one takes the Assist chip's amber primary treatment — outline + inset glow, never a fill. */
  .layout {
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    gap: 2px;
    min-height: var(--topbar-ctl-h);
    padding: 2px;
    border: 1px solid var(--color-line-bright);
    border-radius: var(--radius-chip);
    flex-shrink: 0;
  }
  .seg {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    align-self: stretch;
    padding: 0;
    background: transparent;
    border: 1px solid transparent;
    border-radius: calc(var(--radius-chip) - 2px);
    color: var(--color-muted);
    cursor: pointer;
  }
  .seg:hover {
    background: var(--color-hover);
    color: var(--color-ink);
  }
  .seg:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .seg.on {
    border-color: var(--color-amber);
    color: var(--color-amber);
    box-shadow: inset 0 0 12px -8px var(--color-amber);
  }
  svg {
    width: 26px;
    height: 14px;
    fill: currentColor;
  }
  /* The assistant's column reads strongest: it is what the switch sizes. */
  .herd {
    opacity: 0.35;
  }
  .session {
    opacity: 0.6;
  }
</style>
