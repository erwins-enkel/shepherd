<script lang="ts">
  import { untrack } from "svelte";
  import { m } from "$lib/paraglide/messages";
  import { repoConfig } from "$lib/reviews.svelte";
  import { clampCap, clampCeiling, sanitizeLabel } from "../git-rail-drain";
  import { getRepoRoles, getRepoCollaborators, putRepoRoles } from "$lib/api";
  import { MODELS } from "$lib/types";
  import { modelLabel } from "$lib/model-label";
  import type { RepoRoles } from "$lib/types";

  let {
    repoPath,
    autoDrain,
  }: {
    repoPath: string;
    autoDrain: boolean;
  } = $props();

  // Drain config fields, seeded from stored config and re-seeded whenever the
  // section becomes visible (drain turned on) or the repo changes.
  // svelte-ignore state_referenced_locally
  let drainCap = $state(repoConfig.maxAutoFor(repoPath));
  // svelte-ignore state_referenced_locally
  let drainLabel = $state(repoConfig.autoLabelFor(repoPath));
  // svelte-ignore state_referenced_locally
  let drainCeiling = $state(repoConfig.usageCeilingFor(repoPath));
  $effect(() => {
    // Re-seed the inputs when the repo changes or the drain section (re)appears.
    // untrack the store reads so committing a field (which writes back to the
    // store) never retriggers this effect and clobbers an in-flight edit.
    const repo = repoPath;
    if (!autoDrain) return;
    untrack(() => {
      drainCap = repoConfig.maxAutoFor(repo);
      drainLabel = repoConfig.autoLabelFor(repo);
      drainCeiling = repoConfig.usageCeilingFor(repo);
    });
  });

  async function commitDrainCap() {
    const n = clampCap(drainCap);
    drainCap = n;
    await repoConfig.setMaxAuto(repoPath, n);
    drainCap = repoConfig.maxAutoFor(repoPath);
  }
  async function commitDrainLabel() {
    const t = sanitizeLabel(drainLabel);
    if (t === null) {
      drainLabel = repoConfig.autoLabelFor(repoPath);
      return;
    }
    drainLabel = t;
    await repoConfig.setAutoLabel(repoPath, t);
    drainLabel = repoConfig.autoLabelFor(repoPath);
  }
  async function commitDrainCeiling() {
    const n = clampCeiling(drainCeiling);
    drainCeiling = n;
    await repoConfig.setUsageCeiling(repoPath, n);
    drainCeiling = repoConfig.usageCeilingFor(repoPath);
  }

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
</script>

<!-- Default model: a repo-wide override of the global default (Settings → Session).
     "Inherit" defers to the global setting; an explicit choice wins for both the
     New-Task picker preselect and autonomous drain/autopilot spawns in this repo. -->
<div class="drain-fields">
  <label class="drain-field">
    <span class="drain-label">{m.automation_default_model_label()}</span>
    <select
      class="num model-select"
      aria-label={m.automation_default_model_label()}
      value={repoConfig.defaultModelFor(repoPath)}
      onchange={(e) =>
        repoConfig.setDefaultModel(repoPath, (e.currentTarget as HTMLSelectElement).value)}
    >
      <option value="inherit">{m.automation_default_model_inherit()}</option>
      <option value="auto">{m.settings_default_model_auto()}</option>
      <option value="default">{m.newtask_model_default()}</option>
      {#each MODELS as mdl (mdl)}
        <option value={mdl}>{modelLabel(mdl)}</option>
      {/each}
    </select>
  </label>
  <div class="signoff-note">{m.automation_default_model_hint()}</div>
</div>
{#if autoDrain}
  <div class="drain-fields">
    <label class="drain-field">
      <span class="drain-label">{m.drain_cap_label()}</span>
      <input
        class="num"
        type="number"
        min="1"
        max="20"
        bind:value={drainCap}
        aria-label={m.drain_cap_label()}
        onchange={commitDrainCap}
      />
    </label>
    <label class="drain-field">
      <span class="drain-label">{m.drain_label_label()}</span>
      <input
        class="num txt"
        type="text"
        bind:value={drainLabel}
        aria-label={m.drain_label_label()}
        onchange={commitDrainLabel}
        onblur={commitDrainLabel}
      />
    </label>
    <label class="drain-field">
      <span class="drain-label">{m.drain_ceiling_label()}</span>
      <input
        class="num"
        type="number"
        min="0"
        max="100"
        bind:value={drainCeiling}
        aria-label={m.drain_ceiling_label()}
        onchange={commitDrainCeiling}
      />
    </label>
  </div>
{/if}

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
  .drain-fields {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 12px 12px 22px;
    border-top: 1px solid var(--color-line);
    background: var(--color-panel);
  }
  .drain-field {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .drain-label {
    font-size: var(--fs-meta);
    color: var(--color-ink);
    white-space: nowrap;
  }
  .num {
    flex: 0 0 auto;
    width: 90px;
    background: var(--color-panel);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--fs-base);
    padding: 3px 6px;
    text-align: right;
  }
  /* The label is free text (e.g. "shepherd:auto") that overflows the fixed
     numeric width on narrow screens — let it grow with the row and read from
     the start instead of clipping the left side under right-alignment. */
  .num.txt {
    flex: 1 1 auto;
    width: auto;
    min-width: 0;
    text-align: left;
  }
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
</style>
