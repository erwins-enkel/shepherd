<script lang="ts">
  // `select` node (issue #1961): a choice among values the plugin enumerates, contributing a
  // named value to a `submit: true` action-button's body. Option labels are verbatim plugin
  // DATA (never i18n).
  //
  // The seed is clamped to the offered set: an absent or unknown `value` falls back to the
  // FIRST option, so the value this field submits is always one the plugin itself listed.
  //
  // The autofill guard (issue #1978) matters here for a second reason: it also suppresses
  // browser form-value RESTORATION, which sets a select's DOM value on reload WITHOUT firing
  // `change` — leaving what the operator sees diverged from what the form scope would submit.
  //
  // `searchable` renders a filterable list for long option sets, and drops the clamp: it starts
  // empty rather than preselecting a row, so an unattended submit can't act on the wrong one.
  import type { PluginUINode } from "#lib/types.js";
  import { noAutofill } from "./autofill";
  import { pluginField } from "./field.svelte";
  import PuiFilterList from "./PuiFilterList.svelte";
  import { selectOptions } from "./select-options";

  let { node }: { node: PluginUINode } = $props();

  const guard = noAutofill();

  const p = $derived(node.props ?? {});
  const name = $derived(typeof p.name === "string" ? p.name : "");
  const label = $derived(typeof p.label === "string" ? p.label : "");
  const searchable = $derived(p.searchable === true);
  const options = $derived(selectOptions(p.options));

  const field = pluginField<string>(
    () => name,
    () => {
      const seeded = typeof p.value === "string" ? p.value : null;
      if (seeded !== null && options.some((o) => o.value === seeded)) return seeded;
      return searchable ? "" : (options[0]?.value ?? "");
    },
  );

  // The seed stays "" across republishes, so pluginField never clears this on its own. Without
  // it, a pick the plugin just consumed would stay in the form scope while the list shows
  // nothing picked, and the next submit would act on it again.
  $effect(() => {
    if (searchable && field.value !== "" && !options.some((o) => o.value === field.value)) {
      field.set("");
    }
  });
</script>

{#if searchable}
  <div class="pui-field">
    {#if label}<span class="pui-label">{label}</span>{/if}
    <PuiFilterList
      rows={options}
      label={label || name}
      mono={p.mono === true}
      status={options.find((o) => o.value === field.value)?.label ?? ""}
      isOn={(value) => value === field.value}
      onactivate={field.set}
    />
  </div>
{:else}
  <label class="pui-field">
    {#if label}<span class="pui-label">{label}</span>{/if}
    <select
      class="pui-input"
      {...guard}
      autocomplete="off"
      aria-label={label ? null : name || null}
      value={field.value}
      onchange={(e) => field.set(e.currentTarget.value)}
    >
      {#each options as option (option.value)}
        <option value={option.value}>{option.label}</option>
      {/each}
    </select>
  </label>
{/if}
