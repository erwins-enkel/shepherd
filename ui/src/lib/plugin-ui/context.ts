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

/** The editable fields of ONE published view (issue #1961), keyed by each input node's `name`.
 *
 *  Input nodes never POST on their own — they write here, and an `action-button` with
 *  `submit: true` folds `snapshot()` into its request body. That keeps "POST a plugin-authored
 *  body to your own route" the single network primitive, so the namespace guard above applies
 *  unchanged: the fields ride along on a request that was already scoped to the plugin.
 *
 *  Scope is the whole view (one `publishUI` call), set by PluginUIRoot alongside the plugin id.
 *  Deliberately NOT a `$state` rune: nothing renders from this map — the button reads it once,
 *  at click time — so reactivity would buy nothing and only wrap plugin values in proxies. */
export interface PluginFormScope {
  /** Register or update one field's current value. */
  set(name: string, value: unknown): void;
  /** Drop a field — its node was destroyed, or the plugin re-published without it. Without
   *  this, a removed input would keep contributing a stale key to every later submit. */
  remove(name: string): void;
  /** Point-in-time COPY of every registered field. */
  snapshot(): Record<string, unknown>;
}

export const PLUGIN_FORM_CONTEXT = Symbol("plugin-ui:form-scope");
