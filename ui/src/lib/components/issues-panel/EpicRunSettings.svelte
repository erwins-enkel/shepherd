<script lang="ts">
  import {
    AGENT_PROVIDERS,
    type AgentProvider,
    type Epic,
    type RepoSandboxSetting,
    type SandboxProfile,
  } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { updateEpic } from "#lib/api.js";
  import { toasts } from "#lib/toasts.svelte.js";
  import { pickerModels, modelAvailableForProvider } from "#lib/provider-models.js";
  import {
    providerEfforts,
    effortLabel,
    effortAvailableForProvider,
  } from "#lib/effort-guidance.js";
  import { modelOptionLabel } from "#lib/model-guidance.js";
  import { repoConfig } from "#lib/reviews.svelte.js";
  import { basename } from "#lib/basename.js";

  // Footer of the epic run area (#2620): the CLI / model / effort the epic's children spawn with.
  // Moved unchanged from EpicPanel's control bar, dependencies included (a provider change drops
  // a model/effort the new CLI doesn't offer). #3454: plus the repo's sandbox, marked as the repo's
  // setting; the CLI and the sandbox say "halts" while they keep the children from starting.
  let {
    repoPath,
    parent,
    epic,
    halts = { cli: false, sandbox: false },
  }: {
    repoPath: string;
    parent: number;
    epic: Epic;
    /** Which of these settings currently hold the run (EpicRunControl's halt causes). */
    halts?: { cli: boolean; sandbox: boolean };
  } = $props();

  const epicProvider = $derived(epic.run.agentProvider ?? null);
  const epicModel = $derived(epic.run.model ?? "default");
  const epicEffort = $derived(epic.run.effort ?? "default");

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
    const effort = effortAvailableForProvider(agentProvider, epicEffort, model)
      ? epic.run.effort
      : null;
    updateEpic(repoPath, parent, { agentProvider, model, effort }).catch(updateFailed);
  }

  function onModelChange(e: Event) {
    if (!epicProvider) return;
    const value = (e.currentTarget as HTMLSelectElement).value;
    const model = value === "default" ? null : value;
    const effort = effortAvailableForProvider(epicProvider, epicEffort, model)
      ? epic.run.effort
      : null;
    updateEpic(repoPath, parent, { model, effort }).catch(updateFailed);
  }

  const SANDBOX_NAMES: Record<SandboxProfile, () => string> = {
    trusted: m.sandbox_profile_trusted,
    standard: m.sandbox_profile_standard,
    autonomous: m.sandbox_profile_autonomous,
  };
  // The "inherit" option names what it resolves to, as in the repo's automation settings.
  const sandboxInheritLabel = $derived.by(() => {
    const d = repoConfig.sandboxDefaultFor(repoPath);
    return d
      ? m.sandbox_profile_inherit({ profile: SANDBOX_NAMES[d]() })
      : m.sandbox_profile_inherit_unresolved();
  });

  function onSandboxChange(e: Event) {
    const value = (e.currentTarget as HTMLSelectElement).value as RepoSandboxSetting;
    void repoConfig.setSandboxProfile(repoPath, value);
  }

  function onEffortChange(e: Event) {
    if (!epicProvider) return;
    const value = (e.currentTarget as HTMLSelectElement).value;
    updateEpic(repoPath, parent, { effort: value === "default" ? null : value }).catch(
      updateFailed,
    );
  }
</script>

<div class="run-settings" aria-label={m.epic_provider_settings_label()}>
  <label class="mini-field" class:halts={halts.cli} data-field="cli">
    <span class="micro">{m.epic_provider_label()}</span>
    <select value={epicProvider ?? "inherit"} onchange={onProviderChange}>
      <option value="inherit">{m.epic_provider_inherit()}</option>
      {#each AGENT_PROVIDERS as provider (provider)}
        <option value={provider}>{providerName(provider)}</option>
      {/each}
    </select>
    {#if halts.cli}<span class="tag halt">{m.epic_setting_halts()}</span>{/if}
  </label>

  {#if epicProvider}
    <label class="mini-field">
      <span class="micro">{m.epic_model_label()}</span>
      <select value={epicModel} onchange={onModelChange}>
        <option value="default">{m.newtask_model_default()}</option>
        {#each pickerModels(epicProvider, epicModel) as model (model)}
          <option value={model}>{modelOptionLabel(epicProvider, model)}</option>
        {/each}
      </select>
    </label>

    <label class="mini-field">
      <span class="micro">{m.epic_effort_label()}</span>
      <select value={epicEffort} onchange={onEffortChange}>
        <option value="default">{m.effort_default()}</option>
        {#each providerEfforts(epicProvider, epicModel) as effort (effort)}
          <option value={effort}>{effortLabel(effort)}</option>
        {/each}
      </select>
    </label>
  {/if}

  <label class="mini-field" class:halts={halts.sandbox} data-field="sandbox">
    <span class="micro">{m.epic_sandbox_label()}</span>
    <select
      value={repoConfig.sandboxProfileFor(repoPath)}
      aria-label={m.epic_sandbox_aria({ repo: basename(repoPath) })}
      onchange={onSandboxChange}
    >
      <option value="inherit">{sandboxInheritLabel}</option>
      <option value="trusted">{m.sandbox_profile_trusted()}</option>
      <option value="standard">{m.sandbox_profile_standard()}</option>
      <option value="autonomous">{m.sandbox_profile_autonomous()}</option>
    </select>
    <span class="tag">{m.epic_sandbox_repo_tag()}</span>
    {#if halts.sandbox}<span class="tag halt">{m.epic_setting_halts()}</span>{/if}
  </label>
</div>

<style>
  .run-settings {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  /* Caption reads as an inline prefix on the control's own line — baseline, not
     centre, so it sits on the select's text rather than mid-box. */
  .mini-field {
    display: flex;
    flex-direction: row;
    align-items: baseline;
    gap: 4px;
  }

  .micro {
    flex: none;
    white-space: nowrap;
    color: var(--color-faint);
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  select {
    min-height: 24px;
    min-width: 96px;
    max-width: 180px;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    padding: 2px 6px;
  }

  /* A setting that holds the run: red frame and a "halts" tag beside it. */
  .halts select {
    border-color: color-mix(in srgb, var(--color-red) 55%, var(--color-line));
  }
  .tag {
    flex: none;
    padding: 0 4px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    white-space: nowrap;
  }
  .tag.halt {
    border-color: color-mix(in srgb, var(--color-red) 45%, var(--color-line));
    color: var(--color-red);
  }

  select:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }

  /* Mirrors the global mobile control branch in app.css (phone landscape is short-wide). */
  @media (max-width: 768px), (max-height: 600px) {
    select {
      min-height: 44px;
    }
  }
</style>
