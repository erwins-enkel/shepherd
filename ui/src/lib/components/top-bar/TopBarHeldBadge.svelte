<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { formatResetIn } from "#lib/format.js";
  import type { Gauge } from "../usage-gauges";
  import { AGENT_PROVIDERS, type AgentProvider, type HeldTask } from "#lib/types.js";
  import { dialog } from "#lib/a11yDialog.js";
  import { portal } from "#lib/portal.js";

  const fallbackProvider: AgentProvider = "claude";

  let spawnProviders = $state<Record<string, AgentProvider>>({});
  let expandedPrompts = $state<Record<string, boolean>>({});
  let clippedPrompts = $state<Record<string, boolean>>({});

  function measurePrompt(node: HTMLElement, getTask: () => HeldTask) {
    $effect(() => {
      const task = getTask();
      // Remeasure edited text as well as resize; keep the disclosure while expanded.
      void task.input.prompt;
      if (expandedPrompts[task.id]) return;
      const measure = () => {
        clippedPrompts[task.id] = node.scrollHeight > node.clientHeight;
      };
      const observer = new ResizeObserver(measure);
      observer.observe(node);
      measure();
      return () => observer.disconnect();
    });
  }

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
    onEditHeld,
  }: {
    heldCount: number;
    mobile: boolean;
    compactBadges: boolean;
    hotter: Gauge | null;
    nowMs: number;
    heldPopFlipUp: boolean;
    heldItems: HeldTask[];
    heldLoading: boolean;
    heldErrors?: Record<string, { kind: "spawn" | "discard"; detail?: string }>;
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
    onEditHeld: (task: HeldTask) => void;
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

{#snippet heldPrompt(task: HeldTask)}
  {@const expanded = !!expandedPrompts[task.id]}
  {@const toggleLabel = expanded ? m.topbar_held_show_less() : m.topbar_held_show_full_prompt()}
  <span
    id={`held-prompt-${task.id}`}
    class="held-row-prompt"
    class:expanded
    use:measurePrompt={() => task}>{task.input.prompt}</span
  >
  <div class="held-row-meta">
    <span class="held-row-repo">{task.repoPath.split("/").at(-1) ?? task.repoPath}</span>
    {#if clippedPrompts[task.id]}
      <button
        type="button"
        class="held-prompt-toggle"
        aria-expanded={expanded}
        aria-controls={`held-prompt-${task.id}`}
        onclick={() => (expandedPrompts[task.id] = !expandedPrompts[task.id])}>{toggleLabel}</button
      >
    {/if}
  </div>
{/snippet}

{#snippet heldRows()}
  {#if heldLoading}
    <div class="held-pop-empty">{m.common_loading()}</div>
  {:else if heldItems.length === 0}
    <div class="held-pop-empty">{m.topbar_held_empty()}</div>
  {:else}
    {#each heldItems as task (task.id)}
      {@const spawnProvider = selectedProvider(task)}
      {@const pending = heldPending[task.id]}
      <div class="held-row">
        {@render heldPrompt(task)}
        <div class="held-row-actions">
          <div class="held-start">
            <button
              type="button"
              class="held-action held-spawn"
              disabled={!!pending}
              aria-busy={pending === "spawn"}
              onclick={() => doSpawnHeld(task.id, spawnProvider)}
            >
              <svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
                <path d="m3 1 8 5-8 5z" />
              </svg>
              <span
                >{pending === "spawn" ? m.topbar_held_spawning() : m.topbar_held_spawn_now()}</span
              >
            </button>
            <label class="held-cli">
              <span class="held-cli-value" aria-hidden="true">{providerLabel(spawnProvider)}</span>
              <svg
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                aria-hidden="true"
              >
                <path d="m2 4 4 4 4-4" />
              </svg>
              <select
                aria-label={m.topbar_held_spawn_cli_label()}
                value={spawnProvider}
                disabled={!!pending}
                onchange={(e) => setSpawnProvider(task.id, e.currentTarget.value)}
              >
                {#each AGENT_PROVIDERS as provider (provider)}
                  <option value={provider}>{providerLabel(provider)}</option>
                {/each}
              </select>
            </label>
          </div>
          <button
            type="button"
            class="held-action held-edit"
            disabled={!!pending}
            onclick={() => onEditHeld(task)}>{m.topbar_held_edit()}</button
          >
          <button
            type="button"
            class="held-action held-discard"
            disabled={!!pending}
            aria-busy={pending === "discard"}
            onclick={() => doDiscardHeld(task.id)}
            >{pending === "discard" ? m.topbar_held_discarding() : m.topbar_held_discard()}</button
          >
        </div>
        {#if heldErrors[task.id]}
          {@const err = heldErrors[task.id]}
          <p class="held-row-error" role="alert">
            {err.kind === "spawn" ? m.topbar_held_spawn_failed() : m.topbar_held_discard_failed()}
            {#if err.detail}
              <span class="held-row-error-detail">{err.detail}</span>
            {/if}
          </p>
        {/if}
      </div>
    {/each}
  {/if}
{/snippet}

{#if (heldCount ?? 0) > 0}
  <!-- Held-tasks badge: anchored popover that dims+blurs the app behind it via a
       blocking .scrim backdrop (desktop) / fullscreen dialog (mobile). -->
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
          <div class="held-header">
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
            {@render heldWhy()}
          </div>
          <div class="held-dialog-body">
            {@render heldRows()}
          </div>
        </div>
      </div>
    {:else if heldPopOpen}
      <!-- Blocking dim+blur backdrop behind the anchored popover (user request):
           sits one z-index below the popover so the rest of the app recedes while
           it stays crisp. Reuses the shared .scrim primitive. Because the scrim
           makes this popover blocking, the dialog is now an honest modal — same
           aria-modal + use:dialog focus-trap/Esc/restore as the mobile path. -->
      <div
        class="held-scrim-anchored scrim"
        aria-hidden="true"
        onclick={() => closeHeldPop()}
      ></div>
      <div
        bind:this={heldPopEl}
        class={["held-pop", { "flip-up": heldPopFlipUp }]}
        role="dialog"
        aria-modal="true"
        aria-label={m.topbar_held_title()}
        tabindex="-1"
        use:dialog={{ onclose: () => closeHeldPop(true) }}
      >
        <div class="held-header">
          <div class="held-headline">
            <span class="held-pop-head">{m.topbar_held_title()}</span>
            <span class="held-pop-count">{m.topbar_held_badge({ count: heldCount })}</span>
          </div>
          {@render heldWhy()}
        </div>
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
    border-radius: var(--radius-chip);
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
  /* Compact (mobile / measured-overflow) variant: a single-digit count centered in
     a square box — base .held-badge only centers vertically, and its letter-spacing
     trails the lone glyph leftward. */
  .held-badge.compact {
    justify-content: center;
    min-width: 44px;
    letter-spacing: 0;
    /* horizontal-only: box height comes from the shared --topbar-ctl-h min-height on
       the base rule, so no padding tuning is needed here */
    padding: 0 10px;
    /* pin the line box to 1×font-size so the box height is font-independent — this
       badge uses `font: inherit` (mono), whose `normal` line-height would otherwise
       drift the height by ~2px. */
    line-height: 1;
  }
  /* Width-gated 44px floor: `mobile` is width-only (≤768px), so fine-pointer narrow
     viewports need this — the coarse-pointer floor below does not cover them. Keyed off
     `mobile`, NOT `.compact`, so it never fires in the desktop measured-overflow case
     (where the compact badge keeps its natural ~36px height). */
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
    --held-amber-ink: var(--color-amber);
    position: absolute;
    top: 100%;
    right: 0;
    z-index: 20;
    margin-top: 4px;
    width: 560px;
    max-width: 92vw;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
    color: var(--color-ink);
    max-height: 85vh;
    overflow-y: auto;
  }
  /* Light-theme amber needs darker ink to clear AA on the head and inset surfaces. */
  :global([data-theme="light"]) .held-pop {
    --held-amber-ink: color-mix(in srgb, var(--color-amber) 80%, var(--color-ink));
  }
  .held-pop.flip-up {
    top: auto;
    bottom: 100%;
    margin-top: 0;
    margin-bottom: 4px;
  }
  /* Backdrop for the anchored desktop popover. .scrim (app.css) supplies the
     fixed inset:0, dim and blur (+ reduced-transparency handling); we only set
     the stacking so it lands just under the popover's z-index: 20. */
  .held-scrim-anchored {
    z-index: 19;
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
    /* Touch floor for the anchored popover's controls (wide coarse-pointer
       viewports get the anchored variant, not the mobile fullscreen one). */
    .held-pop:not(.held-fullscreen) .held-action,
    .held-pop:not(.held-fullscreen) .held-cli {
      min-height: 44px;
    }
    .held-badge {
      min-height: 44px;
      min-width: 44px;
    }
  }
  .held-header {
    flex-shrink: 0;
    background: var(--color-head);
    border-bottom: 1px solid var(--color-line);
  }
  .held-headline {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 14px 8px;
  }
  .held-pop-count {
    color: var(--held-amber-ink);
    font-size: var(--fs-meta);
  }
  .held-pop-head {
    font-size: var(--fs-meta);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .held-pop-why {
    margin: 0;
    font-size: var(--fs-meta);
    line-height: 1.45;
    color: var(--color-muted);
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
    accent-color: var(--held-amber-ink);
    cursor: pointer;
  }
  .held-autostart input:disabled {
    cursor: progress;
  }
  .held-pop-empty {
    font-size: var(--fs-base);
    color: var(--color-muted);
    padding: 8px 14px 12px;
  }
  .held-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 14px;
  }
  .held-row + .held-row {
    border-top: 1px solid var(--color-line);
  }
  .held-row-prompt {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    overflow: hidden;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
    font-size: var(--fs-base);
    line-height: 1.35;
    color: var(--color-ink-bright);
  }
  .held-row-prompt.expanded {
    display: block;
  }
  .held-row-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: var(--fs-meta);
  }
  .held-row-repo {
    min-width: 0;
    color: var(--color-muted);
    letter-spacing: 0.04em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .held-prompt-toggle {
    flex-shrink: 0;
    border: 0;
    padding: 0;
    background: transparent;
    color: var(--color-muted);
    font: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }
  .held-prompt-toggle:hover {
    color: var(--color-ink-bright);
  }
  .held-row-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: stretch;
    gap: 6px;
  }
  .held-start {
    display: flex;
    margin-right: auto;
  }
  .held-cli {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    flex: 0 0 auto;
    min-height: 34px;
    background: var(--color-inset);
    border: 1px solid var(--color-amber);
    border-left: 0;
    border-radius: 0 2px 2px 0;
    color: var(--held-amber-ink);
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.04em;
    padding: 4px 8px;
    cursor: pointer;
  }
  .held-cli-value {
    min-width: 0;
  }
  .held-cli svg {
    width: 0.65em;
    height: 0.65em;
    flex-shrink: 0;
  }
  /* Keep the native picker and keyboard semantics while its visible value can wrap. */
  .held-cli select {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    opacity: 0;
    cursor: pointer;
  }
  .held-cli:focus-within,
  .held-action:focus-visible,
  .held-prompt-toggle:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .held-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 34px;
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.06em;
    padding: 4px 10px;
    cursor: pointer;
    white-space: nowrap;
    color: var(--color-muted);
  }
  .held-action:hover:not(:disabled) {
    border-color: var(--held-amber-ink);
    color: var(--held-amber-ink);
  }
  /* In-flight: spawn runs server-side worktree + agent launch (seconds). Keep the row's
     controls inert and signal progress so the button never reads as dead mid-request. */
  .held-action:disabled,
  .held-cli select:disabled {
    cursor: progress;
  }
  .held-row-error {
    margin: 0;
    color: var(--color-red);
    font-size: var(--fs-micro);
    line-height: 1.35;
  }
  /* The server's verbatim cause (pass-through data, not app chrome → exempt from i18n).
     Muted + word-broken so a long technical message wraps inside the row. */
  .held-row-error-detail {
    display: block;
    margin-top: 2px;
    color: var(--color-muted);
    overflow-wrap: anywhere;
  }
  .held-spawn {
    gap: 6px;
    border-radius: 2px 0 0 2px;
    color: var(--held-amber-ink);
    border-color: var(--held-amber-ink);
  }
  .held-spawn svg {
    width: 0.85em;
    height: 0.85em;
    flex-shrink: 0;
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
    gap: 8px;
    padding: 14px 16px;
  }
  .held-fullscreen .held-row-prompt {
    -webkit-line-clamp: 4;
    line-clamp: 4;
    /* Match the iOS-floored select at every Dynamic Type scale. */
    font-size: max(16px, var(--fs-lg));
  }
  .held-fullscreen .held-start {
    flex: 1 1 100%;
    min-width: 0;
    margin-right: 0;
  }
  /* The joined start action gets its own row; secondary actions wrap separately
     when Dynamic Type needs more room instead of clipping their labels. */
  .held-fullscreen .held-edit,
  .held-fullscreen .held-discard {
    flex: 1 1 140px;
  }
  .held-fullscreen .held-row-error {
    font-size: var(--fs-meta);
  }
  .held-fullscreen .held-cli,
  .held-fullscreen .held-action {
    min-height: var(--mobile-actionbar-hit);
    padding: 6px 8px;
    font-size: max(16px, var(--fs-lg));
    letter-spacing: 0.04em;
  }
  .held-fullscreen .held-cli {
    flex: 1;
    min-width: 0;
    gap: 3px;
  }
  .held-fullscreen .held-spawn {
    gap: 3px;
    flex: 1;
    min-width: 0;
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .held-fullscreen .held-spawn svg {
    width: 0.6em;
    height: 0.6em;
  }
  .held-fullscreen .held-spawn span {
    min-width: 0;
  }
  .held-fullscreen .held-prompt-toggle {
    min-height: 44px;
  }
  @media (pointer: coarse) {
    .held-prompt-toggle {
      min-height: 44px;
    }
  }
  @media (max-width: 420px) {
    .held-pop:not(.held-fullscreen) .held-row-prompt {
      -webkit-line-clamp: 4;
      line-clamp: 4;
      font-size: max(16px, var(--fs-lg));
    }
    .held-pop:not(.held-fullscreen) .held-start {
      flex: 1 1 100%;
      min-width: 0;
      margin-right: 0;
    }
    .held-pop:not(.held-fullscreen) .held-edit,
    .held-pop:not(.held-fullscreen) .held-discard {
      flex: 1 1 140px;
    }
    .held-pop:not(.held-fullscreen) .held-cli,
    .held-pop:not(.held-fullscreen) .held-action {
      min-height: 44px;
      white-space: normal;
    }
    .held-pop:not(.held-fullscreen) .held-cli {
      flex: 1;
      min-width: 0;
      gap: 3px;
    }
    .held-pop:not(.held-fullscreen) .held-spawn {
      gap: 3px;
      flex: 1;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .held-pop:not(.held-fullscreen) .held-spawn span {
      min-width: 0;
    }
    .held-pop:not(.held-fullscreen) .held-prompt-toggle {
      min-height: 44px;
    }
  }
</style>
