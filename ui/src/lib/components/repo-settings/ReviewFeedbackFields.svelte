<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import {
    reviewFeedbackBotsExplanation,
    reviewFeedbackModeExplanation,
  } from "#lib/tooltips/explanations.js";
  import { REVIEW_FEEDBACK_PRESET_BOTS, checkReviewBot } from "#lib/list-entries.js";
  import type { ReviewFeedbackMode } from "#lib/types.js";
  import { useRepoConfig } from "./repo-config-editor.svelte.js";
  import RepoSettingRow from "./RepoSettingRow.svelte";
  import ListField from "./ListField.svelte";
  import "../automation-settings/automation-fields.css";

  // Review feedback (#4126): whether PR comments from people with write access and allowlisted
  // review bots reach the task agent, and which bots count. GitHub only.
  let { repoPath, armCoachmarks = false }: { repoPath: string; armCoachmarks?: boolean } = $props();
  const repoConfig = useRepoConfig();

  const MODES: { value: ReviewFeedbackMode; label: () => string }[] = [
    { value: "off", label: m.reposettings_review_feedback_off },
    { value: "manual", label: m.reposettings_review_feedback_manual },
    { value: "autopilot", label: m.reposettings_review_feedback_autopilot },
    { value: "always", label: m.reposettings_review_feedback_always },
  ];
  const BOT_ERRORS = {
    empty: () => m.reposettings_review_bots_err_empty(),
    invalid: () => m.reposettings_review_bots_err_invalid(),
    duplicate: () => m.reposettings_review_bots_err_duplicate(),
    full: () => m.reposettings_review_bots_err_full(),
  };

  const lightweight = $derived(repoConfig.repoModeFor(repoPath) === "lightweight");
  const mode = $derived(repoConfig.reviewFeedbackModeFor(repoPath));
  const bots = $derived(repoConfig.reviewFeedbackBotsFor(repoPath));
  const isPreset = $derived(
    bots.length === REVIEW_FEEDBACK_PRESET_BOTS.length &&
      REVIEW_FEEDBACK_PRESET_BOTS.every((b) => bots.includes(b)),
  );
</script>

<RepoSettingRow
  field="reviewFeedbackMode"
  glyph="✎"
  name={m.reposettings_review_feedback_name()}
  desc={m.reposettings_review_feedback_desc()}
  explanation={reviewFeedbackModeExplanation()}
  locked={lightweight ? m.automation_lightweight_unavailable() : undefined}
  coach={armCoachmarks ? "review-feedback" : ""}
>
  {#snippet control()}
    <select
      class="afield-num afield-select"
      aria-label={m.reposettings_review_feedback_name()}
      value={mode}
      disabled={lightweight}
      onchange={(e) =>
        repoConfig.setReviewFeedbackMode(
          repoPath,
          (e.currentTarget as HTMLSelectElement).value as ReviewFeedbackMode,
        )}
    >
      {#each MODES as option (option.value)}
        <option value={option.value}>{option.label()}</option>
      {/each}
    </select>
  {/snippet}
</RepoSettingRow>
{#if mode !== "off" && !lightweight}
  <RepoSettingRow
    field="reviewFeedbackBots"
    name={m.reposettings_review_bots_name()}
    explanation={reviewFeedbackBotsExplanation()}
    desc={isPreset ? m.reposettings_review_bots_default() : ""}
    indent
  >
    {#snippet below()}
      <ListField
        field="reviewFeedbackBots"
        name={m.reposettings_review_bots_name()}
        items={bots}
        check={checkReviewBot}
        errors={BOT_ERRORS}
        placeholder={m.reposettings_review_bots_placeholder()}
        addLabel={m.reposettings_review_bots_add()}
        removeLabel={(bot) => m.reposettings_review_bots_remove({ bot })}
        empty={m.reposettings_review_bots_empty()}
        bare
        onchange={(next) => repoConfig.setReviewFeedbackBots(repoPath, next)}
      />
      {#if !isPreset}
        <button
          class="bs-btn reset"
          type="button"
          onclick={() =>
            repoConfig.setReviewFeedbackBots(repoPath, [...REVIEW_FEEDBACK_PRESET_BOTS])}
        >
          {m.reposettings_review_bots_reset()}
        </button>
      {/if}
    {/snippet}
  </RepoSettingRow>
{/if}

<style>
  .reset {
    margin-top: 6px;
  }
</style>
