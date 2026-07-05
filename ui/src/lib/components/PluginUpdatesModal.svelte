<script lang="ts">
  import type { PluginUpdatesStatus, PluginUpdateInfo } from "$lib/types";
  import { dialog } from "$lib/a11yDialog";
  import { m } from "$lib/paraglide/messages";
  import { applyPluginUpdate } from "$lib/api";

  let {
    status,
    onclose,
    onapplied,
  }: {
    // Nullable so the mount site (AppOverlays) needs no `&& store.pluginUpdates`
    // guard; the modal renders nothing until a snapshot has landed.
    status: PluginUpdatesStatus | null;
    onclose?: () => void;
    /** Push the recomputed snapshot up after an apply so the badge + loaded-plugins
     *  list refresh (the modal itself only owns per-row apply UI). */
    onapplied?: (status: PluginUpdatesStatus) => void;
  } = $props();

  const RESTART_CMD = "systemctl --user restart shepherd";

  // Sort so the plugins that need attention (update-available, then incompatible)
  // surface first.
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
  const updatable = $derived(plugins.filter((p) => p.state === "update-available"));

  // Per-id apply state. `applying` disables buttons mid-flight; `outcome` persists a
  // success/restart/error note that survives the list refresh — a just-updated plugin
  // drops to `up-to-date` and would otherwise lose its "restart to finish" hint.
  let applying = $state<Record<string, boolean>>({});
  type Outcome =
    { kind: "live" | "restart"; version: string } | { kind: "error"; msg: string; detail?: string };
  let outcome = $state<Record<string, Outcome>>({});
  let copied = $state(false);
  // True for the duration of an "Update all" serial run. Locks every per-row Update button
  // too, so a manual click can't race the bulk loop's snapshot and get re-applied under it.
  let bulk = $state(false);

  const anyApplying = $derived(Object.values(applying).some(Boolean));
  const anyRestart = $derived(Object.values(outcome).some((o) => o.kind === "restart"));

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

  /** Map a stable server error CODE to a message (never render the raw code). */
  function applyErr(code: string): string {
    switch (code) {
      case "symlinked_source":
        return m.pluginupdate_apply_err_symlinked();
      case "incompatible":
        return m.pluginupdate_apply_err_incompatible();
      case "no_source":
        return m.pluginupdate_apply_err_nosource();
      default:
        return m.pluginupdate_apply_err_generic();
    }
  }

  async function applyOne(p: PluginUpdateInfo) {
    if (applying[p.id]) return;
    // Never re-apply a plugin that already succeeded this session — the bulk loop iterates a
    // snapshot, so without this a plugin updated manually (or in an earlier bulk pass) would
    // be re-applied and its success overwritten by a false "already up to date" error.
    const prior = outcome[p.id];
    if (prior && prior.kind !== "error") return;
    applying = { ...applying, [p.id]: true };
    // Drop any prior (error) outcome for this id so a retry starts clean.
    const next = { ...outcome };
    delete next[p.id];
    outcome = next;
    try {
      const res = await applyPluginUpdate(p.id);
      if (res.ok) {
        outcome = {
          ...outcome,
          [p.id]: {
            kind: res.result.restartRequired ? "restart" : "live",
            version: res.result.updatedTo,
          },
        };
        onapplied?.(res.result.status);
      } else {
        outcome = {
          ...outcome,
          [p.id]: { kind: "error", msg: applyErr(res.error), detail: res.detail },
        };
      }
    } finally {
      applying = { ...applying, [p.id]: false };
    }
  }

  async function applyAll() {
    if (bulk) return;
    bulk = true;
    // Snapshot at click — a plugin updated this round simply isn't in the list next render.
    try {
      for (const p of [...updatable]) await applyOne(p);
    } finally {
      bulk = false;
    }
  }

  async function copyRestart() {
    try {
      await navigator.clipboard.writeText(RESTART_CMD);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      /* clipboard blocked — the command is visible to copy manually */
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

    {#if anyRestart}
      <div class="restart" role="status">
        <span class="restart-text">{m.plugins_restart_banner()}</span>
        <code class="cmd">{RESTART_CMD}</code>
        <button type="button" class="gbtn copy" onclick={copyRestart}>
          {copied ? m.plugins_copied() : m.plugins_copy()}
        </button>
      </div>
    {/if}

    {#if plugins.length === 0}
      <div class="empty">{m.pluginupdate_empty()}</div>
    {:else}
      {#if updatable.length > 1}
        <div class="pactions">
          <button type="button" class="gbtn upd" disabled={anyApplying || bulk} onclick={applyAll}>
            {m.pluginupdate_apply_all()}
          </button>
        </div>
      {/if}
      <ul class="plist">
        {#each plugins as p (p.id)}
          <li>
            <div class="row-head">
              <span class="pname">{p.name}</span>
              {#if p.state === "update-available"}
                <span class="pver"
                  >v{p.currentVersion} <span class="arrow" aria-hidden="true">→</span>
                  v{p.latestVersion}</span
                >
              {:else}
                <span class="pver">v{p.currentVersion}</span>
              {/if}
              <span class="badge {p.state}">{stateLabel(p)}</span>
              {#if p.state === "update-available"}
                <button
                  type="button"
                  class="gbtn upd"
                  disabled={applying[p.id] || bulk}
                  onclick={() => applyOne(p)}
                >
                  {applying[p.id] ? m.pluginupdate_applying() : m.pluginupdate_apply()}
                </button>
              {/if}
            </div>
            {#if outcome[p.id]}
              {@const o = outcome[p.id]}
              {#if o.kind === "error"}
                <div class="outcome error" role="alert">{o.msg}</div>
                {#if o.detail}
                  <!-- server-authored diagnostic (verbatim) — makes the failure debuggable -->
                  <div class="pdetail">{o.detail}</div>
                {/if}
              {:else if o.kind === "restart"}
                <div class="outcome">{m.pluginupdate_applied_restart({ version: o.version })}</div>
              {:else}
                <div class="outcome live">
                  {m.pluginupdate_applied_live({ version: o.version })}
                </div>
              {/if}
            {:else if p.detail}
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
  .pactions {
    display: flex;
    justify-content: flex-end;
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
  .arrow {
    color: var(--color-amber);
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
  /* Base gear button recipe (from /design-system). */
  .gbtn {
    border: 1px solid var(--color-line-bright);
    background: transparent;
    color: var(--color-ink);
    padding: 5px 10px;
    font: inherit;
    font-size: var(--fs-meta);
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
  /* Update is the row's primary action — amber accent. */
  .gbtn.upd {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .outcome {
    margin-top: 6px;
    font-size: var(--fs-meta);
    line-height: 1.5;
    color: var(--color-amber);
  }
  .outcome.live {
    color: var(--color-green, var(--color-blue));
  }
  .outcome.error {
    color: var(--color-red);
    word-break: break-word;
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
  /* Restart-owed banner (mirrors the Settings → Plugins manager). */
  .restart {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    border: 1px solid var(--color-amber);
    background: var(--wash-warn, var(--color-inset));
    padding: 8px 10px;
  }
  .restart-text {
    font-size: var(--fs-meta);
    color: var(--color-ink);
  }
  .cmd {
    font-family: var(--font-mono, monospace);
    font-size: var(--fs-micro);
    background: var(--color-panel);
    border: 1px solid var(--color-line);
    padding: 3px 6px;
    color: var(--color-ink);
  }
  .restart .copy {
    margin-left: auto;
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
    .gbtn {
      min-height: 36px;
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
