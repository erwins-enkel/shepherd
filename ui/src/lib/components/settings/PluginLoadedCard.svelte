<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import type { PluginInfo, PluginUIView } from "$lib/types";
  import PluginUIRoot from "$lib/plugin-ui/PluginUIRoot.svelte";

  let {
    plugin,
    folder,
    busy = false,
    onuninstall,
    update = null,
    onupdate,
  }: {
    plugin: PluginInfo;
    /** Directory name for uninstall; null when the folder is unknown (no uninstall shown). */
    folder: string | null;
    busy?: boolean;
    onuninstall: (folder: string, name: string) => void;
    /** In-card update state (issue: surface "update available" where the user looks).
     *  `latest` non-null shows the badge + Update button; `outcome` persists a
     *  live/restart/error note after an apply — even once the badge is gone. */
    update?: {
      latest: string | null;
      applying: boolean;
      outcome:
        | { kind: "live" | "restart"; version: string }
        | { kind: "error"; msg: string; detail?: string }
        | null;
    } | null;
    onupdate?: () => void;
  } = $props();

  // Core-derived health → token + label. Design rule (mirrors DiagnoseRows): never
  // --color-green for healthy — ok is steady-state slate, not actionable-complete.
  const HEALTH: Record<PluginInfo["health"], { color: string; label: () => string }> = {
    ok: { color: "var(--status-done)", label: m.plugins_health_ok },
    "timed-out": { color: "var(--status-warn)", label: m.plugins_health_timed_out },
    errored: { color: "var(--color-red)", label: m.plugins_health_errored },
  };

  let expanded = $state(false);

  const health = $derived(HEALTH[plugin.health]);
  // The settings-panel view, only when it targets this slot.
  const view = $derived<PluginUIView | null>(
    plugin.ui && plugin.ui.slot === "settings-panel" ? plugin.ui : null,
  );

  function pretty(status: unknown): string {
    try {
      return JSON.stringify(status, null, 2);
    } catch {
      return String(status);
    }
  }
</script>

<div class="row" id={`plugin-card-${plugin.id}`}>
  <div class="head-line">
    <button
      type="button"
      class="head"
      aria-expanded={expanded}
      onclick={() => (expanded = !expanded)}
    >
      <span class="dot" style="background:{health.color}" aria-hidden="true"></span>
      <span class="name">{plugin.name}</span>
      <span class="ver micro">v{plugin.version}</span>
      <span class="health micro" style="color:{health.color}">{health.label()}</span>
    </button>
    {#if update?.latest}
      <span class="upd-badge micro">{m.pluginupdate_state_update({ latest: update.latest })}</span>
      <button
        type="button"
        class="gbtn upd"
        disabled={update.applying}
        onclick={() => onupdate?.()}
      >
        {update.applying ? m.pluginupdate_applying() : m.pluginupdate_apply()}
      </button>
    {/if}
    {#if folder}
      {@const f = folder}
      <button
        type="button"
        class="gbtn del"
        disabled={busy}
        onclick={() => onuninstall(f, plugin.name)}
      >
        {m.plugins_uninstall()}
      </button>
    {/if}
  </div>
  {#if update?.outcome}
    {@const o = update.outcome}
    {#if o.kind === "error"}
      <p class="upd-outcome error micro" role="alert">{o.msg}</p>
      {#if o.detail}
        <!-- server-authored diagnostic (verbatim) — makes the failure debuggable -->
        <p class="upd-detail micro">{o.detail}</p>
      {/if}
    {:else if o.kind === "restart"}
      <p class="upd-outcome micro">{m.pluginupdate_applied_restart({ version: o.version })}</p>
    {:else}
      <p class="upd-outcome live micro">{m.pluginupdate_applied_live({ version: o.version })}</p>
    {/if}
  {/if}
  {#if plugin.lastError}
    <p class="err micro" title={plugin.lastError}>{m.plugins_last_error()}: {plugin.lastError}</p>
  {/if}
  {#if view}
    {#if view.title}
      <p class="view-title">{view.title}</p>
    {/if}
    <div class="view-body">
      <PluginUIRoot pluginId={plugin.id} node={view.root} />
    </div>
  {/if}
  {#if expanded}
    {#if view}
      <p class="raw-label micro">{m.plugins_raw_json()}</p>
    {/if}
    {#if plugin.status != null}
      <pre class="status">{pretty(plugin.status)}</pre>
    {:else}
      <p class="empty micro">{m.plugins_no_status()}</p>
    {/if}
  {/if}
</div>

<style>
  .row {
    border: 1px solid var(--color-line);
    background: var(--color-inset);
    padding: 8px 10px;
    transition: outline 0.1s ease;
  }
  /* Brief highlight when a card is scrolled into focus via a gear-item action. */
  .row:global(.focus-flash) {
    outline: 2px solid var(--color-amber);
    outline-offset: 1px;
  }
  .head-line {
    display: flex;
    align-items: center;
    flex-wrap: wrap; /* badge + Update wrap under the head instead of crushing it */
    gap: 8px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 0;
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
    min-width: 0; /* allow the flex item to actually shrink into its ellipsis */
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ver {
    color: var(--color-muted);
  }
  .health {
    margin-left: auto;
  }
  .gbtn {
    border: 1px solid var(--color-line-bright);
    background: transparent;
    color: var(--color-ink);
    font: inherit;
    letter-spacing: 0.06em;
    cursor: pointer;
    white-space: nowrap;
    flex: none;
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
  .gbtn.del {
    font-size: var(--fs-micro);
    padding: 5px 9px;
  }
  /* Update is the card's primary action — amber accent (mirrors the updates modal). */
  .gbtn.upd {
    font-size: var(--fs-micro);
    padding: 5px 9px;
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .upd-badge {
    font-size: var(--fs-micro);
    padding: 2px 8px;
    border: 1px solid var(--color-amber);
    color: var(--color-amber);
    white-space: nowrap;
    flex: none;
  }
  .upd-outcome {
    margin: 6px 0 0;
    color: var(--color-amber);
  }
  .upd-outcome.live {
    color: var(--color-green, var(--color-blue));
  }
  .upd-outcome.error {
    color: var(--color-red);
    word-break: break-word;
  }
  .upd-detail {
    margin: 4px 0 0;
    color: var(--color-muted);
    font-family: var(--font-mono, monospace);
    word-break: break-word;
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
