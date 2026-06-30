<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import type { PluginInfo, PluginUIView } from "$lib/types";
  import PluginUIRoot from "$lib/plugin-ui/PluginUIRoot.svelte";

  let { plugins = [], focusId = null }: { plugins?: PluginInfo[]; focusId?: string | null } =
    $props();

  // Core-derived health → token + label. Design rule (mirrors DiagnoseRows): never
  // --color-green for healthy — ok is steady-state slate, not actionable-complete.
  const HEALTH: Record<PluginInfo["health"], { color: string; label: () => string }> = {
    ok: { color: "var(--status-done)", label: m.plugins_health_ok },
    "timed-out": { color: "var(--status-warn)", label: m.plugins_health_timed_out },
    errored: { color: "var(--color-red)", label: m.plugins_health_errored },
  };

  // Which rows are expanded to show the published status blob / raw-JSON debug dump.
  let expanded = $state<Record<string, boolean>>({});

  function pretty(status: unknown): string {
    try {
      return JSON.stringify(status, null, 2);
    } catch {
      return String(status);
    }
  }

  /** Returns the view only when it targets this panel's slot. */
  function panelView(p: PluginInfo): PluginUIView | null {
    return p.ui && p.ui.slot === "settings-panel" ? p.ui : null;
  }

  // When focusId changes (from a gear-item panel action), scroll the matching
  // card into view and briefly apply a highlight flash.
  $effect(() => {
    if (!focusId) return;
    const el = document.getElementById(`plugin-card-${focusId}`);
    if (!el) return;
    el.scrollIntoView({ block: "start" });
    el.classList.add("focus-flash");
    const t = setTimeout(() => el.classList.remove("focus-flash"), 1200);
    return () => clearTimeout(t);
  });
</script>

<div class="plugins">
  <p class="intro micro">{m.plugins_intro()}</p>
  {#each plugins as p (p.id)}
    {@const h = HEALTH[p.health]}
    {@const view = panelView(p)}
    <div class="row" id={`plugin-card-${p.id}`}>
      <button
        type="button"
        class="head"
        aria-expanded={!!expanded[p.id]}
        onclick={() => (expanded = { ...expanded, [p.id]: !expanded[p.id] })}
      >
        <span class="dot" style="background:{h.color}" aria-hidden="true"></span>
        <span class="name">{p.name}</span>
        <span class="ver micro">v{p.version}</span>
        <span class="health micro" style="color:{h.color}">{h.label()}</span>
      </button>
      {#if p.lastError}
        <p class="err micro" title={p.lastError}>{m.plugins_last_error()}: {p.lastError}</p>
      {/if}
      {#if view}
        {#if view.title}
          <p class="view-title">{view.title}</p>
        {/if}
        <div class="view-body">
          <PluginUIRoot pluginId={p.id} node={view.root} />
        </div>
        {#if expanded[p.id]}
          <p class="raw-label micro">{m.plugins_raw_json()}</p>
          {#if p.status != null}
            <pre class="status">{pretty(p.status)}</pre>
          {:else}
            <p class="empty micro">{m.plugins_no_status()}</p>
          {/if}
        {/if}
      {:else}
        {#if expanded[p.id]}
          {#if p.status !== null && p.status !== undefined}
            <pre class="status">{pretty(p.status)}</pre>
          {:else}
            <p class="empty micro">{m.plugins_no_status()}</p>
          {/if}
        {/if}
      {/if}
    </div>
  {/each}
</div>

<style>
  .plugins {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .intro {
    color: var(--color-muted);
    margin: 0 0 4px;
  }
  .row {
    border: 1px solid var(--color-line);
    background: var(--color-inset);
    padding: 8px 10px;
    transition: outline 0.1s ease;
  }
  /* Brief highlight when a plugin card is scrolled into focus via gear-item action.
     Uses an outline (not background change) so layout and border are undisturbed.
     :global() because the class is added imperatively via classList.add. */
  .row:global(.focus-flash) {
    outline: 2px solid var(--color-amber);
    outline-offset: 1px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    color: var(--color-ink);
    text-align: left;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: none;
  }
  .name {
    font-size: var(--fs-base);
    font-weight: 600;
  }
  .ver {
    color: var(--color-muted);
  }
  .health {
    margin-left: auto;
  }
  .err {
    color: var(--color-red);
    margin: 6px 0 0;
    word-break: break-word;
  }
  .empty {
    color: var(--color-muted);
    margin: 6px 0 0;
  }
  .view-title {
    font-size: var(--fs-micro);
    font-weight: 600;
    color: var(--color-muted);
    margin: 8px 0 4px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .view-body {
    margin: 6px 0 0;
  }
  .raw-label {
    color: var(--color-muted);
    margin: 8px 0 2px;
  }
  .status {
    margin: 6px 0 0;
    padding: 6px 8px;
    background: var(--color-panel);
    border: 1px solid var(--color-line);
    font-size: var(--fs-micro);
    color: var(--color-muted);
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
