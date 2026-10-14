<script lang="ts">
  import type { Session } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { displayStatus } from "#lib/display-status.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import { operatorAssistantExplanation } from "#lib/tooltips/explanations.js";
  import { coachTarget } from "#lib/actions/coachTarget.svelte.js";
  import AssistantGlyph from "../AssistantGlyph.svelte";

  // The top bar's Assist toggle (#1446): opens and closes the Operator Assistant panel. A pip
  // carries the assistant's own state so a turn finishing (or a command waiting for approval)
  // reads from anywhere: amber while it works, red while it waits for the operator, none at rest.
  let {
    assistant,
    open,
    compact,
    mobile = false,
    workingBlocked,
    backgroundBusy,
    onclick,
  }: {
    assistant: Session | null;
    open: boolean;
    compact: boolean;
    /** Phone layout (width-only): the chip takes the 44px floor the gear has. */
    mobile?: boolean;
    workingBlocked: Record<string, boolean>;
    backgroundBusy: Record<string, boolean>;
    onclick: () => void;
  } = $props();

  const status = $derived(
    assistant ? displayStatus(assistant, workingBlocked, backgroundBusy) : null,
  );
  const pip = $derived(status === "running" ? "working" : status === "blocked" ? "blocked" : null);
  const label = $derived(
    pip === "working"
      ? m.topbar_assist_working()
      : pip === "blocked"
        ? m.topbar_assist_blocked()
        : m.operator_assistant_title(),
  );
</script>

<button
  id="topbar-assist"
  type="button"
  class="assist"
  class:compact
  class:phone={mobile}
  class:on={open}
  aria-pressed={open}
  aria-label={label}
  {onclick}
  use:statusTip={{
    text: operatorAssistantExplanation(),
    stopClickPropagation: false,
    pinOnClick: false,
  }}
  use:coachTarget={"topbar-assist"}
>
  <AssistantGlyph size={mobile ? "var(--fs-xl)" : "var(--fs-lg)"} />
  {#if !compact}<span class="assist-label">{m.topbar_assist()}</span>{/if}
  {#if pip}<span class="assist-pip {pip}" data-pip={pip} aria-hidden="true"></span>{/if}
</button>

<style>
  /* Top-bar right cluster: the shared 6px chip rung and control height (DESIGN.md). Active is the
     amber primary treatment — outline + inset glow, never a solid fill. */
  .assist {
    box-sizing: border-box;
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    min-height: var(--topbar-ctl-h);
    padding: 0 10px;
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: var(--radius-chip);
    color: var(--color-muted);
    cursor: pointer;
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    flex-shrink: 0;
  }
  .assist:hover {
    background: var(--color-hover);
    color: var(--color-ink);
  }
  .assist:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .assist.on {
    border-color: var(--color-amber);
    color: var(--color-amber);
    box-shadow: inset 0 0 18px -10px var(--color-amber);
  }
  .assist.compact {
    min-width: 44px;
  }
  /* Phone: the gear's ghost-button language (.gear.mobile), not the desktop chip — the bar's
     ● ✦ ⚙ cluster reads as three equal 44px cells; open = .gear.open's sel ground. The 44px
     floor is width-gated: `mobile` is width-only, so a fine-pointer narrow viewport gets no help
     from the coarse-pointer floor below. */
  .assist.phone {
    min-height: 44px;
    padding: 0;
    border-color: transparent;
  }
  .assist.phone:hover {
    background: transparent;
    color: var(--color-amber);
  }
  .assist.phone.on {
    background: var(--color-sel);
    border-color: var(--color-line-bright);
    color: var(--color-ink-bright);
    box-shadow: none;
  }
  /* The status pip (DESIGN.md "Status Pip"): pinned to the chip's top-right corner, ringed in the
     bar's ground so it reads against the border. Working pulses; blocked stays solid red. */
  .assist-pip {
    position: absolute;
    top: -4px;
    right: -4px;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    box-shadow: 0 0 0 2px var(--color-panel);
  }
  /* Phone: no border to straddle, so the pip sits inside the cell like .gear-pip. */
  .assist.phone .assist-pip {
    top: 2px;
    right: 2px;
    width: 7px;
    height: 7px;
  }
  .assist-pip.working {
    background: var(--status-running);
  }
  .assist-pip.blocked {
    background: var(--status-blocked);
  }
  .assist-pip.working::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: color-mix(in srgb, var(--status-running) 70%, transparent);
    pointer-events: none;
    /* functional status motion — exempt from the reduced-motion blanket (app.css) */
    animation: pip-pulse 1.5s ease-out infinite !important;
  }

  @media (pointer: coarse) {
    .assist {
      min-height: 44px;
      min-width: 44px;
    }
  }
</style>
