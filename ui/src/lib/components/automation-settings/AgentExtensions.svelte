<script lang="ts">
  import { onMount } from "svelte";
  import { m } from "#lib/paraglide/messages.js";
  import { repoConfig } from "#lib/reviews.svelte.js";
  import { getAgentExtensions, type AgentExtensions } from "#lib/api.js";
  import type { AgentProvider } from "#lib/types.js";
  import { agentExtensionsExplanation } from "#lib/tooltips/explanations.js";
  import RepoSettingRow from "../repo-settings/RepoSettingRow.svelte";
  import "./automation-fields.css";

  // #3780: per-repo plugin / personal-skill allowlists. `null` = no limit (every installed one
  // loads); a list = only those load in this repo's Claude and Codex sessions. One list serves
  // every CLI, so each entry carries the CLIs that have it installed.
  let { repoPath }: { repoPath: string } = $props();

  let installed = $state<AgentExtensions | null>(null);
  let loadFailed = $state(false);

  onMount(() => {
    getAgentExtensions()
      .then((x) => (installed = x))
      .catch(() => (loadFailed = true));
  });

  type Group = {
    key: "plugins" | "skills";
    label: string;
    allow: string[] | null;
    set: (list: string[] | null) => void;
  };

  const groups = $derived<Group[]>([
    {
      key: "plugins",
      label: m.automation_agent_ext_plugins(),
      allow: repoConfig.pluginAllowlistFor(repoPath),
      set: (list) => void repoConfig.setPluginAllowlist(repoPath, list),
    },
    {
      key: "skills",
      label: m.automation_agent_ext_skills(),
      allow: repoConfig.skillAllowlistFor(repoPath),
      set: (list) => void repoConfig.setSkillAllowlist(repoPath, list),
    },
  ]);

  function cliLabel(cli: AgentProvider): string {
    return cli === "codex" ? m.agent_provider_codex() : m.agent_provider_claude();
  }

  /** Installed entries plus allowlisted ones no longer offered (uninstalled or switched off), so a
   *  stale entry stays visible and removable instead of silently riding along. */
  function items(g: Group): { name: string; clis: AgentProvider[]; stale: boolean }[] {
    const have = installed?.[g.key] ?? [];
    const stale = (g.allow ?? []).filter((n) => !have.some((e) => e.name === n));
    return [
      ...have.map((e) => ({ name: e.name, clis: e.clis, stale: false })),
      ...stale.map((name) => ({ name, clis: [], stale: true })),
    ];
  }

  function limit(g: Group, on: boolean) {
    // Turning the limit on starts from everything installed for any CLI, so nothing disappears
    // until unticked.
    g.set(on ? (installed?.[g.key] ?? []).map((e) => e.name) : null);
  }

  function pick(g: Group, name: string, keep: boolean) {
    const cur = g.allow ?? [];
    g.set(keep ? [...cur, name] : cur.filter((n) => n !== name));
  }
</script>

<RepoSettingRow
  field="pluginAllowlist skillAllowlist"
  name={m.automation_agent_ext_name()}
  explanation={agentExtensionsExplanation()}
  desc={m.automation_agent_ext_desc()}
>
  {#snippet below()}
    <div class="agent-ext">
      {#if loadFailed}
        <div class="ext-note">{m.automation_agent_ext_load_failed()}</div>
      {:else if installed}
        {#each groups as g (g.key)}
          {@const list = items(g)}
          <div class="ext-group" role="group" aria-label={g.label}>
            <div class="ext-head">
              <span class="ext-legend">{g.label}</span>
              {#if g.allow !== null && list.length}
                {@const allow = g.allow}
                <button
                  type="button"
                  class="bs-btn"
                  aria-label={m.automation_agent_ext_select_all_aria({ group: g.label })}
                  disabled={list.every((it) => allow.includes(it.name))}
                  onclick={() => g.set(list.map((it) => it.name))}
                >
                  {m.automation_agent_ext_select_all()}
                </button>
                <button
                  type="button"
                  class="bs-btn"
                  aria-label={m.automation_agent_ext_select_none_aria({ group: g.label })}
                  disabled={allow.length === 0}
                  onclick={() => g.set([])}
                >
                  {m.automation_agent_ext_select_none()}
                </button>
              {/if}
            </div>
            <label class="ext-check">
              <input
                type="checkbox"
                checked={g.allow !== null}
                onchange={(e) => limit(g, e.currentTarget.checked)}
              />
              {m.automation_agent_ext_limit()}
            </label>
            {#if g.allow !== null}
              {#if g.key === "plugins" && list.some((it) => it.clis.includes("codex"))}
                <!-- Verified against codex-cli 0.164: a per-spawn override reaches local-marketplace
                     plugins only; remote-catalog plugins keep their server-managed on/off state. -->
                <div class="ext-note">{m.automation_agent_ext_codex_remote_hint()}</div>
              {/if}
              {#if list.length}
                <ul class="ext-items">
                  {#each list as it (it.name)}
                    <li>
                      <label class={["ext-check", "ext-item", { stale: it.stale }]}>
                        <input
                          type="checkbox"
                          checked={g.allow.includes(it.name)}
                          onchange={(e) => pick(g, it.name, e.currentTarget.checked)}
                        />
                        <span class="ext-name">{it.name}</span>
                        {#each it.clis as cli (cli)}
                          <span class="ext-cli">{cliLabel(cli)}</span>
                        {/each}
                        {#if it.stale}
                          <span class="ext-stale">{m.automation_agent_ext_not_installed()}</span>
                        {/if}
                      </label>
                    </li>
                  {/each}
                </ul>
              {:else}
                <div class="ext-note">{m.automation_agent_ext_none_installed()}</div>
              {/if}
            {/if}
          </div>
        {/each}
      {/if}
    </div>
  {/snippet}
</RepoSettingRow>

<style>
  .agent-ext {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 6px;
  }
  .ext-note {
    font-size: var(--fs-meta);
    color: var(--color-faint);
  }
  .ext-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 0;
    padding: 0;
    border: none;
    min-width: 0;
  }
  .ext-head {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .ext-legend {
    margin-right: auto;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .ext-head .bs-btn {
    align-self: auto;
  }
  .ext-check {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--fs-meta);
    color: var(--color-ink);
    cursor: pointer;
  }
  .ext-check input {
    accent-color: var(--color-amber);
  }
  .ext-items {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
    padding: 0 0 0 18px;
    list-style: none;
  }
  .ext-name {
    font-family: var(--font-mono);
    overflow-wrap: anywhere;
  }
  .ext-item.stale .ext-name {
    color: var(--color-faint);
  }
  .ext-stale {
    color: var(--color-faint);
  }
  /* The /design-system .badge recipe: which CLI has this plugin or skill installed. */
  .ext-cli {
    flex: none;
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 1px 6px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
  }
</style>
