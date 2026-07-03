<script lang="ts">
  import type { PluginUpdatesStatus, PluginUpdateInfo } from "$lib/types";
  import { dialog } from "$lib/a11yDialog";
  import { m } from "$lib/paraglide/messages";

  let {
    status,
    onclose,
  }: {
    // Nullable so the mount site (AppOverlays) needs no `&& store.pluginUpdates`
    // guard; the modal renders nothing until a snapshot has landed.
    status: PluginUpdatesStatus | null;
    onclose?: () => void;
  } = $props();

  // Informational only — this modal never applies an update. Sort so the plugins
  // that need attention (update-available, then incompatible) surface first.
  const ORDER: Record<PluginUpdateInfo["state"], number> = {
    "update-available": 0,
    incompatible: 1,
    error: 2,
    "no-source": 3,
    "up-to-date": 4,
  };
  const plugins = $derived(
    [...(status?.plugins ?? [])].sort((a, b) => ORDER[a.state] - ORDER[b.state]),
  );

  function stateLabel(p: PluginUpdateInfo): string {
    switch (p.state) {
      case "update-available":
        return m.pluginupdate_state_update({ latest: p.latestVersion ?? "?" });
      case "incompatible":
        return m.pluginupdate_state_incompatible({ latest: p.latestVersion ?? "?" });
      case "no-source":
        return m.pluginupdate_state_nosource();
      case "error":
        return m.pluginupdate_state_error();
      default:
        return m.pluginupdate_state_uptodate();
    }
  }
</script>

<div
  class="overlay"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose?.();
  }}
>
  <div
    class="card bracket"
    role="dialog"
    aria-modal="true"
    aria-label={m.pluginupdate_title()}
    use:dialog={{ onclose: () => onclose?.() }}
  >
    <div class="chead">
      <span class="micro">{m.pluginupdate_title()}</span>
      <button type="button" class="x" onclick={() => onclose?.()} aria-label={m.common_close()}
        >✕</button
      >
    </div>

    <div class="intro">{m.pluginupdate_intro()}</div>

    {#if plugins.length === 0}
      <div class="empty">{m.pluginupdate_empty()}</div>
    {:else}
      <ul class="plist">
        {#each plugins as p (p.id)}
          <li>
            <div class="row-head">
              <span class="pname">{p.name}</span>
              <span class="pver">v{p.currentVersion}</span>
              <span class="badge {p.state}">{stateLabel(p)}</span>
            </div>
            {#if p.detail}
              <!-- server-authored diagnostic (verbatim, like a plugin's lastError) -->
              <div class="pdetail">{p.detail}</div>
            {/if}
          </li>
        {/each}
      </ul>
      <div class="hint">{m.pluginupdate_manual_hint()}</div>
    {/if}

    <div class="actions">
      <button type="button" class="later" onclick={() => onclose?.()}>{m.common_close()}</button>
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: var(--color-scrim);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 30;
    padding: 16px;
  }
  .card {
    position: relative;
    box-sizing: border-box;
    width: min(520px, 100%);
    max-height: 80dvh;
    display: flex;
    flex-direction: column;
    gap: 14px;
    overflow-x: clip;
    overflow-y: auto;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    padding: 18px 18px 16px;
    box-shadow: inset 0 0 30px -16px var(--color-blue);
  }
  .bracket::before,
  .bracket::after {
    content: "";
    position: absolute;
    width: 9px;
    height: 9px;
    border: 1px solid var(--color-line-bright);
  }
  .bracket::before {
    top: 0;
    left: 0;
    border-right: 0;
    border-bottom: 0;
  }
  .bracket::after {
    bottom: 0;
    right: 0;
    border-left: 0;
    border-top: 0;
  }
  .chead {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .x {
    background: transparent;
    border: 0;
    color: var(--color-muted);
    cursor: pointer;
    font-size: var(--fs-base);
  }
  .intro {
    font-size: var(--fs-base);
    line-height: 1.5;
    color: var(--color-ink-bright);
  }
  .empty {
    color: var(--color-muted);
    font-size: var(--fs-base);
  }
  .plist {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .plist li {
    border: 1px solid var(--color-line);
    background: var(--color-inset);
    padding: 10px 12px;
  }
  .row-head {
    display: flex;
    align-items: baseline;
    gap: 9px;
    flex-wrap: wrap;
  }
  .pname {
    font-weight: 600;
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
  }
  .pver {
    color: var(--color-muted);
    font-size: var(--fs-meta);
    font-variant-numeric: tabular-nums;
  }
  .badge {
    margin-left: auto;
    font-size: var(--fs-meta);
    letter-spacing: 0.04em;
    padding: 2px 8px;
    border: 1px solid var(--color-line-bright);
    color: var(--color-muted);
    white-space: nowrap;
  }
  .badge.update-available {
    color: var(--color-amber);
    border-color: var(--color-amber);
  }
  .badge.incompatible,
  .badge.error {
    color: var(--color-red);
    border-color: var(--color-red);
  }
  .badge.up-to-date {
    color: var(--color-green, var(--color-blue));
    border-color: var(--color-green, var(--color-blue));
  }
  .pdetail {
    margin-top: 6px;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    font-family: monospace;
    word-break: break-word;
  }
  .hint {
    font-size: var(--fs-meta);
    line-height: 1.5;
    color: var(--color-muted);
    border-top: 1px solid var(--color-line);
    padding-top: 10px;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
  }
  .later {
    background: transparent;
    border: 1px solid var(--color-line-bright);
    color: var(--color-muted);
    padding: 8px 14px;
    cursor: pointer;
    letter-spacing: 0.06em;
  }
  .later:hover {
    color: var(--color-amber);
    border-color: var(--color-amber);
  }
  @media (max-width: 768px) {
    .overlay {
      align-items: stretch;
      justify-content: stretch;
      padding: 0;
    }
    .card {
      width: 100%;
      max-height: none;
      height: 100dvh;
      border: 0;
      padding: calc(16px + env(safe-area-inset-top)) 16px calc(14px + env(safe-area-inset-bottom));
      overflow-y: auto;
    }
    .bracket::before,
    .bracket::after {
      display: none;
    }
    .x {
      min-width: 44px;
      min-height: 44px;
      margin: -14px -14px -10px 0;
    }
    .later {
      min-height: 44px;
      flex: 1;
    }
    .actions {
      margin-top: auto;
    }
  }
</style>
