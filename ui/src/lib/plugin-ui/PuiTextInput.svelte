<script lang="ts">
  // `text-input` node (issue #1961): a free-text field that contributes a named value to the
  // body of a `submit: true` action-button — it never POSTs on its own. `label`/`placeholder`
  // are verbatim plugin DATA (never i18n), like every other plugin-authored string.
  //
  // `secret` renders a masked control so an operator can paste a token without it sitting on
  // screen. That is MASKING ONLY: the value still travels as plaintext JSON to the plugin's
  // own route, exactly like every other field.
  import type { PluginUINode } from "$lib/types";
  import { pluginField } from "./field.svelte";

  let { node }: { node: PluginUINode } = $props();

  const p = $derived(node.props ?? {});
  const name = $derived(typeof p.name === "string" ? p.name : "");
  const label = $derived(typeof p.label === "string" ? p.label : "");
  const placeholder = $derived(typeof p.placeholder === "string" ? p.placeholder : "");
  const secret = $derived(p.secret === true);

  const field = pluginField<string>(
    () => name,
    () => (typeof p.value === "string" ? p.value : ""),
  );
</script>

<label class="pui-field">
  {#if label}<span class="lbl">{label}</span>{/if}
  <input
    class="pui-input"
    type={secret ? "password" : "text"}
    autocomplete={secret ? "off" : null}
    {placeholder}
    aria-label={label ? null : name || null}
    value={field.value}
    oninput={(e) => field.set(e.currentTarget.value)}
  />
</label>

<style>
  /* Canonical form-field recipe (see /design-system → Form fields). */
  .pui-field {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }
  .lbl {
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .pui-input {
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    color: var(--color-ink-bright);
    font: inherit;
    font-size: var(--fs-base);
    padding: 8px 10px;
    border-radius: 2px;
    min-width: 0;
  }
  .pui-input:focus-visible {
    outline: none;
    border-color: var(--color-amber);
  }
</style>
