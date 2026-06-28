// Shared Svelte context for the plugin-UI renderer tree (issue #1209).
//
// The renderer chain (PluginUIRenderer → PuiStack → PluginUIRenderer → …) passes only the
// node, so a deeply-nested interactive node has no idea which plugin it belongs to. The
// `action-button` node needs the owning plugin id to POST to `/api/plugins/<id>/<path>` —
// and crucially, sourcing it from context (NOT from node props) is what scopes a button to
// its OWN plugin namespace: a plugin cannot target another plugin's routes.
//
// PluginUIRoot calls setContext(PLUGIN_ID_CONTEXT, id) once at the view root; descendants
// read it with getContext. A Symbol key avoids collision with any plugin-authored data.

export const PLUGIN_ID_CONTEXT = Symbol("plugin-ui:plugin-id");
