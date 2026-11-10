<script lang="ts">
  import { firstSafeHttpUrl } from "#lib/url.js";
  import { m } from "#lib/paraglide/messages.js";
  import {
    enableRepoRolesAutoMerge,
    getRepoRoles,
    getRepoCollaborators,
    putRepoRoles,
  } from "#lib/api.js";
  import type { RepoMergeSettings, RepoRoles, RepoRolesPending } from "#lib/types.js";
  import RepoSettingRow from "./RepoSettingRow.svelte";
  import "../automation-settings/automation-fields.css";

  // Repo responsibilities (#3443 moved them here from AutomationRepoFields): who reviews, who
  // merges — committed to .shepherd/roles.json through their own endpoint (PUT /api/repo-roles,
  // a commit or a PR of its own), not the repo config.
  let { repoPath }: { repoPath: string } = $props();

  // Loaded lazily when the panel mounts / the repo changes — the herd reads the computed
  // handoff off the cached git state, so this fetch is panel-only.
  let roles = $state<RepoRoles>({ reviewer: null, merger: null });
  // A default branch that refuses the direct push takes the change as a PR: until it merges,
  // `roles` (committed) still applies and `pending` carries the value the PR will commit.
  let pending = $state<RepoRolesPending | null>(null);
  let mergeSettings = $state<RepoMergeSettings | null>(null);
  let enablingAutoMerge = $state(false);
  let autoMergeEnableFailed = $state(false);
  /** The host accepted the switch but kept auto-merge off (e.g. a private repo on GitHub Free). */
  let autoMergeEnableIgnored = $state(false);
  let rolesMe = $state<string | null>(null);
  let collaboratorsMe = $state<string | null>(null);
  let collaborators = $state<string[]>([]);
  let collaboratorsUnavailable = $state(false);
  let collaboratorsLoading = $state(true);
  let collaboratorsLoadFailed = $state(false);
  let collaboratorsSource = $state<"collaborators" | "assignees" | undefined>(undefined);
  let collaboratorsRepoSlug = $state<string | null>(null);
  let isFork = $state(false);
  let rolesLoading = $state(true);
  let rolesLoadFailed = $state(false);
  let rolesSaveError = $state<string | null>(null);
  let saving = $state(false);
  let generation = 0;
  const me = $derived(rolesMe ?? collaboratorsMe);
  /** What the selects show: the open roles PR's value wins over the committed one. */
  const shownRoles = $derived(pending?.roles ?? roles);
  // How a change reaches the default branch — shown whenever it does not take direct pushes.
  const showMergePath = $derived(!!pending || !!mergeSettings?.requiresPr);
  const autoMerge = $derived.by((): "on" | "off" | "failed" | null => {
    if (pending?.autoMerge === "failed") return "failed";
    if (pending?.autoMerge === "enabled") return "on";
    if (pending?.autoMerge === "disallowed") return "off";
    if (mergeSettings?.autoMergeAllowed === true) return "on";
    if (mergeSettings?.autoMergeAllowed === false) return "off";
    return null;
  });

  async function loadRoles(repo: string, token: number) {
    rolesLoading = true;
    rolesLoadFailed = false;
    try {
      const result = await getRepoRoles(repo);
      if (token !== generation) return;
      roles = result.roles;
      pending = result.pending ?? null;
      mergeSettings = result.mergeSettings ?? null;
      rolesMe = result.me;
    } catch {
      if (token !== generation) return;
      rolesLoadFailed = true;
    } finally {
      if (token === generation) rolesLoading = false;
    }
  }

  async function loadCollaborators(repo: string, token: number) {
    collaboratorsLoading = true;
    collaboratorsLoadFailed = false;
    collaboratorsUnavailable = false;
    try {
      const result = await getRepoCollaborators(repo);
      if (token !== generation) return;
      collaborators = result.logins;
      collaboratorsMe = result.me;
      collaboratorsUnavailable = result.collaboratorsUnavailable;
      collaboratorsSource = result.source;
      collaboratorsRepoSlug = result.repoSlug;
      isFork = result.isFork;
    } catch {
      if (token !== generation) return;
      collaboratorsLoadFailed = true;
      collaboratorsUnavailable = true;
    } finally {
      if (token === generation) collaboratorsLoading = false;
    }
  }

  $effect(() => {
    const repo = repoPath;
    const token = ++generation;
    roles = { reviewer: null, merger: null };
    pending = null;
    mergeSettings = null;
    enablingAutoMerge = false;
    autoMergeEnableFailed = false;
    autoMergeEnableIgnored = false;
    rolesMe = null;
    collaboratorsMe = null;
    collaborators = [];
    collaboratorsUnavailable = false;
    collaboratorsLoadFailed = false;
    collaboratorsSource = undefined;
    collaboratorsRepoSlug = null;
    isFork = false;
    rolesLoadFailed = false;
    rolesSaveError = null;
    saving = false;
    void loadRoles(repo, token);
    void loadCollaborators(repo, token);
    return () => {
      if (generation === token) generation += 1;
    };
  });

  function retryFailedLoads() {
    const token = generation;
    const repo = repoPath;
    if (rolesLoadFailed) void loadRoles(repo, token);
    if (collaboratorsLoadFailed || collaboratorsUnavailable) {
      void loadCollaborators(repo, token);
    }
  }

  // GitHub logins are case-insensitive — fold so a differently-cased stored login
  // isn't treated as a distinct person (duplicate option / wrong "self" match).
  const eqLogin = (a: string | null, b: string | null) =>
    !!a && !!b && a.toLowerCase() === b.toLowerCase();

  // Map a stored login onto the exact casing of its fetched option so the native
  // select reflects case-insensitive GitHub matches. Out-of-list stored values keep
  // their original spelling through the explicit fallback option below.
  function optionValue(value: string | null): string {
    if (!value) return "";
    if (eqLogin(value, me)) return me ?? value;
    return collaborators.find((c) => eqLogin(c, value)) ?? value;
  }

  async function setRole(role: "reviewer" | "merger", value: string | null) {
    const token = generation;
    const repo = repoPath;
    const prev = { roles: { ...roles }, pending };
    // Optimistic, on whichever value the select shows.
    if (pending) pending = { ...pending, roles: { ...pending.roles, [role]: value } };
    else roles = { ...roles, [role]: value };
    rolesSaveError = null;
    saving = true;
    const revert = () => {
      roles = prev.roles;
      pending = prev.pending;
    };
    try {
      const res = await putRepoRoles(repo, { [role]: value });
      if (token !== generation) return;
      if (res.pushError) {
        revert(); // push failed (auth / offline / PR fallback failed) → revert + surface
        rolesSaveError = res.pushError;
        return;
      }
      roles = res.roles;
      pending = res.pending ?? null;
      if (res.mergeSettings) mergeSettings = res.mergeSettings;
      rolesMe = res.me;
    } catch (e) {
      if (token !== generation) return;
      revert();
      rolesSaveError = String((e as Error)?.message ?? e);
    } finally {
      if (token === generation) saving = false;
    }
  }

  async function enableAutoMerge() {
    const token = generation;
    const repo = repoPath;
    enablingAutoMerge = true;
    autoMergeEnableFailed = false;
    autoMergeEnableIgnored = false;
    try {
      const res = await enableRepoRolesAutoMerge(repo);
      if (token !== generation) return;
      autoMergeEnableIgnored = res.mergeSettings?.autoMergeAllowed === false;
      // The setting is on even when the follow-up read came back empty.
      mergeSettings =
        res.mergeSettings ?? (mergeSettings && { ...mergeSettings, autoMergeAllowed: true });
      if (res.pending) pending = res.pending;
    } catch {
      if (token !== generation) return;
      autoMergeEnableFailed = true;
    } finally {
      if (token === generation) enablingAutoMerge = false;
    }
  }

  /** A role as the pending note names it: "@login", or the unset option's label. */
  const roleLabel = (login: string | null) => (login ? `@${login}` : m.roles_unset_option());
</script>

<!-- Repo responsibilities: reviewer + merger (committed to .shepherd/roles.json) -->
<div class="roles-head" id="repo-roles">{m.automation_group_roles()}</div>
{#snippet roleRow(label: string, role: "reviewer" | "merger", value: string | null)}
  <RepoSettingRow field={`roles.${role}`} name={label}>
    {#snippet control()}
      <select
        class="role-select"
        aria-label={label}
        aria-busy={rolesLoading || collaboratorsLoading || saving}
        disabled={rolesLoading || saving}
        value={optionValue(value)}
        onchange={(e) => setRole(role, e.currentTarget.value || null)}
      >
        <option value="">{m.roles_unset_option()}</option>
        {#if me}
          <option value={me}>{m.roles_self_option()} (@{me})</option>
        {/if}
        {#each collaborators.filter((c) => !eqLogin(c, me)) as login (login)}
          <option value={login}>@{login}</option>
        {/each}
        {#if value && !eqLogin(value, me) && !collaborators.some((c) => eqLogin(c, value))}
          <option {value}>@{value}</option>
        {/if}
      </select>
    {/snippet}
  </RepoSettingRow>
{/snippet}
{@render roleRow(m.roles_reviewer_label(), "reviewer", shownRoles.reviewer)}
{@render roleRow(m.roles_merger_label(), "merger", shownRoles.merger)}
{#if pending}
  <div class="roles-note roles-pending" role="status">
    {m.roles_pending_pr({
      number: pending.number,
      reviewer: roleLabel(roles.reviewer),
      merger: roleLabel(roles.merger),
    })}
    {#if pending.url}
      <!-- eslint-disable svelte/no-navigation-without-resolve -- external PR URL -->
      <a
        class="roles-link"
        href={firstSafeHttpUrl(pending.url) ?? undefined}
        target="_blank"
        rel="noopener noreferrer"
      >
        {m.roles_pending_pr_open()}
      </a>
      <!-- eslint-enable svelte/no-navigation-without-resolve -->
    {/if}
  </div>
{/if}
{#if showMergePath}
  <div class="roles-merge-path">
    <span>{m.roles_branch_protected()}</span>
    {#if autoMerge === "on"}
      <span>{m.roles_automerge_on()}</span>
    {:else if autoMerge === "failed"}
      <span>{m.roles_automerge_failed()}</span>
    {:else if autoMerge === "off"}
      <span>{m.roles_automerge_off()}</span>
      {#if mergeSettings?.planLimited}
        <span>{m.roles_automerge_plan_needed()}</span>
      {:else if mergeSettings?.canAdminister}
        <button
          class="bs-btn"
          type="button"
          disabled={enablingAutoMerge}
          aria-busy={enablingAutoMerge}
          onclick={enableAutoMerge}
        >
          {m.roles_automerge_enable()}
        </button>
      {:else}
        <span>{m.roles_automerge_admin_needed()}</span>
      {/if}
      {#if autoMergeEnableFailed}
        <span class="roles-err" role="alert">{m.roles_automerge_enable_failed()}</span>
      {:else if autoMergeEnableIgnored}
        <span class="roles-err" role="alert">{m.roles_automerge_enable_ignored()}</span>
      {/if}
    {/if}
  </div>
{/if}
<div class="roles-note">
  {#if rolesSaveError}
    <span class="roles-err">{m.roles_push_failed()}: {rolesSaveError}</span>
  {:else}
    {m.automation_roles_hint()}
  {/if}
</div>
{#if collaboratorsSource === "assignees"}
  <div class="roles-note roles-source-hint">{m.roles_assignees_hint()}</div>
{/if}
{#if isFork && collaboratorsRepoSlug}
  <div class="roles-note roles-fork-hint">
    {m.roles_fork_hint({ repo: collaboratorsRepoSlug })}
  </div>
{/if}
{#if rolesLoadFailed || collaboratorsLoadFailed || collaboratorsUnavailable}
  <div class="roles-load-status" role="status">
    <div>
      {#if rolesLoadFailed}<span>{m.roles_load_failed()}</span>{/if}
      {#if collaboratorsLoadFailed || collaboratorsUnavailable}
        <span>{m.roles_people_unavailable()}</span>
      {/if}
    </div>
    <button class="bs-btn" type="button" onclick={retryFailedLoads}>{m.common_retry()}</button>
  </div>
{/if}

<style>
  .roles-head {
    font-size: var(--fs-micro);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--color-amber);
    padding: 8px 12px 4px;
    border-top: 1px solid var(--color-line);
  }
  .role-select {
    flex: 0 0 auto;
    width: 140px;
    max-width: 100%;
    background: var(--color-panel);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    padding: 3px 6px;
  }
  .roles-note {
    font-size: var(--fs-meta);
    color: var(--color-faint);
    padding: 6px 12px 12px;
  }
  .roles-err {
    color: var(--color-red);
  }
  .roles-pending {
    color: var(--color-ink);
    padding-bottom: 0;
  }
  .roles-link {
    color: var(--color-blue);
    text-decoration: none;
    white-space: nowrap;
  }
  .roles-link:hover {
    text-decoration: underline;
  }
  .roles-merge-path {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    padding: 6px 12px 0;
    font-size: var(--fs-meta);
    color: var(--color-faint);
  }
  .roles-load-status {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 0 12px 12px;
    color: var(--color-red);
    font-size: var(--fs-meta);
  }
  .roles-load-status > div {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .roles-load-status .bs-btn {
    flex: 0 0 auto;
  }
</style>
