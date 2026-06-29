<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import type { Session } from "$lib/types";
  import { modelLabel } from "$lib/model-label";
  import HerdGroup from "./HerdGroup.svelte";
  import type { HerdRowCtx } from "./HerdGroup.svelte";
  import type { ExperimentGroup } from "../experiment-grouping";

  let {
    groups,
    oncompare,
    ctx,
  }: {
    groups: ExperimentGroup[];
    // open the provider/model picker to spawn a comparison run, anchored at the click
    oncompare?: (experimentId: string, anchor: { x: number; y: number }) => void;
    ctx: HerdRowCtx;
  } = $props();

  // Short provider · model chip for a variant (brand names are not translated).
  function chip(s: Session): string {
    const provider = s.agentProvider === "codex" ? "Codex" : "Claude";
    const model = s.model ? modelLabel(s.model) : m.newtask_model_default();
    return `${provider} · ${model}`;
  }

  // Comparison reads only COMMITTED branch state, so it's gated until every variant is at rest:
  // a still-running variant would yield a stale/empty diff. `blocked` counts as at-rest but may
  // have little committed — surfaced in the hint rather than blocking.
  function canCompare(g: ExperimentGroup): boolean {
    return !!oncompare && g.variants.every((v) => v.status !== "running");
  }

  function members(g: ExperimentGroup): Session[] {
    return g.comparison ? [...g.variants, g.comparison] : g.variants;
  }
</script>

{#each groups as g (g.experimentId)}
  <div class="exp-head">
    <span class="exp-title">{m.experiment_group_label({ name: g.label })}</span>
    <span class="exp-chips">
      {#each g.variants as v (v.id)}
        <span class="exp-chip">{chip(v)}</span>
      {/each}
    </span>
    {#if g.comparison}
      <span class="exp-done">{m.experiment_comparison_done()}</span>
    {/if}
    <button
      class="gbtn primary exp-compare"
      type="button"
      disabled={!canCompare(g)}
      title={canCompare(g) ? m.experiment_compare_hint() : m.experiment_compare_running_hint()}
      onclick={(e) => oncompare?.(g.experimentId, { x: e.clientX, y: e.clientY })}
    >
      {m.experiment_compare()}
    </button>
  </div>
  <div class="exp-children">
    <HerdGroup sessions={members(g)} withPreview={true} {ctx} />
  </div>
{/each}

<style>
  .exp-head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    padding: 6px 4px 4px;
  }
  .exp-title {
    color: var(--color-ink-bright);
    font-size: var(--fs-meta);
    letter-spacing: 0.04em;
  }
  .exp-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .exp-chip {
    font-size: var(--fs-micro);
    letter-spacing: 0.04em;
    color: var(--color-muted);
    border: 1px solid var(--color-line);
    border-radius: 999px;
    padding: 1px 8px;
    white-space: nowrap;
  }
  .exp-done {
    font-size: var(--fs-micro);
    letter-spacing: 0.04em;
    color: var(--color-blue);
    border: 1px solid color-mix(in srgb, var(--color-blue) 40%, var(--color-line));
    border-radius: 999px;
    padding: 1px 8px;
  }
  .exp-compare {
    margin-left: auto;
  }
  /* Mirror the epic group's leading rail so the comparison set reads as one unit. */
  .exp-children {
    padding-left: 10px;
    margin-left: 4px;
    border-left: 1px solid color-mix(in srgb, var(--color-blue) 30%, var(--color-line));
  }
  /* Canonical .gbtn recipe (see /design-system). */
  .gbtn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 6px 12px;
    cursor: pointer;
  }
  .gbtn:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .gbtn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .gbtn.primary {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
</style>
