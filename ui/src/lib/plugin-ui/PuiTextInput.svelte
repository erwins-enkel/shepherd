<script lang="ts">
  // `text-input` node (issue #1961): a free-text field that contributes a named value to the
  // body of a `submit: true` action-button — it never POSTs on its own. `label`/`placeholder`
  // are verbatim plugin DATA (never i18n), like every other plugin-authored string.
  //
  // `secret` renders a masked control so an operator can paste a token without it sitting on
  // screen. That is MASKING ONLY: the value still travels as plaintext JSON to the plugin's
  // own route, exactly like every other field.
  //
  // `secret` also says `autocomplete="new-password"` rather than `off` (issue #1978). Chromium
  // ignores `off` on a password field by policy, and the fill this guards against is not on
  // THIS control — it is the plain text-input beside it. Chrome does not fill a lone text box
  // with a username; it fills one because a password box next to it made the pair look like a
  // sign-in form. `new-password` denies that reading, so the neighbour stops being a username
  // slot. See `autofill.ts` for the rest of the guard.
  import type { PluginUINode } from "$lib/types";
  import { noAutofill } from "./autofill";
  import { pluginField } from "./field.svelte";

  let { node }: { node: PluginUINode } = $props();

  const guard = noAutofill();

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
  {#if label}<span class="pui-label">{label}</span>{/if}
  <input
    class="pui-input"
    {...guard}
    type={secret ? "password" : "text"}
    autocomplete={secret ? "new-password" : "off"}
    {placeholder}
    aria-label={label ? null : name || null}
    value={field.value}
    oninput={(e) => field.set(e.currentTarget.value)}
  />
</label>
