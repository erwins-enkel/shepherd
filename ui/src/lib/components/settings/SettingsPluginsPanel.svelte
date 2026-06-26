<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import type { PluginInfo } from "$lib/types";

  let { plugins = [] }: { plugins?: PluginInfo[] } = $props();

  // Core-derived health → token + label. Design rule (mirrors DiagnoseRows): never
  // --color-green for healthy — ok is steady-state slate, not actionable-complete.
  const HEALTH: Record<PluginInfo["health"], { color: string; label: () => string }> = {
    ok: { color: "var(--status-done)", label: m.plugins_health_ok },
    "timed-out": { color: "var(--status-warn)", label: m.plugins_health_timed_out },
    errored: { color: "var(--color-red)", label: m.plugins_health_errored },
  };

  // Which rows are expanded to show the published status blob.
  let expanded = $state<Record<string, boolean>>({});

  function pretty(status: unknown): string {
    try {
      return JSON.stringify(status, null, 2);
    } catch {
      return String(status);
    }
  }
</script>

<div class="plugins">
  <p class="intro micro">{m.plugins_intro()}</p>
  {#each plugins as p (p.id)}
    {@const h = HEALTH[p.health]}
    <div class="row">
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
      {#if expanded[p.id]}
        {#if p.status !== null && p.status !== undefined}
          <pre class="status">{pretty(p.status)}</pre>
        {:else}
          <p class="empty micro">{m.plugins_no_status()}</p>
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
