<script lang="ts">
  // Interactive `action-button` node (issue #1209): a clickable control that POSTs a
  // plugin-authored JSON body to one of THIS plugin's own routes. The owning plugin id comes
  // from context (PluginUIRoot), never from node props — that is what scopes the request to
  // the plugin's own namespace. `label`/`confirm` are verbatim plugin DATA (never i18n).
  import { getContext } from "svelte";
  import type { PluginUINode } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { invokePluginRoute } from "$lib/api";
  import { toasts } from "$lib/toasts.svelte";
  import { dialog } from "$lib/a11yDialog";
  import { toneColor } from "./tones";
  import { PLUGIN_ID_CONTEXT } from "./context";

  let { node }: { node: PluginUINode } = $props();

  // Context-absent (a bare PluginUIRenderer mount with no PluginUIRoot wrapper): with no
  // plugin id there is no well-formed route — render disabled and never fetch.
  const pluginId = getContext<string | undefined>(PLUGIN_ID_CONTEXT);

  const p = $derived(node.props ?? {});
  const label = $derived(String(p.label ?? ""));
  const accent = $derived(toneColor(p.tone));
  const confirmText = $derived(
    typeof p.confirm === "string" && p.confirm.trim().length > 0 ? p.confirm : null,
  );

  function isObj(x: unknown): x is Record<string, unknown> {
    return !!x && typeof x === "object" && !Array.isArray(x);
  }

  const route = $derived(isObj(p.route) ? p.route : null);
  const method = $derived(route?.["method"] === "POST" ? "POST" : null);
  const path = $derived(typeof route?.["path"] === "string" ? (route["path"] as string) : "");
  const body = $derived(p.body);

  // Client-side namespace guard, mirroring the server's validRoutePath (defense in depth):
  // non-empty, length-capped, safe charset, no leading "/", no ".." segment.
  function safePath(x: string): boolean {
    if (x.length === 0 || x.length > 256 || x.startsWith("/")) return false;
    if (!/^[A-Za-z0-9._/-]+$/.test(x)) return false;
    return !x.split("/").some((seg) => seg === "..");
  }

  // Actionable only with a plugin id (context present) AND a valid POST route.
  const ready = $derived(!!pluginId && method === "POST" && safePath(path));

  let pending = $state(false);
  let confirming = $state(false);

  function onclick() {
    if (!ready || pending) return;
    if (confirmText) {
      confirming = true;
      return;
    }
    void fire();
  }

  async function fire() {
    confirming = false;
    if (!ready || pending || !pluginId) return;
    pending = true;
    try {
      const text = await invokePluginRoute(pluginId, "POST", path, body);
      toasts.info(text.length > 0 ? text : m.plugin_action_done());
    } catch {
      toasts.info(m.plugin_action_failed(), {
        alert: true,
        key: `plugin-action:${pluginId}:${path}`,
      });
    } finally {
      pending = false;
    }
  }
</script>

<button
  type="button"
  class="gbtn pui-action"
  style:--accent={accent}
  disabled={!ready || pending}
  aria-busy={pending}
  {onclick}>{label}</button
>

{#if confirming && confirmText}
  <div
    class="overlay"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) confirming = false;
    }}
  >
    <div
      class="card"
      role="dialog"
      aria-modal="true"
      aria-label={m.plugin_action_confirm_title()}
      use:dialog={{ onclose: () => (confirming = false) }}
    >
      <p class="desc">{confirmText}</p>
      <div class="actions">
        <button type="button" class="gbtn" onclick={() => (confirming = false)}
          >{m.common_cancel()}</button
        >
        <button type="button" class="gbtn primary" style:--accent={accent} onclick={fire}
          >{label}</button
        >
      </div>
    </div>
  </div>
{/if}

<style>
  /* Canonical .gbtn recipe (see /design-system). Tone tints the resting border/text via
     --accent so the button reads with its semantic hue; hover/focus keep the amber affordance. */
  .gbtn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 2px 8px;
    cursor: pointer;
    transition:
      border-color 0.12s,
      color 0.12s;
  }
  .pui-action {
    color: var(--accent, var(--color-muted));
    border-color: var(--accent, var(--color-line));
  }
  .gbtn:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .gbtn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .gbtn.primary {
    border-color: var(--accent, var(--color-amber));
    color: var(--accent, var(--color-amber));
  }

  .overlay {
    position: fixed;
    inset: 0;
    background: var(--color-scrim);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 20;
  }
  .card {
    width: min(380px, 92vw);
    border: 1px solid var(--color-line-bright);
    background: var(--color-panel);
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .desc {
    margin: 0;
    color: var(--color-ink);
    font-size: var(--fs-base);
    line-height: 1.4;
    word-break: break-word;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
</style>
