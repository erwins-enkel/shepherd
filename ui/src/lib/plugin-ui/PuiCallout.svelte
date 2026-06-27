<script lang="ts">
  import type { PluginUINode } from "$lib/types";

  let { node }: { node: PluginUINode } = $props();

  const p = $derived(node.props ?? {});
  const text = $derived(String(p.text ?? ""));

  type CalloutTone = "info" | "warn" | "error";
  const TONE_COLOR: Record<CalloutTone, string> = {
    info: "var(--color-blue)",
    warn: "var(--color-amber)",
    error: "var(--color-red)",
  };

  const rawTone = $derived(p.tone as string | undefined);
  const toneColor = $derived(
    rawTone && rawTone in TONE_COLOR ? TONE_COLOR[rawTone as CalloutTone] : TONE_COLOR.info,
  );
</script>

<div class="pui-callout" style:border-left-color={toneColor}>
  <span class="pui-callout-text">{text}</span>
</div>

<style>
  .pui-callout {
    border-left: 3px solid var(--color-blue);
    background: var(--color-inset);
    padding: 8px 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .pui-callout-text {
    font-size: var(--fs-meta);
    color: var(--color-ink);
    line-height: 1.5;
  }
</style>
