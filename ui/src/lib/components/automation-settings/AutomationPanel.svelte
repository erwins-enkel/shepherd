<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { m } from "#lib/paraglide/messages.js";
  import type { DrainStatus } from "#lib/types.js";
  import { repoConfig } from "#lib/reviews.svelte.js";
  import { provideOpenDetail } from "../repo-settings/detail-context.svelte.js";
  import { sectionLabel, type RepoSettingsSection as Section } from "../repo-settings/sections.js";
  import RepoModeChoice from "../repo-settings/RepoModeChoice.svelte";
  import RepoSettingsHints from "../repo-settings/RepoSettingsHints.svelte";
  import RepoSettingsSection from "../repo-settings/RepoSettingsSection.svelte";
  import SettingsLayer from "../repo-settings/SettingsLayer.svelte";
  import {
    RepoConfigEditor,
    provideRepoEditor,
    useAutomationLeaveGuard,
  } from "../repo-settings/repo-config-editor.svelte.js";
  import AutomationRulesDialog from "./AutomationRulesDialog.svelte";
  import AutomationLeader from "./AutomationLeader.svelte";
  import InfoTip from "../InfoTip.svelte";
  import { automationLayersExplanation } from "#lib/tooltips/explanations.js";
  let {
    repoPath,
    sessionId,
    drain = null,
    onsetupci,
  }: {
    repoPath: string;
    sessionId?: string;
    drain?: DrainStatus | null;
    onsetupci?: () => void;
  } = $props();
  const editor = new RepoConfigEditor(untrack(() => repoPath));
  provideRepoEditor(editor);
  const leaveGuard = useAutomationLeaveGuard();
  provideOpenDetail();
  const shared: Section[] = ["autonomy", "agent", "start", "review", "merge", "epics"];
  const local: Section[] = ["agent", "start", "schedules", "merge", "display"];
  let confirming = $state(false);
  let error = $state("");
  let preparing = $state(false);
  const cachedOnOpen = untrack(() => repoConfig.isConfigLoaded(repoPath));
  let refreshFailed = $state(false);
  async function load() {
    refreshFailed = !(await editor.reload(repoPath));
  }
  const failed = $derived(
    refreshFailed ||
      (repoConfig.isConfigSettled(repoPath) &&
        (!editor.view || editor.view.repoConfigBranch === undefined)),
  );
  async function review() {
    preparing = true;
    error = "";
    try {
      await editor.prepare();
      confirming = true;
    } catch {
      error = m.automation_layers_load_error();
    } finally {
      preparing = false;
    }
  }
  onMount(() => {
    if (cachedOnOpen) void load();
    else void editor.ensure(repoPath);
    if (leaveGuard) leaveGuard.editor = editor;
    const leave = (e: BeforeUnloadEvent) => {
      if (editor.dirty || editor.saving) e.preventDefault();
    };
    window.addEventListener("beforeunload", leave);
    return () => {
      window.removeEventListener("beforeunload", leave);
      if (leaveGuard?.editor === editor) leaveGuard.editor = null;
    };
  });
</script>

{#snippet sections(items: Section[])}
  {#each items as section (section)}<section aria-label={sectionLabel(section)}>
      <h3>{sectionLabel(section)}</h3>
      <RepoSettingsSection {section} {repoPath} {sessionId} {drain} />
    </section>{/each}
{/snippet}

<RepoSettingsHints {repoPath} {drain} {onsetupci} />
<section data-settings-layer="repo" aria-label={m.automation_layers_shared()}>
  <h2 aria-label={m.automation_layers_shared()}>
    {m.automation_layers_shared()}
    <InfoTip text={automationLayersExplanation()} label={m.automation_layers_explanation_title()} />
  </h2>
  {#if editor.view?.repoConfigCommit}<p class="source">
      <span>.shepherd/config.json</span> · <span>{editor.view.repoConfigCommit}</span>
    </p>
  {:else if editor.view?.repoConfigCommit === null && editor.view.repoConfigBranch !== undefined}<p
      class="source"
    >
      {m.automation_layers_not_shared()}
    </p>{/if}
  {#if failed}<p role="alert">{m.automation_layers_load_error()}</p>
    <button class="gbtn" onclick={load}>{m.automation_layers_retry()}</button>{/if}
  <SettingsLayer layer="repo">
    {@render sections(shared)}
  </SettingsLayer>
  {#if editor.shareable}<div class="actions">
      <button
        class="gbtn primary"
        disabled={preparing || editor.saving || (!editor.dirty && !!editor.view?.repoConfigCommit)}
        onclick={review}
        >{editor.view?.repoConfigCommit
          ? m.automation_layers_review()
          : m.automation_layers_share()}</button
      >
      {#if editor.dirty}<button
          class="gbtn"
          disabled={editor.saving}
          onclick={() => editor.discard()}>{m.automation_layers_discard()}</button
        >{/if}
    </div>{/if}
  {#if error}<p role="alert">{error}</p>{/if}
  {#if editor.view?.notifications?.some((result) => !result.ok)}<p role="status">
      {m.automation_layers_notify()}
    </p>{/if}
</section>
<section data-settings-layer="leader" aria-label={m.automation_layers_leader()}>
  <h2>{m.automation_layers_leader()}</h2>
  <AutomationLeader {editor} {repoPath} />
</section>
<section data-settings-layer="rechner" aria-label={m.automation_layers_local_title()}>
  <h2>
    {m.automation_layers_local_title()}{#if editor.localName}
      · {editor.localName}{/if}
  </h2>
  <p>{m.automation_layers_local()}</p>
  <div class="mode-row"><RepoModeChoice {repoPath} /></div>
  <SettingsLayer layer="rechner">
    {@render sections(local)}
  </SettingsLayer>
</section>
{#if confirming}<AutomationRulesDialog {editor} onclose={() => (confirming = false)} />{/if}

<style>
  h2 {
    margin: 0;
    padding: 14px 12px 6px;
    font-size: var(--fs-lg);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  h3 {
    margin: 0;
    padding: 12px 12px 4px;
    font-size: var(--fs-micro);
    font-weight: normal;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--color-amber);
  }
  p {
    margin: 4px 12px 8px;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    overflow-wrap: anywhere;
  }
  .source span {
    font-family: var(--font-mono);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 12px;
  }
  .mode-row {
    padding: 8px 12px;
  }
</style>
