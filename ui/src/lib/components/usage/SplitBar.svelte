<script lang="ts">
  interface Props {
    /** Magnitude of segment A (left). */
    a: number;
    /** Magnitude of segment B (right). */
    b: number;
    /**
     * Fill colour for segment A. MUST be a `var(--color-*)` token.
     * @default "var(--color-blue)"
     */
    aTone?: string;
    /**
     * Fill colour for segment B. MUST be a `var(--color-*)` token.
     * @default "var(--color-amber)"
     */
    bTone?: string;
    /** Optional aria-label for segment A. */
    aLabel?: string;
    /** Optional aria-label for segment B. */
    bLabel?: string;
    /** Optional extra CSS class applied to segment A element. */
    aClass?: string;
    /** Optional extra CSS class applied to segment B element. */
    bClass?: string;
  }

  const {
    a,
    b,
    aTone = "var(--color-blue)",
    bTone = "var(--color-amber)",
    aLabel,
    bLabel,
    aClass,
    bClass,
  }: Props = $props();

  const total = $derived(a + b);
  const aPct = $derived(total > 0 ? (a / total) * 100 : 0);
  const bPct = $derived(total > 0 ? (b / total) * 100 : 0);
</script>

<!--
  Decorative two-segment proportion bar. Numeric shares are shown as text by the
  parent, so the bar itself is aria-hidden to avoid screen-reader duplication.
-->
<div class="split-bar" aria-hidden="true">
  {#if total > 0}
    <div
      class="split-segment {aClass ?? ''}"
      style="width: {aPct}%; background: {aTone};"
      aria-label={aLabel}
    ></div>
    <div
      class="split-segment {bClass ?? ''}"
      style="width: {bPct}%; background: {bTone};"
      aria-label={bLabel}
    ></div>
  {/if}
</div>

<style>
  .split-bar {
    width: 100%;
    height: 8px;
    border-radius: 4px;
    overflow: hidden;
    display: flex;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
  }

  .split-segment {
    height: 100%;
    transition: width 0.2s ease;
  }
</style>
