<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import { repoConfig } from "$lib/reviews.svelte";
  import { getRepoRoles, getRepoCollaborators, putRepoRoles } from "$lib/api";
  import { MODELS } from "$lib/types";
  import { modelGuidanceAlias, modelOptionLabel } from "$lib/model-guidance";
  import ModelGuidance from "$lib/components/ModelGuidance.svelte";
  import type { RepoRoles } from "$lib/types";
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
  let me = $state<string | null>(null);
  let collaborators = $state<string[]>([]);
  let collaboratorsUnavailable = $state(false);
  let rolesError = $state<string | null>(null);
  $effect(() => {
    const repo = repoPath;
    rolesError = null;
    void (async () => {
      try {
        const [r, c] = await Promise.all([getRepoRoles(repo), getRepoCollaborators(repo)]);
        if (repo !== repoPath) return; // repo switched mid-flight — drop stale result
        roles = r.roles;
        me = r.me ?? c.me;
        collaborators = c.logins;
        collaboratorsUnavailable = c.collaboratorsUnavailable;
      } catch {
        /* leave defaults; the free-text fallback still lets the user set roles */
      }
    })();
  });

  function normalizeLogin(v: string): string | null {
    const t = v.trim().replace(/^@/, "");
    return t || null;
  }

  // GitHub logins are case-insensitive — fold so a differently-cased stored login
  // isn't treated as a distinct person (duplicate option / wrong "self" match).
  const eqLogin = (a: string | null, b: string | null) =>
    !!a && !!b && a.toLowerCase() === b.toLowerCase();

  // Map a stored login onto the exact casing of its <option> so the dropdown
  // reflects it — a casing-only difference (stored "Kai" vs me/collaborator "kai")
  // would otherwise match no option and fall back to "— anyone / me —".
  function optionValue(value: string | null): string {
    if (!value) return "";
    if (eqLogin(value, me)) return me ?? value;
    return collaborators.find((c) => eqLogin(c, value)) ?? value;
  }

  async function setRole(role: "reviewer" | "merger", value: string | null) {
    const prev = roles;
    roles = { ...roles, [role]: value }; // optimistic
    rolesError = null;
    try {
      const res = await putRepoRoles(repoPath, { [role]: value });
      if (res.pushError) {
        roles = prev; // push rejected (protected branch / auth) → revert + surface
        rolesError = res.pushError;
        return;
      }
      roles = res.roles;
      if (res.me) me = res.me;
    } catch (e) {
      roles = prev;
      rolesError = String((e as Error)?.message ?? e);
    }
  }

  const defaultModel = $derived(repoConfig.defaultModelFor(repoPath));
  const guidanceModel = $derived(modelGuidanceAlias(defaultModel, fableAvailable));
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
      {#each MODELS as mdl (mdl)}
        <option value={mdl}>{modelOptionLabel("claude", mdl)}</option>
      {/each}
    </select>
  </label>
  <div class="drain-model-guidance">
    <ModelGuidance provider="claude" model={guidanceModel} context="repo" />
  </div>
  <div class="signoff-note">{m.automation_default_model_hint()}</div>
</div>

<!-- Repo responsibilities: reviewer + merger (committed to .shepherd/roles.json) -->
<div class="auto-group" id="repo-roles">{m.automation_group_roles()}</div>
{#snippet roleRow(label: string, role: "reviewer" | "merger", value: string | null)}
  <div class="auto-row">
    <div class="auto-meta">
      <div class="auto-name">{label}</div>
    </div>
    {#if collaboratorsUnavailable}
      <input
        class="role-input"
        type="text"
        placeholder={m.roles_freetext_placeholder()}
        value={value ?? ""}
        aria-label={label}
        onchange={(e) => setRole(role, normalizeLogin(e.currentTarget.value))}
      />
    {:else}
      <select
        class="role-select"
        aria-label={label}
        value={optionValue(value)}
        onchange={(e) => setRole(role, e.currentTarget.value || null)}
      >
        <option value="">{m.roles_unset_option()}</option>
        {#if me}<option value={me}>{m.roles_self_option()} (@{me})</option>{/if}
        {#each collaborators.filter((c) => !eqLogin(c, me)) as login (login)}
          <option value={login}>@{login}</option>
        {/each}
        {#if value && !eqLogin(value, me) && !collaborators.some((c) => eqLogin(c, value))}
          <option {value}>@{value}</option>
        {/if}
      </select>
    {/if}
  </div>
{/snippet}
{@render roleRow(m.roles_reviewer_label(), "reviewer", roles.reviewer)}
{@render roleRow(m.roles_merger_label(), "merger", roles.merger)}
<div class="roles-note">
  {#if rolesError}
    <span class="roles-err">{m.roles_push_failed()}: {rolesError}</span>
  {:else}
    {m.automation_roles_hint()}
  {/if}
</div>

<style>
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
    font-family: var(--font-mono);
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
  }
  /* .drain-fields / .drain-field / .drain-label / .afield-num come from
     ./automation-fields.css (imported in <script>). */
  .role-select,
  .role-input {
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
  .signoff-note {
    font-size: var(--fs-meta);
    color: var(--color-faint);
    padding: 0 12px 6px;
  }
  .drain-model-guidance {
    padding: 0 12px 6px;
  }
</style>
