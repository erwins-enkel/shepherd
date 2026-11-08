<script lang="ts">
  import type { DrainStatus, Session } from "#lib/types.js";
  import type { RepoSettingsSection } from "./sections";
  import AgentSection from "./AgentSection.svelte";
  import StartSection from "./StartSection.svelte";
  import AutomationSchedules from "../automation-settings/AutomationSchedules.svelte";
  import ReviewSection from "./ReviewSection.svelte";
  import MergeSection from "./MergeSection.svelte";
  import EpicsSection from "./EpicsSection.svelte";
  import DisplaySection from "./DisplaySection.svelte";

  // One repo-settings section by id (#3443) — the window renders the active one, the Backlog tab
  // and the first-task confirm all of them in order.
  let {
    section,
    repoPath,
    sessionId,
    planPhase = null,
    drain = null,
    armCoachmarks = false,
  }: {
    section: RepoSettingsSection;
    repoPath: string;
    sessionId?: string;
    planPhase?: Session["planPhase"];
    drain?: DrainStatus | null;
    /** Register the coach-target anchors (sandbox-profile / draft-mode): the window only. */
    armCoachmarks?: boolean;
  } = $props();
</script>

{#if section === "agent"}
  <AgentSection {repoPath} {sessionId} {drain} {armCoachmarks} />
{:else if section === "start"}
  <StartSection {repoPath} {sessionId} {planPhase} {drain} />
{:else if section === "schedules"}
  <AutomationSchedules {repoPath} />
{:else if section === "review"}
  <ReviewSection {repoPath} {sessionId} />
{:else if section === "merge"}
  <MergeSection {repoPath} {armCoachmarks} />
{:else if section === "epics"}
  <EpicsSection {repoPath} />
{:else}
  <DisplaySection {repoPath} />
{/if}
