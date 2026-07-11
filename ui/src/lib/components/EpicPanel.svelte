<script lang="ts">
  import { AGENT_PROVIDERS, type AgentProvider, type DrainStatus, type Epic } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { updateEpic, approveEpicNext, importEpic } from "$lib/api";
  import { chipFor, epicHoldLine, progress, stateLabel } from "./epic-panel";
  import { toasts } from "$lib/toasts.svelte";
  import EpicHandsOffIntro from "./EpicHandsOffIntro.svelte";
  import EpicDiagnosisModal from "./EpicDiagnosisModal.svelte";
  import { coachTarget } from "$lib/actions/coachTarget.svelte";
  import { providerModels, modelAvailableForProvider } from "$lib/provider-models";
  import { providerEfforts, effortLabel, effortAvailableForProvider } from "$lib/effort-guidance";
  import { modelOptionLabel } from "$lib/model-guidance";

  let {
    repoPath,
    parent,
    epic,
    drain = null,
  }: { repoPath: string; parent: number; epic: Epic; drain?: DrainStatus | null } = $props();

  const p = $derived(progress(epic.children));
  const running = $derived(epic.run.status === "running");
  const readyCount = $derived(epic.children.filter((c) => c.state === "ready").length);
  // Only surface the drain's hold reason when it belongs to THIS epic's run.
  const holdLine = $derived(
    epicHoldLine(drain?.epicParent === parent ? drain : null, running, epic.children),
  );
  const epicProvider = $derived(epic.run.agentProvider ?? null);
  const epicModel = $derived(epic.run.model ?? "default");
  const epicEffort = $derived(epic.run.effort ?? "default");

  let showDiag = $state(false);

  function updateFailed() {
    toasts.info(m.epic_update_failed(), {
      alert: true,
      key: "epic-update-fail",
    });
  }

  function providerName(provider: AgentProvider): string {
    return provider === "claude" ? m.agent_provider_claude() : m.agent_provider_codex_alpha();
  }

  function onProviderChange(e: Event) {
    const value = (e.currentTarget as HTMLSelectElement).value;
    if (value === "inherit") {
      updateEpic(repoPath, parent, { agentProvider: null }).catch(updateFailed);
      return;
    }
    const agentProvider = value as AgentProvider;
    const model = modelAvailableForProvider(agentProvider, epicModel, true) ? epic.run.model : null;
    const effort = effortAvailableForProvider(agentProvider, epicEffort) ? epic.run.effort : null;
    updateEpic(repoPath, parent, { agentProvider, model, effort }).catch(updateFailed);
  }

  function onModelChange(e: Event) {
    if (!epicProvider) return;
    const value = (e.currentTarget as HTMLSelectElement).value;
    updateEpic(repoPath, parent, { model: value === "default" ? null : value }).catch(updateFailed);
  }

  function onEffortChange(e: Event) {
    if (!epicProvider) return;
    const value = (e.currentTarget as HTMLSelectElement).value;
    updateEpic(repoPath, parent, { effort: value === "default" ? null : value }).catch(
      updateFailed,
    );
  }
</script>

<div class="epic" role="region" aria-label={epic.parentTitle}>
  <EpicHandsOffIntro {repoPath} {parent} {epic} />

  <div class="epic-head">
    <span class="badge">{m.epic_progress({ merged: p.merged, total: p.total })}</span>
    {#if epic.source === "markdown"}
      <button
        class="gbtn"
        type="button"
        onclick={() =>
          importEpic(repoPath, parent).catch(() =>
            toasts.info(m.epic_import_failed(), {
              alert: true,
              key: "epic-import-fail",
            }),
          )}
      >
        {m.epic_import()}
      </button>
    {/if}
    <button
      class="gbtn"
      type="button"
      use:coachTarget={"epic-diagnose"}
      title={m.epic_diag_open_title()}
      onclick={() => (showDiag = true)}
    >
      {m.epic_diag_open()}
    </button>
  </div>

  <ul class="epic-children">
    {#each epic.children as c (c.number)}
      {@const chip = chipFor(c.state)}
      <li class="epic-child">
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external forge URL -->
        <a class="num" href={c.url} target="_blank" rel="noopener noreferrer">#{c.number}</a>
        <span class="title">{c.title}</span>
        <span class="chip chip-{chip.tone}">{stateLabel(c.state)}</span>
        {#if c.state === "blocked" && c.blockedBy.length > 0}
          <span class="deps"
            >{m.epic_blocked_on({ deps: c.blockedBy.map((n) => `#${n}`).join(", ") })}</span
          >
        {/if}
      </li>
    {/each}
  </ul>

  {#if epic.warnings.length}
    <p class="warn">{m.epic_warnings({ count: epic.warnings.length })}</p>
  {/if}

  {#if epic.noDependencyEdges}
    <p class="warn">{m.epic_warn_no_deps({ count: readyCount })}</p>
  {/if}

  {#if holdLine}
    <p class="hold" class:alert={drain?.paused}>{holdLine}</p>
  {/if}

  <div class="epic-controls">
    {#if running}
      <button
        class="gbtn"
        type="button"
        title={m.epic_pause_title()}
        onclick={() =>
          updateEpic(repoPath, parent, { status: "paused" }).catch(() =>
            toasts.info(m.epic_update_failed(), {
              alert: true,
              key: "epic-update-fail",
            }),
          )}
      >
        {m.epic_pause()}
      </button>
    {:else}
      <button
        class="gbtn"
        type="button"
        title={m.epic_start_title()}
        onclick={() =>
          updateEpic(repoPath, parent, { status: "running" }).catch(() =>
            toasts.info(m.epic_update_failed(), {
              alert: true,
              key: "epic-update-fail",
            }),
          )}
      >
        {m.epic_start()}
      </button>
    {/if}

    <button
      class="gbtn"
      type="button"
      title={epic.run.mode === "auto" ? m.epic_mode_auto_title() : m.epic_mode_attended_title()}
      aria-label={epic.run.mode === "auto" ? m.epic_mode_auto_aria() : m.epic_mode_attended_aria()}
      onclick={() =>
        updateEpic(repoPath, parent, {
          mode: epic.run.mode === "auto" ? "attended" : "auto",
        }).catch(() =>
          toasts.info(m.epic_update_failed(), {
            alert: true,
            key: "epic-update-fail",
          }),
        )}
    >
      {epic.run.mode === "auto" ? m.epic_mode_auto() : m.epic_mode_attended()}
    </button>

    {#if epic.run.status === "running" || epic.run.status === "paused"}
      <button
        class="gbtn"
        type="button"
        onclick={() =>
          updateEpic(repoPath, parent, { status: "idle" }).catch(() =>
            toasts.info(m.epic_stop_failed(), {
              alert: true,
              key: "epic-stop-fail",
            }),
          )}
      >
        {m.epic_stop()}
      </button>
    {/if}

    {#if epic.run.mode === "attended" && running}
      <button
        class="gbtn primary"
        type="button"
        onclick={() =>
          approveEpicNext(repoPath, parent).catch(() =>
            toasts.info(m.epic_approve_failed(), {
              alert: true,
              key: "epic-approve-fail",
            }),
          )}
      >
        {m.epic_approve_next()}
      </button>
    {/if}

    <div class="run-settings" aria-label={m.epic_provider_settings_label()}>
      <label class="mini-field">
        <span class="micro">{m.epic_provider_label()}</span>
        <select value={epicProvider ?? "inherit"} onchange={onProviderChange}>
          <option value="inherit">{m.epic_provider_inherit()}</option>
          {#each AGENT_PROVIDERS as provider (provider)}
            <option value={provider}>{providerName(provider)}</option>
          {/each}
        </select>
      </label>

      {#if epicProvider}
        <label class="mini-field">
          <span class="micro">{m.epic_model_label()}</span>
          <select value={epicModel} onchange={onModelChange}>
            <option value="default">{m.newtask_model_default()}</option>
            {#each providerModels(epicProvider) as model (model)}
              <option value={model}>{modelOptionLabel(epicProvider, model)}</option>
            {/each}
          </select>
        </label>

        <label class="mini-field">
          <span class="micro">{m.epic_effort_label()}</span>
          <select value={epicEffort} onchange={onEffortChange}>
            <option value="default">{m.effort_default()}</option>
            {#each providerEfforts(epicProvider) as effort (effort)}
              <option value={effort}>{effortLabel(effort)}</option>
            {/each}
          </select>
        </label>
      {/if}
    </div>
  </div>
</div>

{#if showDiag}
  <EpicDiagnosisModal {repoPath} {parent} onclose={() => (showDiag = false)} />
{/if}

<style>
  /* ── layout ─────────────────────────────────────────────────────────────── */
  .epic {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px;
    background: var(--color-panel);
    border-top: 1px solid var(--color-line);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
  }

  .epic-head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  /* ── child list ─────────────────────────────────────────────────────────── */
  .epic-children {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 40vh;
    overflow-y: auto;
    overscroll-behavior: contain;
    touch-action: pan-y;
  }

  .epic-child {
    display: flex;
    align-items: baseline;
    gap: 6px;
    flex-wrap: wrap;
  }

  .num {
    color: var(--color-muted);
    font-size: var(--fs-micro);
    text-decoration: none;
    flex-shrink: 0;
  }

  .num:hover {
    color: var(--color-ink-bright);
    text-decoration: underline;
  }

  .title {
    flex: 1;
    min-width: 0;
    color: var(--color-ink);
    font-size: var(--fs-meta);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* ── state chips ─────────────────────────────────────────────────────────
     Token mapping (all per app.css — NO literals):
       done     = --status-done    (=--color-slate) : merged/finished-parked, per house rule
       ready    = --color-green                     : genuinely actionable-complete
       running  = --status-running (=--color-amber) : in-progress
       review   = --color-blue                      : in-review (no --status-review token exists)
       muted    = --color-muted                     : blocked (quiet/deprioritised)
  ──────────────────────────────────────────────────────────────────────── */
  .chip {
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 1px 5px;
    border-radius: 2px;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .chip-done {
    color: var(--status-done);
    background: color-mix(in oklab, var(--status-done) 12%, transparent);
  }

  .chip-ready {
    color: var(--color-green);
    background: color-mix(in oklab, var(--color-green) 12%, transparent);
  }

  .chip-running {
    color: var(--status-running);
    background: color-mix(in oklab, var(--status-running) 15%, transparent);
  }

  .chip-review {
    color: var(--color-blue);
    background: color-mix(in oklab, var(--color-blue) 12%, transparent);
  }

  .chip-muted {
    color: var(--color-muted);
    background: color-mix(in oklab, var(--color-muted) 10%, transparent);
  }

  /* ── blocker deps + warnings ─────────────────────────────────────────── */
  .deps {
    color: var(--color-faint);
    font-size: var(--fs-micro);
    flex-basis: 100%;
    padding-left: calc(var(--fs-meta) + 12px); /* indent under title */
  }

  .warn {
    margin: 0;
    color: var(--color-amber);
    font-size: var(--fs-micro);
  }

  /* Drain hold reason — muted by default; amber when the drain is genuinely paused
     (trouble / usage / credits). Token-only per the design system. */
  .hold {
    margin: 0;
    color: var(--color-muted);
    font-size: var(--fs-micro);
  }

  .hold.alert {
    color: var(--color-amber);
  }

  /* ── controls ────────────────────────────────────────────────────────── */
  .epic-controls {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    padding-top: 2px;
  }

  .run-settings {
    display: flex;
    align-items: end;
    gap: 6px;
    flex-wrap: wrap;
  }

  .mini-field {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 96px;
  }

  .micro {
    color: var(--color-faint);
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  select {
    min-height: 24px;
    max-width: 180px;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    padding: 2px 6px;
  }

  select:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }

  /* ── progress badge ──────────────────────────────────────────────────────
     Neutral pill for the "{merged}/{total} merged" head count — token-only,
     mirrors the .label-chip / .chip recipe used elsewhere. */
  .badge {
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-muted);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    padding: 1px 5px;
    white-space: nowrap;
    flex-shrink: 0;
  }

  /* ── buttons ─────────────────────────────────────────────────────────────
     Canonical .gbtn recipe from /design-system. Copied into this component's
     scoped style because Svelte scopes styles per-component and there is no
     global .gbtn in app.css — every sibling that uses .gbtn duplicates it here
     the same way. Without this the controls render as bare unstyled text. */
  .gbtn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 2px 8px;
    cursor: pointer;
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
  .gbtn.primary {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }

  @media (max-width: 768px) {
    .gbtn {
      min-height: 40px;
      padding: 2px 14px;
    }
  }
</style>
