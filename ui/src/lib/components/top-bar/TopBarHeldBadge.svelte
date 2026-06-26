<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import { formatResetIn } from "$lib/format";
  import type { Gauge } from "../usage-gauges";
  import { AGENT_PROVIDERS, type AgentProvider, type HeldTask } from "$lib/types";
  import { dialog } from "$lib/a11yDialog";
  import { portal } from "$lib/portal";

  const fallbackProvider: AgentProvider = "claude";

  let spawnProviders = $state<Record<string, AgentProvider>>({});

  function providerFor(task: HeldTask): AgentProvider {
    return task.input.agentProvider ?? fallbackProvider;
  }

  function selectedProvider(task: HeldTask): AgentProvider {
    return spawnProviders[task.id] ?? providerFor(task);
  }

  function setSpawnProvider(id: string, value: string) {
    spawnProviders[id] = value === "codex" ? "codex" : "claude";
  }

  function providerLabel(provider: AgentProvider): string {
    return provider === "claude" ? m.agent_provider_claude() : m.agent_provider_codex();
  }

  let {
    heldCount,
    mobile,
    compactBadges,
    hotter,
    nowMs,
    heldPopFlipUp,
    heldItems,
    heldLoading,
    heldErrors = {},
    heldPending = {},
    heldAutoRelease,
    heldAutoReleaseBusy,
    toggleHeldAutoRelease,
    heldPopOpen = $bindable(),
    heldBadgeBtn = $bindable(null),
    heldPopEl = $bindable(null),
    toggleHeldPop,
    closeHeldPop,
    doSpawnHeld,
    doDiscardHeld,
  }: {
    heldCount: number;
    mobile: boolean;
    compactBadges: boolean;
    hotter: Gauge | null;
    nowMs: number;
    heldPopFlipUp: boolean;
    heldItems: HeldTask[];
    heldLoading: boolean;
    heldErrors?: Record<string, "spawn" | "discard">;
    heldPending?: Record<string, "spawn" | "discard">;
    heldAutoRelease: boolean;
    heldAutoReleaseBusy: boolean;
    toggleHeldAutoRelease: () => void;
    heldPopOpen: boolean;
    heldBadgeBtn: HTMLButtonElement | null;
    heldPopEl: HTMLDivElement | null;
    toggleHeldPop: () => void;
    closeHeldPop: (returnFocus?: boolean) => void;
    doSpawnHeld: (id: string, agentProvider?: AgentProvider) => void;
    doDiscardHeld: (id: string) => void;
  } = $props();
</script>

{#snippet heldWhy()}
  <p class="held-pop-why">
    {#if heldAutoRelease}
      {m.topbar_held_why()}{#if hotter?.w.resetAt}
        {m.topbar_held_why_at({ time: formatResetIn(hotter.w.resetAt, nowMs) })}{/if}
    {:else}
      {m.topbar_held_why_manual()}
    {/if}
  </p>
  <label class="held-autostart">
    <input
      type="checkbox"
      checked={heldAutoRelease}
      disabled={heldAutoReleaseBusy}
      onchange={toggleHeldAutoRelease}
    />
    <span>{m.topbar_held_autostart_label()}</span>
  </label>
{/snippet}

{#snippet heldRows()}
  {#if heldLoading}
    <div class="held-pop-empty">{m.common_loading()}</div>
  {:else if heldItems.length === 0}
    <div class="held-pop-empty">{m.topbar_held_empty()}</div>
  {:else}
    {#each heldItems as task (task.id)}
      {@const originalProvider = providerFor(task)}
      {@const spawnProvider = selectedProvider(task)}
      {@const pending = heldPending[task.id]}
      <div class="held-row">
        <div class="held-row-info">
          <span class="held-row-prompt">{task.input.prompt}</span>
          <span class="held-row-repo">{task.repoPath.split("/").at(-1) ?? task.repoPath}</span>
          <span class="held-row-cli">
            {m.topbar_held_original_cli({ cli: providerLabel(originalProvider) })}
          </span>
        </div>
        <div class="held-row-actions">
          <label class="held-cli">
            <span>{m.topbar_held_spawn_cli_label()}</span>
            <select
              value={spawnProvider}
              disabled={!!pending}
              onchange={(e) => setSpawnProvider(task.id, e.currentTarget.value)}
            >
              {#each AGENT_PROVIDERS as provider (provider)}
                <option value={provider}>{providerLabel(provider)}</option>
              {/each}
            </select>
          </label>
          <button
            type="button"
            class="held-action held-spawn"
            disabled={!!pending}
            aria-busy={pending === "spawn"}
            onclick={() => doSpawnHeld(task.id, spawnProvider)}
            >{pending === "spawn" ? m.topbar_held_spawning() : m.topbar_held_spawn_now()}</button
          >
          <button
            type="button"
            class="held-action held-discard"
            disabled={!!pending}
            aria-busy={pending === "discard"}
            onclick={() => doDiscardHeld(task.id)}
            >{pending === "discard" ? m.topbar_held_discarding() : m.topbar_held_discard()}</button
          >
          {#if heldErrors[task.id]}
            <p class="held-row-error" role="alert">
              {heldErrors[task.id] === "spawn"
                ? m.topbar_held_spawn_failed()
                : m.topbar_held_discard_failed()}
            </p>
          {/if}
        </div>
      </div>
    {/each}
  {/if}
{/snippet}

{#if (heldCount ?? 0) > 0}
  <!-- Held-tasks badge: non-modal anchored popover (design-system exemption). -->
  <div class="held-wrap">
    <button
      bind:this={heldBadgeBtn}
      class="held-badge"
      class:compact={mobile || compactBadges}
      class:mobile
      type="button"
      aria-haspopup="dialog"
      aria-expanded={heldPopOpen}
      aria-label={m.topbar_held_badge({ count: heldCount ?? 0 })}
      onclick={toggleHeldPop}
    >
      <svg
        class="held-glyph"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M5 2h14M5 22h14" />
        <path d="M7 2v4.2a2 2 0 0 0 .6 1.4L12 12l4.4-4.4a2 2 0 0 0 .6-1.4V2" />
        <path d="M17 22v-4.2a2 2 0 0 0-.6-1.4L12 12l-4.4 4.4a2 2 0 0 0-.6 1.4V22" />
      </svg>
      {#if mobile || compactBadges}
        <span class="held-n">{heldCount}</span>
      {:else}
        <span>{m.topbar_held_badge({ count: heldCount ?? 0 })}</span>
        {#if hotter?.w.resetAt}
          <span class="held-reset"
            >{m.topbar_held_resets({ time: formatResetIn(hotter.w.resetAt, nowMs) })}</span
          >
        {/if}
      {/if}
    </button>
    {#if heldPopOpen && mobile}
      <div class="held-dialog-portal" use:portal>
        <div class="held-scrim scrim" aria-hidden="true" onclick={() => closeHeldPop()}></div>
        <div
          bind:this={heldPopEl}
          class="held-pop held-fullscreen"
          role="dialog"
          aria-modal="true"
          aria-labelledby="held-dialog-title"
          tabindex="-1"
          use:dialog={{ onclose: () => closeHeldPop(true) }}
        >
          <div class="held-dialog-head">
            <span id="held-dialog-title" class="held-pop-head">{m.topbar_held_title()}</span>
            <button
              type="button"
              class="held-close icon-btn compact"
              onclick={() => closeHeldPop(true)}
              aria-label={m.common_close()}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M18 6 6 18" />
                <path d="M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div class="held-dialog-body">
            {@render heldWhy()}
            {@render heldRows()}
          </div>
        </div>
      </div>
    {:else if heldPopOpen}
      <div
        bind:this={heldPopEl}
        class={["held-pop", { "flip-up": heldPopFlipUp }]}
        role="dialog"
        aria-label={m.topbar_held_title()}
        tabindex="-1"
      >
        <div class="held-pop-head">{m.topbar_held_title()}</div>
        {@render heldWhy()}
        {@render heldRows()}
      </div>
    {/if}
  </div>
{/if}

<style>
  /* ── Held-tasks badge + popover ──────────────────────────────────────────── */
  .held-wrap {
    position: relative;
  }
  .held-badge {
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    /* shared bar control height; the hourglass glyph (#1122) centers instead of
       stretching the box, so it stays equal-height with its siblings */
    min-height: var(--topbar-ctl-h);
    line-height: 1;
    gap: 5px;
    background: transparent;
    border: 1px solid var(--color-amber);
    border-radius: 2px;
    color: var(--color-amber);
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.06em;
    padding: 0 8px;
    cursor: pointer;
    white-space: nowrap;
  }
  .held-badge:hover {
    background: color-mix(in srgb, var(--color-amber) 10%, transparent);
  }
  /* Compact (mobile / measured-overflow) variant: a single-digit count in a
     square box. Mirror .needsyou.compact (TopBar.svelte) so the digit centers —
     base .held-badge only centers vertically, and its letter-spacing trails the
     lone glyph leftward. */
  .held-badge.compact {
    justify-content: center;
    min-width: 44px;
    letter-spacing: 0;
    /* horizontal-only: box height comes from the shared --topbar-ctl-h min-height on
       the base rule, so this matches .needsyou.compact without padding tuning */
    padding: 0 10px;
    /* pin the line box to 1×font-size so height is font-independent: `.needsyou`
       renders in the UA button font while this badge uses `font: inherit` (mono),
       and their `normal` line-heights differ by ~2px. `.needsyou.compact` carries
       the matching `line-height: 1`. */
    line-height: 1;
  }
  /* Width-gated 44px floor mirroring `.hud.mobile .needsyou` (TopBar.svelte): `mobile`
     is width-only (≤768px), so fine-pointer narrow viewports need this — the coarse-
     pointer floor below does not cover them. Keyed off `mobile`, NOT `.compact`, so it
     never fires in the desktop measured-overflow case where needsyou has no floor (~36px),
     which would otherwise make held the taller box. */
  .held-badge.mobile {
    min-height: 44px;
  }
  .held-badge .held-glyph {
    width: 1.15em;
    height: 1.15em;
    display: block;
    flex-shrink: 0;
  }
  .held-badge .held-n {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .held-badge .held-reset {
    color: color-mix(in srgb, var(--color-amber) 70%, transparent);
    font-size: var(--fs-micro);
  }
  /* Anchored popover — mirrors .auto-pop from AutomationPanel */
  .held-pop {
    position: absolute;
    top: 100%;
    right: 0;
    z-index: 20;
    margin-top: 4px;
    width: 390px;
    max-width: 90vw;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
    color: var(--color-ink);
    max-height: 85vh;
    overflow-y: auto;
  }
  .held-pop.flip-up {
    top: auto;
    bottom: 100%;
    margin-top: 0;
    margin-bottom: 4px;
  }
  .held-dialog-portal {
    position: fixed;
    inset: 0;
    z-index: 60;
  }
  .held-scrim {
    z-index: 0;
  }
  .held-fullscreen {
    position: fixed;
    inset: 0;
    z-index: 1;
    display: flex;
    flex-direction: column;
    width: auto;
    max-width: none;
    max-height: none;
    margin: 0;
    border: 0;
    border-radius: 0;
    background: var(--color-inset);
    box-shadow: none;
  }
  .held-dialog-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
    min-height: calc(var(--mobile-actionbar-hit) + env(safe-area-inset-top));
    padding: env(safe-area-inset-top) 10px 0 16px;
    background: var(--color-head);
    border-bottom: 1px solid var(--color-line);
  }
  .held-dialog-head .held-pop-head {
    padding: 0;
  }
  .held-close {
    color: var(--color-ink);
  }
  .held-dialog-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding-bottom: env(safe-area-inset-bottom);
    -webkit-overflow-scrolling: touch;
  }
  @media (pointer: coarse) {
    .held-pop:not(.held-fullscreen) {
      width: min(360px, 92vw);
    }
    .held-badge {
      min-height: 44px;
      min-width: 44px;
    }
  }
  .held-pop-head {
    font-size: var(--fs-meta);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-muted);
    padding: 12px 14px 4px;
  }
  .held-pop-why {
    margin: 0;
    font-size: var(--fs-meta);
    line-height: 1.45;
    color: var(--color-faint);
    padding: 0 14px 10px;
  }
  .held-autostart {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 14px 10px;
    font-size: var(--fs-meta);
    color: var(--color-ink);
    cursor: pointer;
  }
  .held-autostart input {
    accent-color: var(--color-amber);
    cursor: pointer;
  }
  .held-autostart input:disabled {
    cursor: progress;
  }
  .held-pop-empty {
    font-size: var(--fs-base);
    color: var(--color-faint);
    padding: 8px 14px 12px;
  }
  .held-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 14px;
    border-top: 1px solid var(--color-line);
  }
  .held-row-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }
  .held-row-prompt {
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 26ch;
  }
  .held-row-repo {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    letter-spacing: 0.04em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .held-row-cli {
    font-size: var(--fs-micro);
    color: var(--color-faint);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .held-row-actions {
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: 124px;
    flex-shrink: 0;
  }
  .held-cli {
    display: flex;
    flex-direction: column;
    gap: 2px;
    color: var(--color-faint);
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .held-cli select {
    width: 100%;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-ink-bright);
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.04em;
    padding: 3px 6px;
    text-transform: none;
    cursor: pointer;
  }
  .held-cli select:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .held-action {
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.06em;
    padding: 3px 10px;
    cursor: pointer;
    white-space: nowrap;
    color: var(--color-ink);
    width: 100%;
  }
  .held-action:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  /* In-flight: spawn runs server-side worktree + agent launch (seconds). Keep the row's
     controls inert and signal progress so the button never reads as dead mid-request. */
  .held-action:disabled,
  .held-cli select:disabled {
    cursor: progress;
    opacity: 0.6;
  }
  .held-row-error {
    margin: 0;
    color: var(--color-red);
    font-size: var(--fs-micro);
    line-height: 1.35;
  }
  .held-spawn {
    color: var(--color-amber);
    border-color: var(--color-amber);
  }
  .held-spawn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--color-amber) 10%, transparent);
  }
  .held-fullscreen .held-pop-why {
    padding: 12px 16px 14px;
    color: var(--color-muted);
    font-size: var(--fs-base);
  }
  .held-fullscreen .held-autostart {
    padding: 0 16px 16px;
    font-size: var(--fs-base);
  }
  .held-fullscreen .held-pop-empty {
    padding: 14px 16px;
  }
  .held-fullscreen .held-row {
    flex-direction: column;
    gap: 10px;
    padding: 14px 16px;
  }
  .held-fullscreen .held-row-info {
    gap: 4px;
  }
  .held-fullscreen .held-row-prompt {
    max-width: none;
    overflow: visible;
    text-overflow: clip;
    white-space: normal;
    line-height: 1.35;
    /* Match the select, which the iOS zoom-guard (app.css) floors to
       max(16px, var(--fs-lg)) on mobile — keep title/buttons on the same
       expression so the fullscreen popover reads as one size at every scale. */
    font-size: max(16px, var(--fs-lg));
  }
  /* Single full-width column: at enlarged iOS Dynamic Type (--ui-scale up to
     1.5 → 24px) a 16px label like the German "Jetzt starten" truncates inside a
     2-up grid at 320px; full-width buttons render every locale's labels in full. */
  .held-fullscreen .held-row-actions {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
  }
  .held-fullscreen .held-cli {
    gap: 4px;
  }
  .held-fullscreen .held-row-error {
    font-size: var(--fs-meta);
  }
  .held-fullscreen .held-cli select,
  .held-fullscreen .held-action {
    min-height: var(--mobile-actionbar-hit);
    padding: 0 12px;
  }
  .held-fullscreen .held-action {
    /* Same expression as the iOS-floored select (see .held-row-prompt above). */
    font-size: max(16px, var(--fs-lg));
    letter-spacing: 0.04em;
  }
  @media (max-width: 420px) {
    .held-pop:not(.held-fullscreen) .held-row {
      flex-direction: column;
    }
    .held-pop:not(.held-fullscreen) .held-row-actions {
      width: 100%;
    }
  }
</style>
