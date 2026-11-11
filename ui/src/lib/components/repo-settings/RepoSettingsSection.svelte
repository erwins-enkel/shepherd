<script lang="ts">
  import type { DrainStatus, Session, Settings } from "#lib/types.js";
  import type { RepoSettingsSection } from "./sections";
  import AutonomySection from "./AutonomySection.svelte";
  import AgentSection from "./AgentSection.svelte";
  import StartSection from "./StartSection.svelte";
  import AutomationSchedules from "../automation-settings/AutomationSchedules.svelte";
  import ReviewSection from "./ReviewSection.svelte";
  import MergeSection from "./MergeSection.svelte";
  import EpicsSection from "./EpicsSection.svelte";
  import DisplaySection from "./DisplaySection.svelte";

  // One repo-settings section by id (#3443) — RepoSettingsBody renders the active one, wherever
  // it sits: the window, a session's Automation tab, the Backlog's Settings tab.
  let {
    section,
    repoPath,
    sessionId,
    planPhase = null,
    drain = null,
    globals,
    armCoachmarks = false,
  }: {
    section: RepoSettingsSection;
    repoPath: string;
    sessionId?: string;
    planPhase?: Session["planPhase"];
    drain?: DrainStatus | null;
    /** The global settings, when the host loaded them; absent = the agent section loads its own. */
    globals?: Settings | null;
    /** Register the coach-target anchors (sandbox-profile / draft-mode): the window only. */
    armCoachmarks?: boolean;
  } = $props();
</script>

{#if section === "autonomy"}
  <AutonomySection {repoPath} />
{:else if section === "agent"}
  <AgentSection {repoPath} {sessionId} {drain} {globals} {armCoachmarks} />
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
