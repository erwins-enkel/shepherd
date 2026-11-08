<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { repoConfig } from "#lib/reviews.svelte.js";
  import { AGENT_PROVIDERS, EFFORTS } from "#lib/types.js";
  import type { AgentProvider, RepoAgentProviderSetting, Settings } from "#lib/types.js";
  import { modelGuidanceAlias, modelOptionLabel } from "#lib/model-guidance.js";
  import { configuredModelLabel } from "#lib/model-label.js";
  import { pickerModels } from "#lib/provider-models.js";
  import { effortLabel, providerEfforts } from "#lib/effort-guidance.js";
  import {
    effectiveRepoProvider,
    repoEffortFitsProvider,
    repoModelFitsProvider,
  } from "#lib/repo-cli.js";
  import { nextStart, type SettingOrigin } from "#lib/next-start.js";
  import ModelGuidance from "#lib/components/ModelGuidance.svelte";
  import RepoSettingRow from "./RepoSettingRow.svelte";
  import "../automation-settings/automation-fields.css";

  // The repo's coding CLI, default model, effort and plan-gate execution effort, each a repo-wide
  // override of the global default ("Inherit" defers to Settings → Session), plus the "Next start"
  // line naming what a new task starts with and where each part comes from.
  let {
    repoPath,
    fableAvailable,
    globals = null,
  }: {
    repoPath: string;
    fableAvailable: boolean;
    /** The global settings an "inherit" follows; null while they load (no Next start line). */
    globals?: Settings | null;
  } = $props();

  const providerName = (p: AgentProvider) =>
    p === "codex" ? m.agent_provider_codex() : m.agent_provider_claude();
  // #3441: the repo's coding CLI and the one its tasks actually start on.
  const agentProvider = $derived(repoConfig.agentProviderFor(repoPath));
  const cli = $derived(
    effectiveRepoProvider(agentProvider, globals?.defaultAgentProvider ?? "claude"),
  );
  const cliHint = $derived(
    agentProvider === "inherit"
      ? m.automation_coding_cli_hint_inherit({ cli: providerName(cli) })
      : m.automation_coding_cli_hint_repo({ cli: providerName(cli) }),
  );
  // A stored model/effort the effective CLI cannot run (e.g. after a global CLI switch) is ignored
  // at spawn time, so the select shows the Inherit it falls back to.
  const storedModel = $derived(repoConfig.defaultModelFor(repoPath));
  const defaultModel = $derived(repoModelFitsProvider(storedModel, cli) ? storedModel : "inherit");
  const guidanceModel = $derived(modelGuidanceAlias(defaultModel, fableAvailable));
  const storedEffort = $derived(repoConfig.defaultEffortFor(repoPath));
  const defaultEffort = $derived(
    repoEffortFitsProvider(storedEffort, cli) ? storedEffort : "inherit",
  );
  const defaultExecutionEffort = $derived(repoConfig.defaultExecutionEffortFor(repoPath));

  const next = $derived(
    globals
      ? nextStart(
          {
            agentProvider,
            defaultModel: storedModel,
            defaultEffort: storedEffort,
            defaultExecutionEffort,
          },
          globals,
        )
      : null,
  );
  const origin = (o: SettingOrigin) =>
    o === "repo" ? m.reposettings_origin_repo() : m.reposettings_origin_global();
  function modelName(model: string): string {
    if (model === "auto") return m.settings_default_model_auto();
    if (model === "default") return m.newtask_model_default();
    return configuredModelLabel(model);
  }
  const effortName = (e: string) => (e === "default" ? m.effort_default() : effortLabel(e));
</script>

<!-- Coding CLI (#3441): "Inherit" follows the global default; a pick drives this repo's new
     tasks, drain and autopilot starts. The model and effort below list only what it runs. -->
<RepoSettingRow field="agentProvider" name={m.automation_coding_cli_label()} desc={cliHint}>
  {#snippet control()}
    <select
      class="afield-num afield-select"
      aria-label={m.automation_coding_cli_label()}
      value={agentProvider}
      onchange={(e) =>
        repoConfig.setAgentProvider(
          repoPath,
          (e.currentTarget as HTMLSelectElement).value as RepoAgentProviderSetting,
        )}
    >
      <option value="inherit">{m.automation_coding_cli_inherit()}</option>
      {#each AGENT_PROVIDERS as p (p)}
        <option value={p}>{providerName(p)}</option>
      {/each}
    </select>
  {/snippet}
</RepoSettingRow>

<RepoSettingRow
  field="defaultModel"
  name={m.automation_default_model_label()}
  desc={m.automation_default_model_hint()}
>
  {#snippet control()}
    <select
      class="afield-num afield-select"
      aria-label={m.automation_default_model_label()}
      value={defaultModel}
      onchange={(e) =>
        repoConfig.setDefaultModel(repoPath, (e.currentTarget as HTMLSelectElement).value)}
    >
      <option value="inherit">{m.automation_default_model_inherit()}</option>
      <option value="auto">{m.settings_default_model_auto()}</option>
      <option value="default">{m.newtask_model_default()}</option>
      {#each pickerModels(cli, defaultModel) as mdl (mdl)}
        <option value={mdl}>{modelOptionLabel(cli, mdl)}</option>
      {/each}
    </select>
  {/snippet}
  {#snippet below()}
    <div class="guidance">
      <ModelGuidance provider={cli} model={guidanceModel} context="repo" />
    </div>
  {/snippet}
</RepoSettingRow>

<RepoSettingRow
  field="defaultEffort"
  name={m.automation_default_effort_label()}
  desc={m.automation_default_effort_hint()}
>
  {#snippet control()}
    <select
      class="afield-num afield-select"
      aria-label={m.automation_default_effort_label()}
      value={defaultEffort}
      onchange={(e) =>
        repoConfig.setDefaultEffort(repoPath, (e.currentTarget as HTMLSelectElement).value)}
    >
      <option value="inherit">{m.automation_default_effort_inherit()}</option>
      <option value="default">{m.effort_default()}</option>
      {#each providerEfforts(cli) as tier (tier)}
        <option value={tier}>{effortLabel(tier)}</option>
      {/each}
    </select>
  {/snippet}
</RepoSettingRow>

<RepoSettingRow
  field="defaultExecutionEffort"
  name={m.automation_execution_effort_label()}
  desc={m.automation_execution_effort_hint()}
>
  {#snippet control()}
    <select
      class="afield-num afield-select"
      aria-label={m.automation_execution_effort_label()}
      value={defaultExecutionEffort}
      onchange={(e) =>
        repoConfig.setDefaultExecutionEffort(
          repoPath,
          (e.currentTarget as HTMLSelectElement).value,
        )}
    >
      <option value="inherit">{m.automation_default_effort_inherit()}</option>
      <option value="default">{m.execution_effort_same_as_planning()}</option>
      {#each EFFORTS as tier (tier)}
        <option value={tier}>{effortLabel(tier)}</option>
      {/each}
    </select>
  {/snippet}
</RepoSettingRow>

{#if next}
  <RepoSettingRow field="" name={m.reposettings_next_start_label()}>
    {#snippet below()}
      <p class="next-start" data-next-start>
        <span>{providerName(next.cli)}</span><span class="origin">{origin(next.cliFrom)}</span>
        <span aria-hidden="true">·</span>
        <span>{modelName(next.model)}</span><span class="origin">{origin(next.modelFrom)}</span>
        <span aria-hidden="true">·</span>
        <span>{effortName(next.effort)}</span><span class="origin">{origin(next.effortFrom)}</span>
        {#if next.goEffort && next.goEffort !== next.effort}
          <span>{m.reposettings_next_start_go({ effort: effortLabel(next.goEffort) })}</span><span
            class="origin">{origin(next.goFrom)}</span
          >
        {/if}
      </p>
    {/snippet}
  </RepoSettingRow>
{/if}

<style>
  .guidance {
    margin-top: 4px;
  }
  .next-start {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 2px 6px;
    margin: 4px 0 0;
    font-size: var(--fs-meta);
    color: var(--color-ink);
  }
  /* where each part comes from: a quiet tag after it */
  .origin {
    font-size: var(--fs-micro);
    color: var(--color-faint);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    padding: 0 4px;
  }
</style>
