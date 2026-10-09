<script lang="ts">
  import {
    AGENT_PROVIDERS,
    type AgentProvider,
    type Issue,
    type Session,
    type Steer,
    type TaskRunDefaults,
    type TaskRunSeed,
  } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { repoConfig } from "#lib/reviews.svelte.js";
  import { providerModels } from "#lib/provider-models.js";
  import {
    providerEfforts,
    effortLabel,
    effortAvailableForProvider,
  } from "#lib/effort-guidance.js";
  import { modelOptionLabel } from "#lib/model-guidance.js";
  import {
    effortSettingFor,
    modelSettingFor,
    preselectModel,
    preselectEffort,
  } from "../new-task/run-config";
  import { ACTIVE_LABEL } from "../issues-panel";

  // "Aufgabe" section of a single issue's reading detail (#2617): shows the task state, the
  // CLI/model/effort the New Task dialog will start with, and the start + quick-steer actions.
  // `run` holds ONLY what the operator changed here — untouched fields stay unset so the
  // composer keeps its own default resolution (capacity routing, repo-override reseed).
  let {
    repoPath,
    issue,
    session = null,
    defaults = undefined,
    run = $bindable({}),
    issueActions,
    onstart,
    onquick = undefined,
    onopensession = undefined,
  }: {
    repoPath: string;
    issue: Issue;
    /** The live session working this issue, if any — it marks the task "in progress" right
     *  away, before the claim label reaches the cached issue list. */
    session?: Pick<Session, "id"> | null;
    defaults?: TaskRunDefaults;
    run?: TaskRunSeed;
    issueActions: Steer[];
    onstart: () => void;
    onquick?: (action: Steer) => void;
    onopensession?: (sessionId: string) => void;
  } = $props();

  // Repo overrides (default model/effort) load lazily — same as the New Task dialog.
  $effect(() => {
    void repoConfig.ensure(repoPath);
  });

  const claimed = $derived(session != null || (issue.labels ?? []).includes(ACTIVE_LABEL));

  const provider = $derived<AgentProvider>(
    run.agentProvider ?? defaults?.agentProvider ?? "claude",
  );
  const modelOptions = $derived(["default", ...providerModels(provider)]);
  const model = $derived.by(() => {
    const v =
      run.model ??
      preselectModel(
        modelSettingFor(
          provider,
          repoConfig.defaultModelFor(repoPath),
          defaults?.model,
          defaults?.codexModel,
        ),
        provider,
        defaults?.fableAvailable ?? true,
      );
    return modelOptions.includes(v) ? v : "default";
  });
  const effortOptions = $derived([
    "default",
    ...providerEfforts(provider, model === "default" ? null : model),
  ]);
  const effort = $derived.by(() => {
    const v =
      run.effort ??
      preselectEffort(
        effortSettingFor(provider, repoConfig.defaultEffortFor(repoPath), {
          effort: defaults?.effort,
          claudeEffort: defaults?.claudeEffort,
          codexEffort: defaults?.codexEffort,
        }),
      );
    return effortOptions.includes(v) ? v : "default";
  });

  function providerName(p: AgentProvider): string {
    return p === "claude" ? m.agent_provider_claude() : m.agent_provider_codex_alpha();
  }

  // A CLI switch re-derives model + effort from that CLI's defaults (a model picked for the
  // other CLI rarely exists on this one), so only the provider stays pinned.
  function onProvider(e: Event) {
    run = { agentProvider: (e.currentTarget as HTMLSelectElement).value as AgentProvider };
  }
  function onModel(e: Event) {
    const next = (e.currentTarget as HTMLSelectElement).value;
    const keepEffort =
      run.effort != null &&
      effortAvailableForProvider(provider, run.effort, next === "default" ? null : next);
    // Pin the CLI the operator is looking at: the model belongs to it, and an unpinned CLI
    // could be re-routed by the composer (capacity) to one where this model doesn't exist.
    run = { agentProvider: provider, model: next, effort: keepEffort ? run.effort : undefined };
  }
  function onEffort(e: Event) {
    run = { ...run, agentProvider: provider, effort: (e.currentTarget as HTMLSelectElement).value };
  }
</script>

<section class="task-box" aria-labelledby="task-box-title-{issue.number}">
  <div class="task-head">
    <h3 class="task-title" id="task-box-title-{issue.number}">{m.issuetask_title()}</h3>
    <span class="task-state" class:claimed
      >{claimed ? m.issuetask_state_claimed() : m.issuetask_state_not_started()}</span
    >
    {#if session && onopensession}
      {@const id = session.id}
      <button class="open-session gbtn" type="button" onclick={() => onopensession(id)}
        >{m.epic_run_open_session()}</button
      >
    {/if}
  </div>

  <div class="run-settings" role="group" aria-label={m.issuetask_settings_label()}>
    <label class="mini-field">
      <span class="micro">{m.epic_provider_label()}</span>
      <select value={provider} onchange={onProvider}>
        {#each AGENT_PROVIDERS as p (p)}
          <option value={p}>{providerName(p)}</option>
        {/each}
      </select>
    </label>
    <label class="mini-field">
      <span class="micro">{m.epic_model_label()}</span>
      <select value={model} onchange={onModel}>
        {#each modelOptions as opt (opt)}
          <option value={opt}
            >{opt === "default"
              ? m.newtask_model_default()
              : modelOptionLabel(provider, opt)}</option
          >
        {/each}
      </select>
    </label>
    <label class="mini-field">
      <span class="micro">{m.epic_effort_label()}</span>
      <select value={effort} onchange={onEffort}>
        {#each effortOptions as opt (opt)}
          <option value={opt}>{opt === "default" ? m.effort_default() : effortLabel(opt)}</option>
        {/each}
      </select>
    </label>
  </div>

  <div class="task-actions">
    <button class="task-btn gbtn primary" type="button" onclick={onstart}
      >{m.issuetask_start()}</button
    >
    {#if onquick}
      {#each issueActions as a (a.id)}
        <button
          class="quick-btn gbtn"
          type="button"
          onclick={() => onquick(a)}
          aria-label={m.issuespanel_action_aria({ label: a.label })}
          title={a.text}
          >{#if a.emoji}<span class="act-emoji" aria-hidden="true">{a.emoji}</span>{/if}<span
            >{a.label}</span
          ></button
        >
      {/each}
    {/if}
  </div>

  <p class="task-hint">{m.issuetask_no_epic_hint()}</p>
</section>

<style>
  /* Set-off "Aufgabe" panel: the .panel recipe (panel ground, hairline, 2px radius). */
  .task-box {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    background: var(--color-panel);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    font-family: var(--font-mono);
  }

  .task-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .task-title {
    margin: 0;
    color: var(--color-muted);
    font-size: var(--fs-micro);
    font-weight: normal;
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }

  .task-state {
    padding: 1px 5px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .task-state.claimed {
    border-color: var(--status-running);
    color: var(--status-running);
  }

  .run-settings,
  .task-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .mini-field {
    display: flex;
    align-items: baseline;
    gap: 4px;
  }

  .micro {
    flex: none;
    color: var(--color-faint);
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
  }

  select {
    min-height: 24px;
    min-width: 96px;
    max-width: 180px;
    padding: 2px 6px;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
  }

  select:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }

  /* Canonical .gbtn recipe (/design-system) — scoped copy, as in EpicPanel. */
  .gbtn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 8px;
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    cursor: pointer;
  }
  .gbtn:hover {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .gbtn.primary,
  .quick-btn {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }

  .task-hint {
    margin: 0;
    color: var(--color-faint);
    font-size: var(--fs-micro);
  }

  @media (max-width: 768px), (max-height: 600px) {
    .gbtn,
    select {
      min-height: 44px;
    }
    .gbtn {
      padding: 2px 14px;
    }
  }
</style>
