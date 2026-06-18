<script lang="ts">
  import type { VisualBlock, CalloutTone } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  let { block }: { block: Extract<VisualBlock, { type: "callout" }> } = $props();

  const TONE_COLOR: Record<CalloutTone, string> = {
    info: "var(--color-blue)",
    decision: "var(--color-amber)",
    risk: "var(--color-red)",
    warning: "var(--color-amber)",
    success: "var(--color-green)",
  };

  function toneLabel(t: CalloutTone): string {
    switch (t) {
      case "info":
        return m.vblock_callout_info();
      case "decision":
        return m.vblock_callout_decision();
      case "risk":
        return m.vblock_callout_risk();
      case "warning":
        return m.vblock_callout_warning();
      case "success":
        return m.vblock_callout_success();
    }
  }

  let rendered = $state("");
  $effect(() => {
    const md = block.markdown;
    if (!md) {
      rendered = "";
      return;
    }
    let alive = true;
    Promise.all([import("marked"), import("dompurify")])
      .then(([{ marked }, { default: DOMPurify }]) => {
        if (alive) rendered = DOMPurify.sanitize(marked.parse(md, { async: false }) as string);
      })
      .catch((err) => console.warn("CalloutBlock markdown render failed", err));
    return () => {
      alive = false;
    };
  });
</script>

<div class="callout" style:border-left-color={TONE_COLOR[block.tone]}>
  <span class="callout-tone" style:color={TONE_COLOR[block.tone]}>{toneLabel(block.tone)}</span>
  {#if rendered}
    <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized via DOMPurify above -->
    <div class="callout-md">{@html rendered}</div>
  {/if}
</div>

<style>
  .callout {
    border-left: 3px solid var(--color-amber); /* overridden per-tone via style:border-left-color */
    background: var(--color-inset);
    padding: 8px 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .callout-tone {
    font-size: var(--fs-micro);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .callout-md {
    font-size: var(--fs-meta);
    color: var(--color-ink);
    line-height: 1.5;
  }
  .callout-md :global(p) {
    margin: 0;
  }
</style>
