<script lang="ts">
  interface Props {
    value: number;
    max: number;
    /**
     * Fill colour expressed as a CSS design-token reference, e.g. `var(--color-blue)`.
     * MUST be a `var(--color-*)` token — never a raw hex, rgba(), or any other
     * color literal. The value is injected directly into an inline `background`
     * style, so callers that bypass the token rule will silently break the
     * design system. Review is the enforcement gate.
     */
    tone?: string;
  }

  const { value, max, tone = "var(--color-blue)" }: Props = $props();

  const fillPct = $derived(max > 0 ? Math.max(2, (value / max) * 100) : 2);
</script>

<!--
  Decorative horizontal bar. The numeric value is shown as text by the parent
  component, so the bar itself is aria-hidden to avoid screen-reader duplication.
-->
<div class="usage-bar-track" aria-hidden="true">
  <div class="usage-bar-fill" style="width: {fillPct}%; background: {tone};"></div>
</div>

<style>
  .usage-bar-track {
    width: 100%;
    height: 6px;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 3px;
    overflow: hidden;
  }

  .usage-bar-fill {
    height: 100%;
    border-radius: 3px;
    transition: width 0.2s ease;
  }
</style>
