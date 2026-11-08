<script lang="ts">
  import { onMount } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { getRepoRunDefaults, type RepoRunDefaults } from "#lib/api.js";
  import { repoConfig } from "#lib/reviews.svelte.js";
  import { repoSettingsWindow } from "#lib/repo-settings-window.svelte.js";
  import { ownRunDefaults } from "#lib/repo-cli.js";
  import { configuredModelLabel } from "#lib/model-label.js";
  import { effortLabel } from "#lib/effort-guidance.js";
  import type { AgentProvider } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import HighlightText from "./HighlightText.svelte";
  import "./settings-controls.css";

  // Settings › Coding CLI "Repos with their own values" (#3447): every repo whose coding CLI,
  // model, effort or execution effort is not inherited, under the global defaults. "Open" shows
  // the repo settings window at Agent environment over Settings. Loaded once per Settings open; a
  // repo opened from here then reads the repo-config store the window writes, so a repo set back
  // to Inherit leaves the table at once.
  let {
    defaultAgentProvider,
    query = "",
  }: { defaultAgentProvider: AgentProvider; query?: string } = $props();
  const q = $derived(query.trim());

  let fetched = $state<RepoRunDefaults[] | null>(null);
  let failed = $state(false);
  const opened = new SvelteSet<string>();
  let section = $state<HTMLElement>();

  onMount(async () => {
    try {
      fetched = (await getRepoRunDefaults()).repos;
    } catch {
      failed = true;
    }
  });

  function current(r: RepoRunDefaults): RepoRunDefaults {
    if (!opened.has(r.repoPath) || !repoConfig.loaded[r.repoPath]) return r;
    return {
      ...r,
      agentProvider: repoConfig.agentProviderFor(r.repoPath),
      defaultModel: repoConfig.defaultModelFor(r.repoPath),
      defaultEffort: repoConfig.defaultEffortFor(r.repoPath),
      defaultExecutionEffort: repoConfig.defaultExecutionEffortFor(r.repoPath),
    };
  }

  const rows = $derived(
    fetched ? ownRunDefaults(fetched.map(current), defaultAgentProvider) : null,
  );

  // The row's button can leave with its row, so focus comes back to the block.
  function open(repoPath: string) {
    opened.add(repoPath);
    repoSettingsWindow.open(repoPath, { section: "agent", opener: section });
  }

  const cliName = (v: string) =>
    v === "codex" ? m.agent_provider_codex() : m.agent_provider_claude();
  function modelName(v: string): string {
    if (v === "auto") return m.settings_default_model_auto();
    if (v === "default") return m.newtask_model_default();
    return configuredModelLabel(v);
  }
  const effortName = (v: string) => (v === "default" ? m.effort_default() : effortLabel(v));
  const executionName = (v: string) =>
    v === "default" ? m.execution_effort_same_as_planning() : effortLabel(v);
</script>

{#snippet cell(value: string, label: (v: string) => string)}
  {#if value === "inherit"}
    <td class="inherit">{m.settings_repo_run_defaults_inherits()}</td>
  {:else}
    <td>{label(value)}</td>
  {/if}
{/snippet}

<section
  class="own"
  bind:this={section}
  tabindex="-1"
  aria-labelledby="settings-repo-run-defaults-title"
>
  <div class="glabel" id="settings-repo-run-defaults-title">
    <HighlightText text={m.settings_repo_run_defaults_title()} query={q} />
  </div>
  <p class="hint"><HighlightText text={m.settings_repo_run_defaults_hint()} query={q} /></p>
  {#if failed}
    <p class="hint">{m.settings_repo_run_defaults_load_failed()}</p>
  {:else if rows && rows.length === 0}
    <p class="none">{m.settings_repo_run_defaults_none()}</p>
  {:else if rows}
    <div class="scroll">
      <table>
        <thead>
          <tr>
            <th scope="col">{m.settings_repo_run_defaults_col_repo()}</th>
            <th scope="col">{m.settings_repo_run_defaults_col_cli()}</th>
            <th scope="col">{m.settings_repo_run_defaults_col_model()}</th>
            <th scope="col">{m.settings_repo_run_defaults_col_effort()}</th>
            <th scope="col">{m.settings_repo_run_defaults_col_execution()}</th>
            <th scope="col"
              ><span class="sr-only">{m.settings_repo_run_defaults_col_actions()}</span></th
            >
          </tr>
        </thead>
        <tbody>
          {#each rows as r (r.repoPath)}
            <tr data-repo={r.name}>
              <th scope="row" class="repo">{r.name}</th>
              {@render cell(r.agentProvider, cliName)}
              {@render cell(r.defaultModel, modelName)}
              {@render cell(r.defaultEffort, effortName)}
              {@render cell(r.defaultExecutionEffort, executionName)}
              <td class="act">
                <button
                  type="button"
                  class="set-gbtn"
                  aria-label={m.settings_repo_run_defaults_open_aria({ repo: r.name })}
                  onclick={() => open(r.repoPath)}>{m.settings_repo_run_defaults_open()}</button
                >
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

<style>
  /* Its label also closes the last GLOBAL DEFAULTS row, like DEFAULT PER ENGINE below it. */
  .own {
    border-top: 1px solid var(--color-line);
    margin-top: 6px;
    padding: 6px 0 12px;
    outline: none;
  }
  .glabel {
    font-size: var(--fs-micro);
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--color-faint);
    padding: 10px 0 6px;
  }
  .hint,
  .none {
    margin: 0 0 8px;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    line-height: 1.5;
  }
  .none {
    color: var(--color-ink);
  }
  .scroll {
    overflow-x: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  th,
  td {
    text-align: left;
    padding: 6px 8px;
    border-bottom: 1px solid var(--color-line);
    white-space: nowrap;
    font-size: var(--fs-meta);
    color: var(--color-ink);
  }
  thead th {
    font-size: var(--fs-micro);
    font-weight: normal;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--color-faint);
    padding: 4px 8px;
  }
  .repo {
    font-family: var(--font-mono);
    font-weight: normal;
  }
  .inherit {
    color: var(--color-faint);
  }
  .act {
    text-align: right;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
</style>
