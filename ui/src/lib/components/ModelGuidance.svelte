<script lang="ts">
  import { modelGuidance, type ModelGuidanceContext } from "$lib/model-guidance";
  import type { AgentProvider } from "$lib/types";

  let {
    provider,
    model,
    context = "task",
    compact = false,
  }: {
    provider: AgentProvider;
    model: string;
    context?: ModelGuidanceContext;
    compact?: boolean;
  } = $props();

  const guidance = $derived(modelGuidance(provider, model, context));
  const className = $derived(`model-guidance${compact ? " compact" : ""}`);
</script>

<div class={className} role="note">
  <span class="mg-cost">{guidance.costLabel} · {guidance.costMark}</span>
  <span class="mg-tag">{guidance.tag}</span>
  <span class="mg-detail">{guidance.detail}</span>
  {#if guidance.contextNote}
    <span class="mg-note">{guidance.contextNote}</span>
  {/if}
</div>

<style>
  .model-guidance {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 5px 8px;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    line-height: 1.35;
    margin: 0;
  }
  .model-guidance.compact {
    gap: 4px 7px;
  }
  .mg-cost,
  .mg-tag {
    flex: 0 0 auto;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    padding: 1px 5px;
    color: var(--color-ink);
    font-size: var(--fs-micro);
    text-transform: uppercase;
    font-variant-numeric: tabular-nums;
  }
  .mg-tag {
    color: var(--color-amber);
    border-color: color-mix(in srgb, var(--color-amber) 54%, var(--color-line));
  }
  .mg-detail,
  .mg-note {
    flex: 1 1 16rem;
    min-width: 0;
  }
  .mg-note {
    color: var(--color-faint);
  }
  .compact .mg-detail,
  .compact .mg-note {
    flex-basis: 100%;
  }
</style>
