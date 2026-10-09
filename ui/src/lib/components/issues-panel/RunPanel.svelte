<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import type { TooltipContent } from "#lib/tooltips/content.js";
  import type { EpicRunTone } from "../epic-panel";

  // The set-apart run area at the top of the backlog reading detail (#2620, #2622): a caption,
  // the live state with its pulse, optional actions, then the content. The epic's
  // "Abarbeitung", an epic child's standing / session and the repo overview all render in it —
  // only the content changes.
  let {
    label,
    stateText,
    tone,
    kind = undefined,
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
      <span class="run-state tone-{tone}" data-kind={kind} use:statusTip={{ text: stateTip }}
        ><span class="pulse" aria-hidden="true"></span>{stateText}</span
      >
    {:else}
      <span class="run-state tone-{tone}" data-kind={kind}
        ><span class="pulse" aria-hidden="true"></span>{stateText}</span
      >
    {/if}
    <span class="spacer"></span>
    {@render actions?.()}
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
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
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

  @media (max-width: 768px) {
    .run-control {
      position: static;
    }
  }
</style>
