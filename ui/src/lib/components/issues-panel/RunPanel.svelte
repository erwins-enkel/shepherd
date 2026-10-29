<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import type { TooltipContent } from "#lib/tooltips/content.js";
  import type { EpicRunTone, RunDot } from "../epic-panel";

  // The set-apart run area at the top of the backlog reading detail (#2620, #2622): a caption,
  // the live state with its pulse, optional actions, then the content. The epic's
  // "Abarbeitung", an epic child's standing / session and the repo overview all render in it —
  // only the content changes.
  let {
    label,
    stateText,
    tone,
    kind = undefined,
    dot = undefined,
    stateTip = undefined,
    actions = undefined,
    children,
    ...rest
  }: {
    label: string;
    stateText: string;
    tone: EpicRunTone;
    /** Exposed as `data-kind` on the state, for tests and styling hooks. */
    kind?: string;
    /** Shape of the state dot (repo overview, #2639); exposed as `data-dot`. Omitted → the plain
     *  tone-coloured dot the epic and child panels use. */
    dot?: RunDot;
    /** Explanation shown on hovering the state. */
    stateTip?: TooltipContent;
    actions?: Snippet;
    children: Snippet;
  } & Omit<HTMLAttributes<HTMLElement>, "children"> = $props();
</script>

<section class="run-control" aria-label={label} {...rest}>
  <div class="run-head">
    <span class="caption">{label}</span>
    {#if stateTip}
      <span
        class="run-state tone-{tone}"
        data-kind={kind}
        data-dot={dot}
        use:statusTip={{ text: stateTip }}
        ><span class="pulse" aria-hidden="true"></span>{stateText}</span
      >
    {:else}
      <span class="run-state tone-{tone}" data-kind={kind} data-dot={dot}
        ><span class="pulse" aria-hidden="true"></span>{stateText}</span
      >
    {/if}
    <span class="spacer"></span>
    {#if actions}
      <div class="run-actions">{@render actions()}</div>
    {/if}
  </div>
  {@render children()}
</section>

<style>
  /* Its own surface, set apart from the reading detail: inset ground, hairline frame and the
     popover shadow so content scrolling under the sticky region reads as "under". Sticky only
     on wider layouts — on a phone a tall pinned block would bury the detail. */
  .run-control {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px 10px;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    box-shadow: var(--shadow-popover);
    font-size: var(--fs-meta);
    container: run-panel / inline-size;
  }

  .run-head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }

  .caption {
    color: var(--color-faint);
    font-size: var(--fs-micro);
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .run-state {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--color-muted);
    font-size: var(--fs-base);
  }
  .run-state.tone-run {
    color: var(--status-running);
  }
  .run-state.tone-halt {
    color: var(--status-blocked);
  }
  .run-state.tone-busy {
    color: var(--color-amber);
  }
  /* Shaped dot (repo overview): a leading run reads in text colour, not amber — amber is kept
     for "every slot taken" (busy) and a winding-down epic. */
  .run-state[data-dot="filled"].tone-run {
    color: var(--color-ink-bright);
  }
  .run-state[data-dot="ring"] .pulse {
    background: transparent;
    box-shadow: inset 0 0 0 1px currentColor;
  }
  .run-state[data-dot="half"] .pulse {
    background: linear-gradient(90deg, currentColor 50%, transparent 50%);
    box-shadow: inset 0 0 0 1px currentColor;
  }

  .pulse {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
  }
  /* Functional status pulse — encodes "work happening / waiting its turn", so it overrides the
     reduced-motion blanket like the other status indicators (see app.css). */
  .tone-run .pulse {
    animation: dot-pulse 1.6s ease-in-out infinite !important;
  }

  .spacer {
    flex: 1;
  }

  .run-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  /* Narrow panel: the actions leave the state's line and take a full-width row of their own,
     so buttons never strand one by one around the state. */
  @container run-panel (max-width: 560px) {
    .run-actions {
      flex-basis: 100%;
    }
  }

  @media (max-width: 768px) {
    .run-control {
      position: static;
    }
  }
</style>
