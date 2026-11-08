<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { repoConfig } from "#lib/reviews.svelte.js";
  import RepoSettingRow from "./RepoSettingRow.svelte";
  import RepoRolesFields from "./RepoRolesFields.svelte";
  import "../automation-settings/automation-fields.css";

  // Merge (#3443): how a finished PR gets in — as a draft someone signs off, fully automatic, with
  // or without CI — plus the manual-steps issue and who reviews and merges.
  let { repoPath, armCoachmarks = false }: { repoPath: string; armCoachmarks?: boolean } = $props();

  const flags = $derived(repoConfig.flags(repoPath));
  const lightweight = $derived(repoConfig.repoModeFor(repoPath) === "lightweight");
  const unavailable = m.automation_lightweight_unavailable();
  const draftOff = $derived(flags.autoMerge || lightweight);
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
  field="draftMode"
  glyph="□"
  name={m.automation_draftmode_name()}
  desc={flags.autoMerge
    ? m.automation_draftmode_excludes_automerge()
    : m.automation_draftmode_desc()}
  disabled={draftOff}
  disabledTitle={lightweight ? unavailable : m.automation_draftmode_excludes_automerge()}
  checked={flags.draftMode && !draftOff}
  ontoggle={() => repoConfig.toggleDraftMode(repoPath)}
  coach={armCoachmarks ? "draft-mode" : ""}
/>
{#if flags.draftMode}
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
  field="autoMergeEnabled"
  glyph="↣"
  name={m.automation_automerge_name()}
  desc={flags.draftMode
    ? m.automation_draftmode_excludes_automerge()
    : m.automation_automerge_desc()}
  detail={{ id: "auto-merge", text: m.automation_automerge_detail() }}
  disabled={flags.draftMode}
  disabledTitle={m.automation_draftmode_excludes_automerge()}
  checked={flags.autoMerge && !flags.draftMode}
  ontoggle={() => repoConfig.toggleAutoMerge(repoPath)}
/>
<RepoSettingRow
  field="mergeWithoutCi"
  glyph="⊘"
  name={m.automation_merge_without_ci_name()}
  desc={m.automation_merge_without_ci_desc()}
  disabled={lightweight}
  disabledTitle={unavailable}
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
  disabled={lightweight}
  disabledTitle={unavailable}
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
</style>
