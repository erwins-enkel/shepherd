<script lang="ts">
  import type { PluginUINode } from "$lib/types";

  let { node }: { node: PluginUINode } = $props();

  const p = $derived(node.props ?? {});
  const label = $derived(String(p.label ?? ""));

  type BadgeTone = "neutral" | "ok" | "warn" | "error" | "info";
  const TONE_COLOR: Record<BadgeTone, string> = {
    neutral: "var(--color-muted)",
    ok: "var(--color-green)",
    warn: "var(--status-warn)",
    error: "var(--color-red)",
    info: "var(--color-blue)",
  };

  const rawTone = $derived(p.tone as string | undefined);
  const toneColor = $derived(
    rawTone && rawTone in TONE_COLOR ? TONE_COLOR[rawTone as BadgeTone] : TONE_COLOR.neutral,
  );
</script>

<span class="badge pui-badge" style:color={toneColor} style:border-color={toneColor}>{label}</span>

<style>
  .pui-badge {
    display: inline-block;
  }
</style>
