<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { formatResetIn } from "#lib/format.js";
  import { updateEpic } from "#lib/api.js";
  import { toasts } from "#lib/toasts.svelte.js";
  import { basename } from "#lib/basename.js";
  import type { Gauge } from "../usage-gauges";
  import { pausedText } from "../queue-strip";
  import {
    AGENT_PROVIDERS,
    type AgentProvider,
    type DrainStatus,
    type HeldTask,
  } from "#lib/types.js";
  import HeldReasonLabel from "./HeldReasonLabel.svelte";

  // The usage panel's "waiting on capacity" column: everything the usage numbers beside it are
  // currently holding back — auto-drains paused at their ceiling and tasks held at creation —
  // so the cause and its effect read on one screen instead of two separate popovers.

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

  // The CLI picker names each provider's own usage, so choosing where a held task starts is
  // made with the numbers in view rather than from memory.
  function cliLabel(provider: AgentProvider): string {
    const pct = providerPct[provider];
    return pct === undefined
      ? providerLabel(provider)
      : m.capacity_cli_option({ provider: providerLabel(provider), pct });
  }

  // Lift the repo's usage ceiling for the epic its drain is running (same call as the repo chip).
  function ignoreCeiling(d: DrainStatus, epic: number) {
    updateEpic(d.repoPath, epic, { ignoreUsageCeiling: true }).catch(() =>
      toasts.info(m.epic_update_failed(), { alert: true, key: "epic-update-fail" }),
    );
  }

  let {
    // Consumed by the `class:sheet` directive on the root below; fallow's prop-usage analyzer
    // doesn't follow Svelte `class:` shorthand, so it false-positives here.
    // fallow-ignore-next-line unused-component-props
    sheet = false,
    holdPct,
    holdEnabled,
    drains,
    heldCount,
    hotter,
    nowMs,
    heldItems,
    heldLoading,
    heldErrors = {},
    heldPending = {},
    heldAutoRelease,
    heldAutoReleaseBusy,
    toggleHeldAutoRelease,
    providerPct = {},
    doSpawnHeld,
    doDiscardHeld,
    onEditHeld,
  }: {
    /** Full-screen phone layout: larger type and stacked action rows. */
    sheet?: boolean;
    /** The hold limit (`usageHoldPct`); null while unknown or when holding is off. */
    holdPct: number | null;
    /** Whether usage holding is on; null until settings load. */
    holdEnabled: boolean | null;
    /** Drains paused because usage reached their repo's ceiling. */
    drains: DrainStatus[];
    heldCount: number;
    hotter: Gauge | null;
    nowMs: number;
    heldItems: HeldTask[];
    heldLoading: boolean;
    heldErrors?: Record<string, { kind: "spawn" | "discard"; detail?: string }>;
    heldPending?: Record<string, "spawn" | "discard">;
    heldAutoRelease: boolean;
    heldAutoReleaseBusy: boolean;
    toggleHeldAutoRelease: () => void;
    /** Each provider's hottest window (%), shown in the start-with picker. */
    providerPct?: Partial<Record<AgentProvider, number>>;
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
    <HeldReasonLabel {task} />
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
  {#if heldLoading && heldItems.length === 0}
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
              <span class="held-cli-value" aria-hidden="true">{cliLabel(spawnProvider)}</span>
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
                  <option value={provider}>{cliLabel(provider)}</option>
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

<div class="wait" class:sheet>
  <div class="wait-rule">
    <span class="wait-name">{m.capacity_wait_title()}</span>
    <span class="rule-line"></span>
    {#if holdPct !== null}<span class="wait-note">{m.capacity_limit({ pct: holdPct })}</span>{/if}
  </div>

  {#if drains.length > 0}
    <section class="wait-block">
      <h3 class="wait-head">{m.capacity_drain_title()}</h3>
      {#each drains as d (d.repoPath)}
        <div class="drain-row">
          <span class="drain-repo">{basename(d.repoPath)}</span>
          <span class="drain-pause">{pausedText(d)}</span>
          {#if d.epicParent != null}
            {@const epic = d.epicParent}
            <button type="button" class="drain-ignore" onclick={() => ignoreCeiling(d, epic)}>
              {m.drain_usage_ignore({ epic })}
            </button>
          {/if}
        </div>
      {/each}
    </section>
  {/if}

  {#if heldCount > 0}
    <section class="wait-block">
      <h3 class="wait-head">{m.capacity_held_title({ count: heldCount })}</h3>
      {@render heldWhy()}
      {@render heldRows()}
    </section>
  {:else if drains.length === 0}
    <div class="wait-empty">
      <p class="wait-empty-head">{m.capacity_nothing_waiting()}</p>
      {#if holdPct !== null}
        <p class="wait-empty-body">{m.capacity_nothing_waiting_body({ pct: holdPct })}</p>
      {:else if holdEnabled === false}
        <p class="wait-empty-body">{m.capacity_hold_off()}</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .wait {
    --held-amber-ink: var(--color-amber);
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  /* Light-theme amber needs darker ink to clear AA on the panel surface. */
  :global([data-theme="light"]) .wait {
    --held-amber-ink: color-mix(in srgb, var(--color-amber) 80%, var(--color-ink));
  }
  .wait-rule {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 12px;
  }
  .wait-name {
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .rule-line {
    flex: 1;
    height: 1px;
    background: var(--color-line);
  }
  .wait-note {
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.04em;
    white-space: nowrap;
  }
  .wait-block + .wait-block {
    margin-top: 16px;
    padding-top: 14px;
    border-top: 1px solid var(--color-line);
  }
  .wait-head {
    margin: 0;
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
    font-weight: 600;
    line-height: 1.35;
  }
  .drain-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 12px;
    margin-top: 8px;
    font-size: var(--fs-meta);
  }
  .drain-repo {
    color: var(--color-ink);
    letter-spacing: 0.04em;
  }
  /* Same subordinate-red treatment as the repo chip's pause line: text + tint, no halo. */
  .drain-pause {
    padding: 3px 8px;
    border-radius: 2px;
    background: color-mix(in srgb, var(--color-red) 12%, transparent);
    color: var(--color-red);
    font-variant-numeric: tabular-nums;
  }
  .drain-ignore {
    padding: 2px 0;
    border: 0;
    background: none;
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    text-decoration: underline dotted;
    text-underline-offset: 4px;
    cursor: pointer;
  }
  .drain-ignore:hover,
  .drain-ignore:focus-visible {
    color: var(--color-ink-bright);
  }
  .wait-empty-head {
    margin: 0;
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
    font-weight: 600;
  }
  .wait-empty-body {
    margin: 6px 0 0;
    max-width: 46ch;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    line-height: 1.5;
  }
  .held-pop-why {
    margin: 6px 0 8px;
    font-size: var(--fs-meta);
    line-height: 1.45;
    color: var(--color-muted);
  }
  .held-autostart {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-bottom: 10px;
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
    padding: 8px 0 4px;
  }
  .held-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 0;
    border-top: 1px solid var(--color-line);
  }
  .held-row:last-child {
    padding-bottom: 0;
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
    font-variant-numeric: tabular-nums;
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
    box-shadow: inset 0 0 18px -10px var(--color-amber);
  }
  .held-spawn svg {
    width: 0.85em;
    height: 0.85em;
    flex-shrink: 0;
  }
  .held-spawn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--color-amber) 10%, transparent);
  }
  @media (pointer: coarse) {
    /* Touch floor for the anchored panel's controls (wide coarse-pointer viewports get the
       anchored panel, not the phone sheet). */
    .wait:not(.sheet) .held-action,
    .wait:not(.sheet) .held-cli,
    .held-prompt-toggle,
    .drain-ignore {
      min-height: 44px;
    }
  }
  .sheet .held-pop-why {
    color: var(--color-muted);
    font-size: var(--fs-base);
  }
  .sheet .held-autostart {
    min-height: 44px;
    padding-bottom: 6px;
    font-size: var(--fs-base);
  }
  .sheet .drain-ignore {
    min-height: 44px;
  }
  .sheet .held-row {
    gap: 8px;
    padding: 14px 0;
  }
  .sheet .held-row-prompt {
    -webkit-line-clamp: 4;
    line-clamp: 4;
    /* Match the iOS-floored select at every Dynamic Type scale. */
    font-size: max(16px, var(--fs-lg));
  }
  .sheet .held-start {
    flex: 1 1 100%;
    min-width: 0;
    margin-right: 0;
  }
  /* The joined start action gets its own row; secondary actions wrap separately
     when Dynamic Type needs more room instead of clipping their labels. */
  .sheet .held-edit,
  .sheet .held-discard {
    flex: 1 1 140px;
  }
  .sheet .held-row-error {
    font-size: var(--fs-meta);
  }
  .sheet .held-cli,
  .sheet .held-action {
    min-height: var(--mobile-actionbar-hit);
    padding: 6px 8px;
    font-size: max(16px, var(--fs-lg));
    letter-spacing: 0.04em;
  }
  .sheet .held-cli {
    flex: 1;
    min-width: 0;
    gap: 3px;
  }
  .sheet .held-spawn {
    gap: 3px;
    flex: 1;
    min-width: 0;
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .sheet .held-spawn svg {
    width: 0.6em;
    height: 0.6em;
  }
  .sheet .held-spawn span {
    min-width: 0;
  }
  .sheet .held-prompt-toggle {
    min-height: 44px;
  }
  @media (max-width: 420px) {
    .wait:not(.sheet) .held-row-prompt {
      -webkit-line-clamp: 4;
      line-clamp: 4;
      font-size: max(16px, var(--fs-lg));
    }
    .wait:not(.sheet) .held-start {
      flex: 1 1 100%;
      min-width: 0;
      margin-right: 0;
    }
    .wait:not(.sheet) .held-edit,
    .wait:not(.sheet) .held-discard {
      flex: 1 1 140px;
    }
    .wait:not(.sheet) .held-cli,
    .wait:not(.sheet) .held-action {
      min-height: 44px;
      white-space: normal;
    }
    .wait:not(.sheet) .held-cli {
      flex: 1;
      min-width: 0;
      gap: 3px;
    }
    .wait:not(.sheet) .held-spawn {
      gap: 3px;
      flex: 1;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .wait:not(.sheet) .held-spawn span {
      min-width: 0;
    }
    .wait:not(.sheet) .held-prompt-toggle {
      min-height: 44px;
    }
  }
</style>
