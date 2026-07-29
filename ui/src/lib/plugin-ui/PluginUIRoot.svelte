<script lang="ts">
  // Root of a plugin's published UI view (issue #1209). Publishes the owning plugin id into
  // Svelte context so a nested `action-button` can POST to that plugin's own route namespace,
  // then renders the descriptor tree through the normal recursive renderer. A thin wrapper so
  // the plugin id flows to descendants without prop-drilling through every container node.
  import { setContext } from "svelte";
  import type { PluginUINode } from "$lib/types";
  import { PLUGIN_FORM_CONTEXT, PLUGIN_ID_CONTEXT, type PluginFormScope } from "./context";
  import PluginUIRenderer from "./PluginUIRenderer.svelte";

  let { pluginId, node }: { pluginId: string; node: PluginUINode } = $props();
  // Capture-once is correct: each plugin card is a keyed {#each} instance, so its pluginId
  // never changes for the life of this component — the context value is stable by construction.
  // svelte-ignore state_referenced_locally
  setContext(PLUGIN_ID_CONTEXT, pluginId);

  // One form scope per published view (issue #1961): input nodes register their named values
  // here, and a `submit: true` action-button folds them into its POST body. A plain object,
  // not $state — nothing renders from it, the button reads snapshot() once at click time.
  const fields: Record<string, unknown> = {};
  setContext<PluginFormScope>(PLUGIN_FORM_CONTEXT, {
    set: (name, value) => {
      fields[name] = value;
    },
    remove: (name) => {
      delete fields[name];
    },
    snapshot: () => ({ ...fields }),
  });
</script>

<PluginUIRenderer {node} />
