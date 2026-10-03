<script lang="ts">
  import type { RepoEntry } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  let {
    repos,
    all = $bindable(false),
    selected = $bindable<string[]>([]),
    disabled = false,
  }: {
    repos: RepoEntry[];
    all?: boolean;
    selected?: string[];
    disabled?: boolean;
  } = $props();
  const id = $props.id();
  let search = $state("");
  const rows = $derived(
    [
      ...new Map<string, { path: string; name: string; missing: boolean }>([
        ...repos.map(
          (r) => [r.realPath, { path: r.realPath, name: r.name, missing: false }] as const,
        ),
        ...selected
          .filter((path) => !repos.some((r) => r.realPath === path))
          .map((path) => [path, { path, name: "", missing: true }] as const),
      ]).values(),
    ].filter((r) => `${r.name} ${r.path}`.toLowerCase().includes(search.toLowerCase())),
  );
</script>

<div class="repo-picker">
  <label
    ><input type="radio" name={id} bind:group={all} value={false} {disabled} />
    {m.settings_access_repos_selected()}</label
  >
  <label
    ><input type="radio" name={id} bind:group={all} value={true} {disabled} />
    {m.settings_access_repos_all()}</label
  >
  {#if !all}
    <input
      class="repo-search"
      type="search"
      bind:value={search}
      aria-label={m.settings_access_repos_search()}
      placeholder={m.settings_access_repos_search()}
      {disabled}
    />
    <div class="repo-options">
      {#each rows as row (row.path)}
        <label class="repo-option">
          <input
            type="checkbox"
            bind:group={selected}
            value={row.path}
            {disabled}
            aria-label={`${row.name} ${row.path}`.trim()}
          />
          <span
            >{row.name}<span class="repo-path"
              >{row.path}{row.missing ? ` · ${m.settings_access_repos_missing()}` : ""}</span
            ></span
          >
        </label>
      {:else}<p>{m.settings_access_repos_empty()}</p>{/each}
    </div>
  {/if}
</div>

<style>
  .repo-picker {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }
  label {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    color: var(--color-ink);
    font-size: var(--fs-meta);
  }
  input[type="checkbox"],
  input[type="radio"] {
    accent-color: var(--color-amber);
    flex: none;
    margin-top: 2px;
  }
  .repo-options {
    max-height: 190px;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .repo-option span {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .repo-path {
    display: block;
    color: var(--color-muted);
  }
  .repo-search {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid var(--color-line-bright);
    background: var(--color-inset);
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-meta);
    padding: 6px 10px;
    border-radius: 2px;
  }
  input:focus-visible {
    outline: 1px solid var(--color-amber);
    outline-offset: 2px;
  }
  p {
    color: var(--color-muted);
    font-size: var(--fs-meta);
    margin: 0;
  }
</style>
