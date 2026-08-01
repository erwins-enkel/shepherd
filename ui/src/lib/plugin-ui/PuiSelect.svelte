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
  import type { PluginUINode } from "$lib/types";
  import { noAutofill } from "./autofill";
  import { pluginField } from "./field.svelte";

  let { node }: { node: PluginUINode } = $props();

  const guard = noAutofill();

  function isObj(x: unknown): x is Record<string, unknown> {
    return !!x && typeof x === "object" && !Array.isArray(x);
  }

  const p = $derived(node.props ?? {});
  const name = $derived(typeof p.name === "string" ? p.name : "");
  const label = $derived(typeof p.label === "string" ? p.label : "");
  const options = $derived(
    (Array.isArray(p.options) ? p.options : [])
      .filter((o): o is Record<string, unknown> => isObj(o) && typeof o.value === "string")
      .map((o) => ({
        value: o.value as string,
        label: typeof o.label === "string" ? o.label : (o.value as string),
      })),
  );

  const field = pluginField<string>(
    () => name,
    () => {
      const seeded = typeof p.value === "string" ? p.value : null;
      if (seeded !== null && options.some((o) => o.value === seeded)) return seeded;
      return options[0]?.value ?? "";
    },
  );
</script>

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
