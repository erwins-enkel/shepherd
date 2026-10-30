<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { providerLabel } from "#lib/reviewer-env.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import type { TooltipExplanation } from "#lib/tooltips/content.js";
  import {
    quickStartAria,
    quickStartEffortText,
    quickStartHoldText,
    quickStartModelText,
    type QuickStartChip,
  } from "#lib/up-next-quick-start.js";
  import { gaugeColor } from "./usage-gauges";

  // One quick-start chip: a CLI's saved model + effort as a one-click start. Props only, so the
  // Up Next preview and the batch bar (#3510) mount the same chip. The 2-px bar on the bottom
  // edge is the CLI's 5h usage; a Claude chip over the hold threshold turns warn and names when
  // the hold lifts (the click still starts — the server holds the session, as for any start).
  // A not-ready CLI is `aria-disabled`, not `disabled`, so its tooltip can still say why.
  let {
    chip,
    tip,
    nowMs,
    starting = false,
    clipped = false,
    onstart,
  }: {
    chip: QuickStartChip;
    tip: TooltipExplanation;
    nowMs: number;
    /** A start is in flight (this surface's starter): every start button is locked. */
    starting?: boolean;
    /** The preview's fit measurement clipped it: laid out for measuring, but unseen and untabbable. */
    clipped?: boolean;
    onstart: () => void;
  } = $props();

  const blocked = $derived(chip.state === "blocked");
  const hold = $derived(chip.state === "hold");
  const subtitle = $derived(
    starting
      ? m.upnext_quickstart_starting()
      : blocked
        ? m.upnext_quickstart_blocked()
        : hold
          ? quickStartHoldText(chip, nowMs)
          : `${quickStartModelText(chip)} · ${quickStartEffortText(chip)}`,
  );
</script>

<button
  type="button"
  class="qs-chip unp-chip"
  class:hold
  class:blocked
  class:clipped
  aria-label={quickStartAria(chip)}
  aria-disabled={blocked ? "true" : undefined}
  disabled={starting}
  use:statusTip={{ text: tip, wide: true, stopClickPropagation: false, pinOnClick: false }}
  onclick={() => {
    if (!blocked) onstart();
  }}
>
  <svg class="qs-bolt" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
    <path d="M9.5 1 3 9h4l-1 6 7-8.5H9z" fill="currentColor" />
  </svg>
  <span class="qs-text">
    <b class="qs-cli">{providerLabel(chip.provider)}</b>
    <span class="qs-sub">{subtitle}</span>
  </span>
  {#if chip.usedPct !== null}
    <i
      class="qs-bar"
      style:width="{Math.min(Math.max(chip.usedPct, 0), 100)}%"
      style:background={hold ? "var(--color-warn)" : gaugeColor(chip.usedPct)}
    ></i>
  {/if}
</button>

<style>
  .qs-chip {
    position: relative;
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px;
    overflow: hidden;
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-meta);
    white-space: nowrap;
    cursor: pointer;
  }
  .qs-bolt {
    flex: none;
    color: var(--color-amber);
  }
  .qs-text {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
  }
  .qs-cli {
    color: var(--color-ink-bright);
    font-weight: 700;
    letter-spacing: 0.04em;
  }
  .qs-sub {
    color: var(--color-muted);
  }
  .qs-bar {
    position: absolute;
    left: 0;
    bottom: 0;
    height: 2px;
  }
  .qs-chip:hover:not(:disabled):not(.blocked),
  .qs-chip:focus-visible {
    border-color: var(--color-amber);
    outline: none;
  }
  .qs-chip:focus-visible {
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .qs-chip.hold .qs-bolt,
  .qs-chip.hold .qs-sub {
    color: var(--color-warn);
  }
  .qs-chip.blocked {
    border-style: dashed;
    cursor: not-allowed;
  }
  .qs-chip.blocked .qs-bolt,
  .qs-chip.blocked .qs-cli {
    color: var(--color-muted);
  }
  .qs-chip:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .qs-chip.clipped {
    visibility: hidden;
  }

  /* Phone: two lines (CLI / model · effort), 52 px tall. */
  @media (max-width: 768px), (pointer: coarse) {
    .qs-chip {
      min-height: 52px;
      padding-block: 6px;
    }
    .qs-text {
      flex-direction: column;
      align-items: flex-start;
      gap: 2px;
      overflow: hidden;
    }
    .qs-sub {
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  }
</style>
