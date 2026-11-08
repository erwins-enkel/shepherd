<script lang="ts">
  import { onMount } from "svelte";
  import { m } from "#lib/paraglide/messages.js";
  import { repoConfig } from "#lib/reviews.svelte.js";
  import { getAgentExtensions, type AgentExtensions } from "#lib/api.js";
  import { agentExtensionsExplanation } from "#lib/tooltips/explanations.js";
  import InfoTip from "../InfoTip.svelte";
  import "./automation-fields.css";

  // #3780: per-repo plugin / personal-skill allowlists. `null` = no limit (every installed one
  // loads); a list = only those load in this repo's attended Claude sessions.
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

  /** Installed entries plus allowlisted ones no longer offered (uninstalled or switched off), so a
   *  stale entry stays visible and removable instead of silently riding along. */
  function items(g: Group): { name: string; stale: boolean }[] {
    const have = installed?.[g.key] ?? [];
    const stale = (g.allow ?? []).filter((n) => !have.includes(n));
    return [
      ...have.map((name) => ({ name, stale: false })),
      ...stale.map((name) => ({ name, stale: true })),
    ];
  }

  function limit(g: Group, on: boolean) {
    // Turning the limit on starts from everything installed, so nothing disappears until unticked.
    g.set(on ? [...(installed?.[g.key] ?? [])] : null);
  }

  function pick(g: Group, name: string, keep: boolean) {
    const cur = g.allow ?? [];
    g.set(keep ? [...cur, name] : cur.filter((n) => n !== name));
  }
</script>

<div class="drain-fields agent-ext">
  <div class="drain-label ext-label">
    {m.automation_agent_ext_name()}
    <InfoTip text={agentExtensionsExplanation()} label={m.tooltip_agent_ext_title()} />
  </div>
  <div class="ext-note">{m.automation_agent_ext_desc()}</div>
  {#if loadFailed}
    <div class="ext-note">{m.automation_agent_ext_load_failed()}</div>
  {:else if installed}
    {#each groups as g (g.key)}
      <fieldset class="ext-group">
        <legend class="ext-legend">{g.label}</legend>
        <label class="ext-check">
          <input
            type="checkbox"
            checked={g.allow !== null}
            onchange={(e) => limit(g, e.currentTarget.checked)}
          />
          {m.automation_agent_ext_limit()}
        </label>
        {#if g.allow !== null}
          {@const list = items(g)}
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
      </fieldset>
    {/each}
  {/if}
</div>

<style>
  .ext-label {
    display: flex;
    align-items: center;
    gap: 6px;
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
  .ext-legend {
    padding: 0;
    font-size: var(--fs-meta);
    color: var(--color-muted);
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
</style>
