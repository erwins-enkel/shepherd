<script lang="ts">
  // `number` node (issue #1961): a numeric field contributing a named value to a
  // `submit: true` action-button's body. Posts a number, or `null` when empty or unparseable —
  // the plugin validates range in its own route handler, the host deliberately does not clamp.
  //
  // Deliberately `type="text"` + `inputmode="decimal"`, NOT `type="number"`. A controlled
  // numeric input round-trips its value through the DOM's own parsing, which reports a
  // half-typed "1." or "-" as the empty string — writing that back would delete the character
  // the operator just typed. Holding the raw TEXT locally and mapping to a number only on the
  // way to the form scope keeps typing intact while still submitting a real JSON number.
  import type { PluginUINode } from "$lib/types";
  import { noAutofill } from "./autofill";
  import { pluginField } from "./field.svelte";

  let { node }: { node: PluginUINode } = $props();

  const guard = noAutofill();

  const p = $derived(node.props ?? {});
  const name = $derived(typeof p.name === "string" ? p.name : "");
  const label = $derived(typeof p.label === "string" ? p.label : "");
  const placeholder = $derived(typeof p.placeholder === "string" ? p.placeholder : "");

  /** Raw text → the JSON value submitted. Empty or unparseable is `null`, never NaN. */
  function toNumber(text: string): number | null {
    const trimmed = text.trim();
    if (trimmed.length === 0) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }

  const field = pluginField<string>(
    () => name,
    () => (typeof p.value === "number" && Number.isFinite(p.value) ? String(p.value) : ""),
    toNumber,
  );
</script>

<label class="pui-field">
  {#if label}<span class="pui-label">{label}</span>{/if}
  <input
    class="pui-input"
    {...guard}
    type="text"
    inputmode="decimal"
    autocomplete="off"
    {placeholder}
    aria-label={label ? null : name || null}
    value={field.value}
    oninput={(e) => field.set(e.currentTarget.value)}
  />
</label>
