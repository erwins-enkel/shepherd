<script lang="ts">
  import { untrack, type Snippet } from "svelte";

  let {
    title,
    hint,
    defaultOpen = false,
    children,
  }: {
    title: string;
    hint?: string;
    defaultOpen?: boolean;
    children: Snippet;
  } = $props();

  let expanded = $state(untrack(() => defaultOpen));
  const sectionId = $props.id();
  const contentId = `${sectionId}-content`;
</script>

<section class="settings-section">
  <h2>
    <button
      type="button"
      aria-expanded={expanded}
      aria-controls={contentId}
      onclick={() => (expanded = !expanded)}
    >
      <span>{title}</span>
      <span class="chevron" aria-hidden="true">{expanded ? "▴" : "▾"}</span>
    </button>
  </h2>
  <div id={contentId} class="content" hidden={!expanded}>
    {#if hint}
      <p class="hint">{hint}</p>
    {/if}
    {@render children()}
  </div>
</section>

<style>
  .settings-section:not(:first-child) {
    border-top: 1px solid var(--color-line);
  }
  h2 {
    margin: 0;
  }
  button {
    width: 100%;
    min-height: 44px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    border: 0;
    border-radius: 0;
    padding: 8px 10px;
    background: var(--color-panel-2);
    color: var(--color-ink);
    cursor: pointer;
    font: inherit;
    font-size: var(--fs-meta);
    font-weight: 500;
    letter-spacing: 0.12em;
    text-align: left;
    text-transform: uppercase;
  }
  button:hover {
    background: var(--color-hover);
    color: var(--color-ink-bright);
  }
  button:focus-visible {
    outline: 1px solid var(--color-line-bright);
    outline-offset: -2px;
    background: var(--color-inset);
    color: var(--color-ink-bright);
  }
  .chevron {
    flex: 0 0 auto;
    color: var(--color-muted);
    font-size: var(--fs-base);
  }
  .content:not([hidden]) {
    display: flex;
  }
  .content {
    flex-direction: column;
    gap: 10px;
    padding: 10px 0 4px;
  }
  .hint {
    color: var(--color-faint);
    font-size: var(--fs-meta);
    margin: 0;
  }
</style>
