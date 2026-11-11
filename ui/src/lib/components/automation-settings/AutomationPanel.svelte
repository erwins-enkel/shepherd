<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { m } from "#lib/paraglide/messages.js";
  import type { DrainStatus, Settings } from "#lib/types.js";
  import { repoConfig } from "#lib/reviews.svelte.js";
  import type { RepoSettingsSection as Section } from "../repo-settings/sections.js";
  import RepoSettingsBody from "../repo-settings/RepoSettingsBody.svelte";
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
  // The Backlog's Settings tab: the repo settings body (#3443), its repository rules staged for
  // one reviewed commit and each section grouped by where its settings live (#3016).
  let {
    repoPath,
    section,
    sessionId,
    drain = null,
    globals = null,
    onsetupci,
  }: {
    repoPath: string;
    /** The section to open at; absent = the body's default. */
    section?: Section;
    sessionId?: string;
    drain?: DrainStatus | null;
    globals?: Settings | null;
    onsetupci?: () => void;
  } = $props();
  const editor = new RepoConfigEditor(untrack(() => repoPath));
  provideRepoEditor(editor);
  const leaveGuard = useAutomationLeaveGuard();
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

<!-- One section at a time, as everywhere (#3443), grouped by where its settings live (#3016). -->
{#snippet layered(active: Section)}
  {#if shared.includes(active)}
    <section data-settings-layer="repo" aria-label={m.automation_layers_shared()}>
      <h2 aria-label={m.automation_layers_shared()}>
        {m.automation_layers_shared()}
        <InfoTip
          text={automationLayersExplanation()}
          label={m.automation_layers_explanation_title()}
        />
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
        <RepoSettingsSection section={active} {repoPath} {sessionId} {drain} {globals} />
      </SettingsLayer>
      {#if editor.shareable}<div class="actions">
          <button
            class="gbtn primary"
            disabled={preparing ||
              editor.saving ||
              (!editor.dirty && !!editor.view?.repoConfigCommit)}
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
  {/if}
  {#if local.includes(active)}
    <section data-settings-layer="rechner" aria-label={m.automation_layers_local_title()}>
      <h2>
        {m.automation_layers_local_title()}{#if editor.localName}
          · {editor.localName}{/if}
      </h2>
      <p>{m.automation_layers_local()}</p>
      <SettingsLayer layer="rechner">
        <RepoSettingsSection section={active} {repoPath} {sessionId} {drain} {globals} />
      </SettingsLayer>
    </section>
  {/if}
{/snippet}

<RepoSettingsBody
  variant="embedded"
  {repoPath}
  {section}
  {sessionId}
  {drain}
  {globals}
  {onsetupci}
  sectionView={layered}
/>
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
</style>
