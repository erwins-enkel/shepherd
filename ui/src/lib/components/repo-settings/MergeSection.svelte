<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { repoConfig } from "#lib/reviews.svelte.js";
  import { MERGE_MODES, mergeModeOf, type MergeMode } from "#lib/merge-mode.js";
  import RepoSettingRow from "./RepoSettingRow.svelte";
  import RepoRolesFields from "./RepoRolesFields.svelte";
  import { useSettingLink } from "./setting-link";
  import "../automation-settings/automation-fields.css";

  // Merge (#3443): how a finished PR gets in — one choice of you merge / draft until sign-off /
  // full-auto merge (#3444), with or without CI — plus the manual-steps issue and who reviews and
  // merges.
  let { repoPath, armCoachmarks = false }: { repoPath: string; armCoachmarks?: boolean } = $props();

  const groupName = $props.id();
  const goToSetting = useSettingLink();
  const flags = $derived(repoConfig.flags(repoPath));
  const lightweight = $derived(repoConfig.repoModeFor(repoPath) === "lightweight");
  const unavailable = m.automation_lightweight_unavailable();
  // Draft needs GitHub's draft PRs; a local-only repo's stored draft has no effect, so you merge.
  const mode = $derived.by((): MergeMode => {
    const held = mergeModeOf({ draftMode: flags.draftMode, autoMergeEnabled: flags.autoMerge });
    return held === "draft" && lightweight ? "manual" : held;
  });
  const options = $derived(
    MERGE_MODES.map((id) => ({
      id,
      label:
        id === "manual"
          ? m.reposettings_merge_mode_manual()
          : id === "draft"
            ? m.reposettings_merge_mode_draft()
            : m.automation_automerge_name(),
      desc:
        id === "manual"
          ? m.reposettings_merge_mode_manual_desc()
          : id === "draft"
            ? m.automation_draftmode_desc()
            : m.automation_automerge_desc(),
      locked: id === "draft" && lightweight ? unavailable : undefined,
    })),
  );
  const signoffAuthority = $derived(repoConfig.signoffAuthorityFor(repoPath));
  const signoffHelp = $derived(
    signoffAuthority === "human"
      ? m.automation_signoff_human_help()
      : signoffAuthority === "critic"
        ? m.automation_signoff_critic_help()
        : m.automation_signoff_either_help(),
  );
  // #3104: a GitHub repo where no workflow runs on pull requests holds autonomous merges.
  const noPrCi = $derived(repoConfig.noPrCiOn(repoPath) && !lightweight);
</script>

<RepoSettingRow
  field="draftMode autoMergeEnabled"
  glyph="↣"
  name={m.reposettings_merge_mode_name()}
  detail={{ id: "auto-merge", text: m.automation_automerge_detail() }}
  coach={armCoachmarks ? "draft-mode" : ""}
>
  {#snippet below()}
    <div class="modes" role="radiogroup" aria-label={m.reposettings_merge_mode_name()}>
      {#each options as opt (opt.id)}
        {@const id = `${groupName}-${opt.id}`}
        <label class={["mode", { on: mode === opt.id, locked: !!opt.locked }]}>
          <input
            type="radio"
            name={groupName}
            value={opt.id}
            checked={mode === opt.id}
            disabled={!!opt.locked}
            aria-labelledby={id}
            aria-describedby={opt.locked ? `${id}-desc ${id}-lock` : `${id}-desc`}
            onchange={() => repoConfig.setMergeMode(repoPath, opt.id)}
          />
          <span class="mode-text">
            <span class="mode-name" {id}>{opt.label}</span>
            <span class="mode-desc" id="{id}-desc">{opt.desc}</span>
            {#if opt.locked}<span class="mode-lock" id="{id}-lock">{opt.locked}</span>{/if}
          </span>
        </label>
      {/each}
    </div>
    {#if mode === "auto" && !flags.autopilot}
      <p class="note warn" role="status">
        ⚠ {m.reposettings_merge_auto_needs_autopilot()}
        <button
          type="button"
          class="goto"
          onclick={(e) => goToSetting(e.currentTarget, "start", "autopilotEnabled")}
          >{m.reposettings_merge_goto_autopilot()}</button
        >
      </p>
    {/if}
  {/snippet}
</RepoSettingRow>
{#if mode === "draft"}
  <RepoSettingRow
    field="signoffAuthority"
    name={m.automation_signoff_authority_label()}
    desc={signoffHelp}
    indent
  >
    {#snippet control()}
      <select
        class="afield-num afield-select"
        aria-label={m.automation_signoff_authority_label()}
        value={signoffAuthority}
        onchange={(e) =>
          repoConfig.setSignoffAuthority(
            repoPath,
            (e.currentTarget as HTMLSelectElement).value as "human" | "critic" | "either",
          )}
      >
        <option value="human">{m.signoff_authority_human()}</option>
        <!-- Critic-reliant authorities are unusable with the Critic off (they could never
             promote a draft → permanent-draft deadlock), so disable them. -->
        <option value="critic" disabled={!flags.critic}>{m.signoff_authority_critic()}</option>
        <option value="either" disabled={!flags.critic}>{m.signoff_authority_either()}</option>
      </select>
    {/snippet}
    {#snippet below()}
      {#if !flags.critic}<p class="note">{m.automation_signoff_needs_critic()}</p>{/if}
    {/snippet}
  </RepoSettingRow>
{/if}
<RepoSettingRow
  field="mergeWithoutCi"
  glyph="⊘"
  name={m.automation_merge_without_ci_name()}
  desc={m.automation_merge_without_ci_desc()}
  locked={lightweight ? unavailable : undefined}
  checked={repoConfig.mergeWithoutCiOn(repoPath) && !lightweight}
  ontoggle={() => repoConfig.toggleMergeWithoutCi(repoPath)}
>
  {#snippet below()}
    {#if noPrCi}<p class="note warn">⚠ {m.reposettings_no_pr_ci_note()}</p>{/if}
  {/snippet}
</RepoSettingRow>
<RepoSettingRow
  field="manualStepsIssueEnabled"
  glyph="☑"
  name={m.automation_manual_steps_issue_name()}
  desc={m.automation_manual_steps_issue_desc()}
  locked={lightweight ? unavailable : undefined}
  checked={repoConfig.manualStepsIssueOn(repoPath) && !lightweight}
  ontoggle={() => repoConfig.toggleManualStepsIssue(repoPath)}
/>
<RepoRolesFields {repoPath} />

<style>
  .note {
    margin: 2px 0 0;
    font-size: var(--fs-meta);
    color: var(--color-faint);
  }
  .note.warn {
    color: var(--color-amber);
  }
  .modes {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 6px;
  }
  /* one option per line: the radio, its name and what it does; amber when chosen */
  .mode {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 5px 8px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    cursor: pointer;
  }
  .mode.on {
    border-color: var(--color-amber);
    background: color-mix(in oklab, var(--color-amber) 10%, transparent);
  }
  .mode.locked {
    cursor: not-allowed;
  }
  .mode input {
    flex: 0 0 auto;
    margin: 2px 0 0;
    accent-color: var(--color-amber);
  }
  .mode-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .mode-name {
    font-size: var(--fs-meta);
    color: var(--color-ink-bright);
  }
  .mode.on .mode-name {
    color: var(--color-amber);
  }
  .mode-desc {
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  /* a locked option dims all but its reason, which stays readable */
  .mode.locked input,
  .mode.locked .mode-name,
  .mode.locked .mode-desc {
    opacity: 0.45;
  }
  .mode-lock {
    font-size: var(--fs-meta);
    color: var(--color-ink);
  }
  .mode:has(input:focus-visible) {
    outline: 1px solid var(--color-amber);
    outline-offset: 1px;
  }
  .goto {
    font: inherit;
    background: transparent;
    border: 0;
    padding: 0;
    color: var(--color-blue);
    cursor: pointer;
  }
  .goto:hover,
  .goto:focus-visible {
    text-decoration: underline;
  }
  @media (pointer: coarse) {
    .mode {
      min-height: 44px;
    }
    .goto {
      min-height: 44px;
    }
  }
</style>
