<script lang="ts">
  import type { Snippet } from "svelte";
  import { m } from "#lib/paraglide/messages.js";
  import { placementReason, placementRefusalText, placementWaitText } from "#lib/placement.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import { placementExplanation, placementWaitExplanation } from "#lib/tooltips/explanations.js";
  import type { PlacementPreview } from "#lib/types.js";

  // Where the task will run and why (#2772), before it is submitted: the server's preview of the
  // very choice the create makes. The route ("→ MoneyPenny-2  this machine") closes the machine
  // strip's first line; the reason lives in its tooltip and accessible name. A refusal reads as a
  // warning on the strip's second line — submitting would start nothing. A machine out of reach
  // (#2775) does too: the task would wait for it. A `picker` (the machine choice, desktop) docks
  // onto the route as one chip and stays there in every state, also while nothing is placed.
  let {
    preview,
    failed = false,
    picker,
  }: { preview: PlacementPreview | null; failed?: boolean; picker?: Snippet } = $props();

  const placement = $derived(preview?.placement ?? null);
  // Placed on the Shepherd that decided: this one.
  const here = $derived(
    placement !== null && placement.target.instanceId === placement.by.instanceId,
  );
  const machine = $derived(
    placement && here
      ? m.placement_this_machine({ machine: placement.target.name })
      : (placement?.target.name ?? ""),
  );
  const busy = $derived(placement?.load?.state === "busy");
  /** The one word after the machine: the non-color cue for high load, else whose choice it is. */
  const qualifier = $derived(
    busy
      ? m.placement_qual_busy()
      : here
        ? m.newtask_runon_here()
        : placement?.mode === "manual"
          ? m.placement_basis_manual()
          : "",
  );
</script>

{#snippet route(host: string, qual: string)}
  <span class="arrow" aria-hidden="true">→</span>
  <span class="host">{host}</span>
  {#if qual}
    <span class="qual">{qual}</span>
  {/if}
{/snippet}

{#snippet routePart()}
  {#if placement && preview?.wait}
    <!-- The note below says it in full; the route only repeats it at a glance. -->
    <span class="nt-placement warn" aria-hidden="true">
      {@render route(placement.target.name, m.placement_qual_unreachable())}
    </span>
  {:else if placement}
    <button
      type="button"
      class="nt-placement"
      class:warn={busy}
      aria-label={m.placement_runs_on({ machine, reason: placementReason(placement) })}
      use:statusTip={{ text: placementExplanation(placement, true), wide: true }}
    >
      {@render route(placement.target.name, qualifier)}
    </button>
  {:else if preview?.refusal}
    <span class="nt-placement warn" aria-hidden="true">
      <span class="arrow">→</span>
      <span>{m.placement_route_none()}</span>
    </span>
  {:else if !preview && !failed}
    <span class="nt-placement" role="status">
      <span class="arrow" aria-hidden="true">→</span>
      {m.placement_choosing()}
    </span>
  {/if}
{/snippet}

{#if picker}
  <span class="nt-route-pick">
    {@render routePart()}
    {@render picker()}
  </span>
{:else}
  {@render routePart()}
{/if}

{#if placement && preview?.wait}
  <button
    type="button"
    class="nt-placement-note nt-strip-note warn"
    use:statusTip={{ text: placementWaitExplanation(placement, preview.wait), wide: true }}
  >
    {placementWaitText(placement, preview.wait)}
  </button>
{:else if !placement && preview?.refusal}
  <span class="nt-placement-note nt-strip-note warn" role="status">
    {placementRefusalText(preview.refusal)}
  </span>
{:else if failed && !preview}
  <span class="nt-placement-note nt-strip-note" role="status">{m.placement_preview_failed()}</span>
{/if}

<style>
  .nt-placement {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
    max-width: 100%;
    white-space: nowrap;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  button.nt-placement,
  button.nt-placement-note {
    background: transparent;
    border: none;
    padding: 0;
    font-family: inherit;
    text-align: left;
    cursor: help;
  }
  /* A long machine name is cut, not wrapped; its accessible name and tooltip carry it whole. */
  .host {
    min-width: 0;
    overflow: clip;
    text-overflow: ellipsis;
    font-family: var(--font-mono);
    color: var(--color-ink-bright);
  }
  .qual {
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  button.nt-placement:hover .qual,
  button.nt-placement:focus-visible .qual {
    color: var(--color-ink);
  }
  .nt-placement-note {
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  /* The route with the machine choice docked on: one chip, the picker's segment full height. */
  .nt-route-pick {
    display: inline-flex;
    align-items: stretch;
    max-width: 100%;
    min-width: 0;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    background: var(--color-panel-2);
  }
  .nt-route-pick > .nt-placement {
    align-self: center;
    min-width: 0;
    padding: 3px 8px;
  }
  .warn,
  .warn .host {
    color: var(--status-warn);
  }
  button.nt-placement.warn:hover .qual,
  button.nt-placement.warn:focus-visible .qual {
    color: var(--status-warn);
  }
</style>
