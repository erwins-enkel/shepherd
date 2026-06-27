<script lang="ts">
  import type { PluginUINode } from "$lib/types";

  let { node }: { node: PluginUINode } = $props();

  const p = $derived(node.props ?? {});
  const value = $derived(String(p.value ?? ""));
  const size = $derived(
    (p.size as string | undefined) === "micro"
      ? "var(--fs-micro)"
      : (p.size as string | undefined) === "lg"
        ? "var(--fs-lg)"
        : "var(--fs-base)",
  );
  const color = $derived(
    (p.tone as string | undefined) === "muted" ? "var(--color-muted)" : "var(--color-ink)",
  );
  const fontWeight = $derived((p.weight as string | undefined) === "bold" ? "600" : "400");
</script>

<span class="pui-text" style:font-size={size} style:color style:font-weight={fontWeight}
  >{value}</span
>

<style>
  .pui-text {
    display: block;
    line-height: 1.5;
  }
</style>
