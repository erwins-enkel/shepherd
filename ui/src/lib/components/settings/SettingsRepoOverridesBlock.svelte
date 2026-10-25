<script lang="ts">
  import { onMount, tick } from "svelte";
  import { issueFilterSettings } from "#lib/issue-filter-settings.svelte.js";
  import { repos } from "#lib/repos.svelte.js";
  import type { IssueFilterRepoOverride, RepoEntry } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import SettingsGroup from "./SettingsGroup.svelte";
  import "./settings-controls.css";

  // Settings › Workspace "Per-repo exceptions" (#3020): one row per repo whose dropdown replaces
  // the default filter's scope + forks for that repo (issueFilter.repoOverrides). Keys are the
  // repo's realpath, like the server's repo_config; "Standard" removes the key. `focus` (the Up
  // Next flyout's link) expands the group and scrolls it into view.
  let { focus = false }: { focus?: boolean } = $props();

  let open = $state(true);
  let section = $state<HTMLElement>();

  onMount(() => void issueFilterSettings.ensureLoaded());

  $effect(() => {
    if (!focus) return;
    open = true;
    void tick().then(() => section?.scrollIntoView({ block: "start" }));
  });

  const filter = $derived(issueFilterSettings.value);

  type Choice = IssueFilterRepoOverride | "standard";
  const CHOICES: { value: Choice; label: () => string }[] = [
    { value: "standard", label: m.settings_repo_overrides_opt_standard },
    { value: "all", label: m.settings_repo_overrides_opt_all },
    { value: "mine_unassigned", label: m.settings_repo_overrides_opt_mine_unassigned },
    { value: "mine", label: m.settings_repo_overrides_opt_mine },
    { value: "hide", label: m.settings_repo_overrides_opt_hide },
  ];

  // One row per repo name (worktrees/clones of one dir share it), sorted by what the UI shows.
  const rows = $derived(
    [...new Map(repos.entries.map((e) => [e.name, e])).values()].sort((a, b) =>
      a.display.localeCompare(b.display),
    ),
  );

  function current(entry: RepoEntry): Choice {
    return repos.repoOverride(filter?.repoOverrides, entry.path) ?? "standard";
  }

  function pick(entry: RepoEntry, choice: Choice) {
    if (!filter) return;
    const next = { ...filter.repoOverrides };
    // Drop any raw-path spelling too, so the realpath key is the one that counts.
    delete next[entry.path];
    delete next[entry.realPath];
    if (choice !== "standard") next[entry.realPath] = choice;
    void issueFilterSettings.update({ repoOverrides: next });
  }
</script>

<section id="settings-repo-overrides" bind:this={section}>
  <SettingsGroup
    label={m.settings_repo_overrides_title()}
    count={rows.length}
    expanded={open}
    ontoggle={() => (open = !open)}
  >
    <p class="summary">{m.settings_repo_overrides_summary()}</p>
    {#if !filter}
      <p class="summary">{m.settings_issue_filter_unavailable()}</p>
    {:else if rows.length === 0}
      <p class="summary">{m.settings_repo_overrides_none()}</p>
    {:else}
      <table class="ovr">
        <thead>
          <tr>
            <th scope="col">{m.settings_repo_overrides_col_repo()}</th>
            <th scope="col">{m.settings_repo_overrides_col_rule()}</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as entry (entry.name)}
            {@const choice = current(entry)}
            <tr class={{ differs: choice !== "standard" }} data-repo={entry.name}>
              <td class="repo">
                <div class="rcell">
                  <span class="rname">{entry.display}</span>
                  {#if entry.isFork}<span class="rtag">{m.upnext_filter_tag_fork()}</span>{/if}
                  {#if choice !== "standard"}<span class="sr-only"
                      >{m.settings_repo_overrides_differs()}</span
                    >{/if}
                </div>
              </td>
              <td class="rule">
                <span class="set-select">
                  <select
                    value={choice}
                    aria-label={m.settings_repo_overrides_select_aria({ repo: entry.display })}
                    onchange={(e) => pick(entry, e.currentTarget.value as Choice)}
                  >
                    {#each CHOICES as c (c.value)}
                      <option value={c.value}>{c.label()}</option>
                    {/each}
                  </select>
                  <span class="set-chev" aria-hidden="true">▾</span>
                </span>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </SettingsGroup>
</section>

<style>
  .summary {
    margin: 10px 0 4px;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    line-height: 1.5;
  }
  .ovr {
    width: 100%;
    border-collapse: collapse;
    margin-top: 8px;
    table-layout: fixed;
  }
  th {
    text-align: left;
    font-size: var(--fs-meta);
    font-weight: normal;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--color-faint);
    padding: 4px 8px;
    border-bottom: 1px solid var(--color-line);
  }
  td {
    padding: 6px 8px;
    border-bottom: 1px solid var(--color-line);
    vertical-align: middle;
  }
  tr.differs td {
    background: var(--color-inset);
  }
  tr.differs .repo {
    box-shadow: inset 2px 0 0 var(--color-amber);
  }
  .rcell {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .rname {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-ink);
  }
  .rtag {
    flex: none;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    padding: 0 4px;
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .rule {
    width: 45%;
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
