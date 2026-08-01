<script lang="ts">
  // `checkbox` node (issue #1961): a boolean toggle contributing a named value to a
  // `submit: true` action-button's body. `label` is verbatim plugin DATA (never i18n).
  //
  // Carries the autofill guard's `name` + vendor opt-outs but NO `autocomplete` (issue #1978):
  // the attribute does not apply to `type="checkbox"`, and a manager that toggles a
  // "remember me" box is answering to the opt-outs, not to `autocomplete`.
  import type { PluginUINode } from "$lib/types";
  import { noAutofill } from "./autofill";
  import { pluginField } from "./field.svelte";

  let { node }: { node: PluginUINode } = $props();

  const guard = noAutofill();

  const p = $derived(node.props ?? {});
  const name = $derived(typeof p.name === "string" ? p.name : "");
  const label = $derived(typeof p.label === "string" ? p.label : "");

  const field = pluginField<boolean>(
    () => name,
    () => p.value === true,
  );
</script>

<label class="pui-check">
  <input
    class="pui-box"
    {...guard}
    type="checkbox"
    aria-label={label ? null : name || null}
    checked={field.value}
    onchange={(e) => field.set(e.currentTarget.checked)}
  />
  {#if label}<span class="lbl">{label}</span>{/if}
</label>

<style>
  .pui-check {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    cursor: pointer;
  }
  .lbl {
    font-size: var(--fs-base);
    color: var(--color-ink);
    min-width: 0;
  }
  /* Form-field recipe surfaces (see /design-system), sized down to a control box. */
  .pui-box {
    accent-color: var(--color-amber);
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    width: 14px;
    height: 14px;
    flex: none;
    cursor: pointer;
  }
  .pui-box:focus-visible {
    outline: none;
    box-shadow: 0 0 0 1px var(--color-amber);
  }
</style>
