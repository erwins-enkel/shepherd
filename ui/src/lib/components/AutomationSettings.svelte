<script lang="ts">
  import type { DrainStatus } from "#lib/types.js";
  import { provideOpenDetail } from "./repo-settings/detail-context.svelte.js";
  import { REPO_SETTINGS_SECTIONS, sectionLabel } from "./repo-settings/sections.js";
  import RepoModeChoice from "./repo-settings/RepoModeChoice.svelte";
  import RepoSettingsHints from "./repo-settings/RepoSettingsHints.svelte";
  import RepoSettingsSection from "./repo-settings/RepoSettingsSection.svelte";

  // Every repo setting on one scrolling page (#3443): the Backlog's Automation tab and the
  // first-task confirm. The repo settings window shows the very same sections one at a time.
  let {
    repoPath,
    sessionId,
    drain = null,
    onsetupci,
  }: {
    repoPath: string;
    /** "Open shared browser" opens at this session's dev server. */
    sessionId?: string;
    /** Live drain status for this repo; when drain.epicParent is set, label-drain is suspended. */
    drain?: DrainStatus | null;
    /** Seed a New Task that sets up PR CI for this repo (#3305); absent hides that action. */
    onsetupci?: () => void;
  } = $props();

  provideOpenDetail();
</script>

<div class="mode-row"><RepoModeChoice {repoPath} /></div>
<RepoSettingsHints {repoPath} {drain} {onsetupci} />
{#each REPO_SETTINGS_SECTIONS as section (section)}
  <section class="stack-section" aria-label={sectionLabel(section)}>
    <h3 class="stack-head">{sectionLabel(section)}</h3>
    <RepoSettingsSection {section} {repoPath} {sessionId} {drain} />
  </section>
{/each}

<style>
  .mode-row {
    padding: 8px 12px;
  }
  .stack-head {
    margin: 0;
    font-size: var(--fs-micro);
    font-weight: normal;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--color-amber);
    padding: 12px 12px 4px;
  }
</style>
