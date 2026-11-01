<script lang="ts">
  // `action-list` node: a filterable list whose row click POSTs `{ [param]: value }` to one of
  // THIS plugin's routes. One node however many rows, which is what lets a long list stay clear
  // of the host's node budget. Labels and meta are verbatim plugin DATA (never i18n). An empty
  // response stays silent: opening a row needs no toast, the republished panel is the feedback.
  import { getContext } from "svelte";
  import type { PluginUINode } from "#lib/types.js";
  import { invokePluginRoute } from "#lib/api.js";
  import { toasts } from "#lib/toasts.svelte.js";
  import { PLUGIN_ID_CONTEXT } from "./context";
  import PuiFilterList, { type FilterListRow } from "./PuiFilterList.svelte";
  import { routeFailureText } from "./route-failure";
  import { safePath } from "./safe-path";

  let { node }: { node: PluginUINode } = $props();

  // Absent on a bare mount: rows render but stay inert, as `action-button` does.
  const pluginId = getContext<string | undefined>(PLUGIN_ID_CONTEXT);

  const p = $derived(node.props ?? {});
  const label = $derived(typeof p.label === "string" ? p.label : "");
  const param = $derived(typeof p.param === "string" ? p.param : "");
  const path = $derived.by(() => {
    const route = p.route as { method?: unknown; path?: unknown } | undefined;
    return route?.method === "POST" && typeof route.path === "string" ? route.path : "";
  });
  const items = $derived(
    (Array.isArray(p.items) ? (p.items as Record<string, unknown>[]) : []).filter(
      (i) => typeof i?.value === "string",
    ),
  );
  const rows = $derived<FilterListRow[]>(
    items.map((i) => ({
      value: i.value as string,
      label: typeof i.label === "string" ? i.label : (i.value as string),
      meta: typeof i.meta === "string" ? i.meta : undefined,
    })),
  );
  const current = $derived(new Set(items.filter((i) => i.current === true).map((i) => i.value)));

  let pending = $state<string | null>(null);

  async function activate(value: string) {
    if (!pluginId || !param || !safePath(path) || pending !== null) return;
    pending = value;
    try {
      const text = await invokePluginRoute(pluginId, "POST", path, { [param]: value });
      if (text.length > 0) toasts.info(text);
    } catch (e) {
      toasts.info(routeFailureText(e), {
        alert: true,
        key: `plugin-action:${pluginId}:${path}`,
      });
    } finally {
      pending = null;
    }
  }
</script>

<div class="pui-field">
  {#if label}<span class="pui-label">{label}</span>{/if}
  <PuiFilterList
    {rows}
    label={label || param}
    mono={p.mono === true}
    isOn={(value) => current.has(value)}
    busyValue={pending}
    onactivate={activate}
  />
</div>
