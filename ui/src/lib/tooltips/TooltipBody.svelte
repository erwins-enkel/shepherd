<script lang="ts">
  import type { TooltipContent } from "./content";

  let { content }: { content: TooltipContent } = $props();
</script>

<!-- Phrasing elements keep this valid inside GlossaryTerm's inline disclosure,
     including when its trigger sits inside a paragraph. Never render raw HTML. -->
<span class="tooltip-body">
  {#if typeof content === "string"}
    {content}
  {:else}
    <strong class="tooltip-title">{content.title}</strong>
    <span class="tooltip-summary">{content.summary}</span>
    <span class="tooltip-sections">
      {#each content.sections as section, index (index)}
        <span class="tooltip-section">
          <strong class="tooltip-label">{section.label}</strong>
          <span>{section.text}</span>
        </span>
      {/each}
    </span>
  {/if}
</span>

<style>
  .tooltip-body {
    display: block;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    font-weight: 400;
    line-height: 1.55;
    text-align: left;
    text-transform: none;
    letter-spacing: normal;
    white-space: normal;
    overflow-wrap: anywhere;
  }

  .tooltip-title {
    display: block;
    margin-bottom: 6px;
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
    font-weight: 600;
    line-height: 1.35;
  }

  .tooltip-summary {
    display: block;
  }

  .tooltip-sections {
    display: grid;
    gap: 10px;
    margin-top: 12px;
  }

  .tooltip-sections:empty {
    display: none;
  }

  .tooltip-section,
  .tooltip-label {
    display: block;
  }

  .tooltip-label {
    margin-bottom: 2px;
    color: var(--color-ink-bright);
    font-weight: 600;
  }
</style>
