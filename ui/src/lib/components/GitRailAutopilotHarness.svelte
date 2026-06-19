<!--
  Test-only harness for GitRail.browser.test.ts.

  Reproduces production's autopilot-flip path faithfully: `autopilotOn` lives in internal
  $state and is flipped LATER via the exported setAutopilot(), mirroring how the live app
  toggles it via a `session:autopilot` WS event with the SAME sessionId. Flipping only this
  one prop — not the whole prop bag — is what isolates the popover-close $effect: GitRail's
  session-reset effect reads `sessionId` only, so it must NOT re-fire here. (vitest-browser-
  svelte's rerender() swaps the entire currentProps object, which incidentally re-runs that
  session-reset effect and closes the popover regardless of the fix — masking the bug. Same
  rationale as TopBarLimitsHarness.)
-->
<script lang="ts">
  import GitRail from "./GitRail.svelte";
  import type { Session, SessionStatus } from "$lib/types";

  let {
    sessionId,
    repoPath = "",
    name = "",
    prompt = "",
    mobile = false,
    ready = false,
    status = "idle",
    showReady = true,
    planPhase = null,
  }: {
    sessionId: string;
    repoPath?: string;
    name?: string;
    prompt?: string;
    mobile?: boolean;
    ready?: boolean;
    status?: SessionStatus;
    showReady?: boolean;
    planPhase?: Session["planPhase"];
  } = $props();

  let autopilotOn = $state(false);

  export function setAutopilot(next: boolean) {
    autopilotOn = next;
  }
</script>

<GitRail
  {sessionId}
  {repoPath}
  {name}
  {prompt}
  {mobile}
  {ready}
  {status}
  {showReady}
  {planPhase}
  {autopilotOn}
/>
