<script lang="ts">
  // `multi-select` node: a filterable checklist contributing a `string[]` to a `submit: true`
  // action-button's body. Option labels are verbatim plugin DATA (never i18n).
  //
  // The field holds JSON because pluginField re-seeds by `!==`, so its seed must be a primitive.
  import type { PluginUINode } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { pluginField } from "./field.svelte";
  import PuiFilterList from "./PuiFilterList.svelte";
  import { selectOptions } from "./select-options";

  let { node }: { node: PluginUINode } = $props();

  const p = $derived(node.props ?? {});
  const name = $derived(typeof p.name === "string" ? p.name : "");
  const label = $derived(typeof p.label === "string" ? p.label : "");
  const options = $derived(selectOptions(p.options));

  const field = pluginField<string>(
    () => name,
    () => {
      const seeded = Array.isArray(p.value) ? p.value : [];
      return JSON.stringify(seeded.filter((v) => options.some((o) => o.value === v)));
    },
    (json) => JSON.parse(json) as string[],
  );

  const picks = $derived(JSON.parse(field.value) as string[]);
  const picked = $derived(new Set(picks));

  // A pick that left `options` can't be submitted. This is what clears the control after a
  // successful add (the plugin republishes without those rows); a failed add keeps its picks.
  $effect(() => {
    const kept = picks.filter((v) => options.some((o) => o.value === v));
    if (kept.length !== picks.length) field.set(JSON.stringify(kept));
  });

  function toggle(value: string) {
    const next = picked.has(value) ? picks.filter((v) => v !== value) : [...picks, value];
    field.set(JSON.stringify(next));
  }
</script>

<div class="pui-field">
  {#if label}<span class="pui-label">{label}</span>{/if}
  <PuiFilterList
    rows={options}
    label={label || name}
    mono={p.mono === true}
    multiple
    checks
    status={picks.length > 0 ? m.plugin_ui_list_picked({ count: picks.length }) : ""}
    isOn={(value) => picked.has(value)}
    onactivate={toggle}
  />
</div>
