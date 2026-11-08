<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { repoConfig } from "#lib/reviews.svelte.js";
  import RepoSettingRow from "./RepoSettingRow.svelte";

  // Epics (#3443): how an epic's children land — stacked on their predecessor's branch, and an
  // early draft landing PR that keeps the landing CI warm. Both need GitHub.
  let { repoPath }: { repoPath: string } = $props();

  const lightweight = $derived(repoConfig.repoModeFor(repoPath) === "lightweight");
</script>

<RepoSettingRow
  field="epicStacksEnabled"
  glyph="☰"
  name={m.automation_epic_stacks_name()}
  desc={m.automation_epic_stacks_desc()}
  disabled={lightweight}
  disabledTitle={m.automation_lightweight_unavailable()}
  checked={repoConfig.epicStacksOn(repoPath) && !lightweight}
  ontoggle={() => repoConfig.toggleEpicStacks(repoPath)}
/>
<RepoSettingRow
  field="preWarmEpicLandingCi"
  glyph="☑"
  name={m.automation_prewarm_epic_ci_name()}
  desc={m.automation_prewarm_epic_ci_desc()}
  disabled={lightweight}
  disabledTitle={m.automation_lightweight_unavailable()}
  checked={repoConfig.preWarmEpicLandingCiOn(repoPath) && !lightweight}
  ontoggle={() => repoConfig.togglePreWarmEpicLandingCi(repoPath)}
/>
