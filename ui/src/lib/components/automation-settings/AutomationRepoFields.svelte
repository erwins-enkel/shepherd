<script lang="ts">
  import { firstSafeHttpUrl } from "#lib/url.js";
  import { m } from "#lib/paraglide/messages.js";
  import { repoConfig } from "#lib/reviews.svelte.js";
  import {
    enableRepoRolesAutoMerge,
    getRepoRoles,
    getRepoCollaborators,
    putRepoRoles,
  } from "#lib/api.js";
  import { EFFORTS } from "#lib/types.js";
  import { modelGuidanceAlias, modelOptionLabel } from "#lib/model-guidance.js";
  import { pickerModels } from "#lib/provider-models.js";
  import { effortLabel } from "#lib/effort-guidance.js";
  import ModelGuidance from "#lib/components/ModelGuidance.svelte";
  import type { RepoConfig, RepoMergeSettings, RepoRoles, RepoRolesPending } from "#lib/types.js";
  import "./automation-fields.css";

  let {
    repoPath,
    fableAvailable,
  }: {
    repoPath: string;
    fableAvailable: boolean;
  } = $props();

  // Repo responsibilities (.shepherd/roles.json): who reviews, who merges. Loaded
  // lazily when the panel mounts / the repo changes — the herd reads the computed
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

  const defaultModel = $derived(repoConfig.defaultModelFor(repoPath));
  const guidanceModel = $derived(modelGuidanceAlias(defaultModel, fableAvailable));
  const defaultEffort = $derived(repoConfig.defaultEffortFor(repoPath));
  const defaultExecutionEffort = $derived(repoConfig.defaultExecutionEffortFor(repoPath));
  const previewOpenMode = $derived(repoConfig.previewOpenModeFor(repoPath));
</script>

<!-- Default model: a repo-wide override of the global default (Settings → Session).
     "Inherit" defers to the global setting; an explicit choice wins for both the
     New-Task picker preselect and autonomous drain/autopilot spawns in this repo. -->
<div class="drain-fields">
  <label class="drain-field">
    <span class="drain-label">{m.automation_default_model_label()}</span>
    <select
      class="afield-num model-select"
      aria-label={m.automation_default_model_label()}
      value={defaultModel}
      onchange={(e) =>
        repoConfig.setDefaultModel(repoPath, (e.currentTarget as HTMLSelectElement).value)}
    >
      <option value="inherit">{m.automation_default_model_inherit()}</option>
      <option value="auto">{m.settings_default_model_auto()}</option>
      <option value="default">{m.newtask_model_default()}</option>
      {#each pickerModels("claude", defaultModel) as mdl (mdl)}
        <option value={mdl}>{modelOptionLabel("claude", mdl)}</option>
      {/each}
    </select>
  </label>
  <div class="drain-model-guidance">
    <ModelGuidance provider="claude" model={guidanceModel} context="repo" />
  </div>
  <div class="signoff-note">{m.automation_default_model_hint()}</div>

  <label class="drain-field">
    <span class="drain-label">{m.automation_default_effort_label()}</span>
    <select
      class="afield-num model-select"
      aria-label={m.automation_default_effort_label()}
      value={defaultEffort}
      onchange={(e) =>
        repoConfig.setDefaultEffort(repoPath, (e.currentTarget as HTMLSelectElement).value)}
    >
      <option value="inherit">{m.automation_default_effort_inherit()}</option>
      <option value="default">{m.effort_default()}</option>
      {#each EFFORTS as tier (tier)}
        <option value={tier}>{effortLabel(tier)}</option>
      {/each}
    </select>
  </label>
  <div class="signoff-note">{m.automation_default_effort_hint()}</div>

  <label class="drain-field">
    <span class="drain-label">{m.automation_execution_effort_label()}</span>
    <select
      class="afield-num model-select"
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
  </label>
  <div class="signoff-note">{m.automation_execution_effort_hint()}</div>

  <label class="drain-field">
    <span class="drain-label">{m.automation_preview_open_mode_label()}</span>
    <select
      class="afield-num model-select"
      aria-label={m.automation_preview_open_mode_label()}
      value={previewOpenMode}
      onchange={(e) =>
        repoConfig.setPreviewOpenMode(
          repoPath,
          (e.currentTarget as HTMLSelectElement).value as RepoConfig["previewOpenMode"],
        )}
    >
      <option value="ask">{m.preview_open_mode_ask()}</option>
      <option value="inline">{m.preview_open_mode_inline()}</option>
      <option value="tab">{m.preview_open_mode_tab()}</option>
    </select>
  </label>
  <div class="signoff-note">{m.automation_preview_open_mode_hint()}</div>
</div>

<!-- Repo responsibilities: reviewer + merger (committed to .shepherd/roles.json) -->
<div class="auto-group" id="repo-roles">{m.automation_group_roles()}</div>
{#snippet roleRow(label: string, role: "reviewer" | "merger", value: string | null)}
  <div class="auto-row">
    <div class="auto-meta">
      <div class="auto-name">{label}</div>
    </div>
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
  </div>
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
          class="gbtn"
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
    <button class="gbtn" type="button" onclick={retryFailedLoads}>{m.common_retry()}</button>
  </div>
{/if}

<style>
  /* Option labels are prose (model names, effort tiers, modes), not numbers: drop the
     `.afield-num` mono these selects borrow for their chrome. */
  .model-select {
    font-family: var(--font-sans);
  }
  /* Generic per-row layout classes — duplicated from the parent (every toggle row
     there uses them); the role rows here reuse the same conventions. */
  .auto-group {
    font-size: var(--fs-micro);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--color-amber);
    padding: 8px 12px 4px;
  }
  .auto-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
    padding: 8px 12px;
    border-top: 1px solid var(--color-line);
  }
  .auto-meta {
    min-width: 0;
  }
  .auto-name {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
  }
  /* .drain-fields / .drain-field / .drain-label / .afield-num come from
     ./automation-fields.css (imported in <script>). */
  .role-select {
    flex: 0 0 auto;
    width: 140px;
    max-width: 50%;
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
  .roles-load-status .gbtn {
    flex: 0 0 auto;
  }
  /* Canonical action-button recipe from /design-system. Styles are scoped here
     because app.css deliberately does not define a global .gbtn. */
  .gbtn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 2px 8px;
    cursor: pointer;
    transition:
      border-color 0.12s,
      color 0.12s;
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
  .signoff-note {
    font-size: var(--fs-meta);
    color: var(--color-faint);
    padding: 0 12px 6px;
  }
  .drain-model-guidance {
    padding: 0 12px 6px;
  }
</style>
