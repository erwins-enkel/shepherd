<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { reviews, repoConfig } from "#lib/reviews.svelte.js";
  import RepoSettingRow from "./RepoSettingRow.svelte";

  // Review (#3443): the Critic, what builds on it (auto-address, the smell lens), and the
  // repo-wide critic for PRs no session opened.
  let { repoPath, sessionId }: { repoPath: string; sessionId?: string } = $props();

  const flags = $derived(repoConfig.flags(repoPath));
  const lightweight = $derived(repoConfig.repoModeFor(repoPath) === "lightweight");
  // Switch-pulse is per-task; only meaningful when the window was opened from a session.
  const reviewing = $derived(sessionId ? reviews.isReviewing(sessionId) : false);
</script>

<RepoSettingRow
  field="criticEnabled"
  glyph="⌕"
  name={m.automation_critic_name()}
  desc={m.automation_critic_desc()}
  detail={{ id: "critic", text: m.automation_critic_detail() }}
  checked={flags.critic}
  busy={reviewing}
  ontoggle={() => repoConfig.toggle(repoPath)}
/>
<RepoSettingRow
  field="autoAddressEnabled"
  glyph="◆"
  name={m.automation_autoaddress_name()}
  desc={flags.critic ? m.automation_autoaddress_desc() : m.automation_autoaddress_needs_critic()}
  detail={{ id: "auto-address", text: m.automation_autoaddress_detail() }}
  indent
  disabled={!flags.critic}
  checked={flags.autoAddress && flags.critic}
  ontoggle={() => repoConfig.toggleAutoAddress(repoPath)}
/>
<RepoSettingRow
  field="criticSmellLensEnabled"
  glyph="⚗"
  name={m.automation_smelllens_name()}
  desc={flags.critic ? m.automation_smelllens_desc() : m.automation_smelllens_needs_critic()}
  detail={{ id: "smell-lens", text: m.automation_smelllens_detail() }}
  indent
  disabled={!flags.critic}
  checked={flags.smellLens && flags.critic}
  ontoggle={() => repoConfig.toggleSmellLens(repoPath)}
/>
<RepoSettingRow
  field="criticAllPrs"
  glyph="⌗"
  name={m.automation_allprs_name()}
  desc={m.automation_allprs_desc()}
  detail={{ id: "critic-all-prs", text: m.automation_allprs_detail() }}
  disabled={lightweight}
  disabledTitle={m.automation_lightweight_unavailable()}
  checked={flags.criticAllPrs && !lightweight}
  ontoggle={() => repoConfig.toggleAllPrs(repoPath)}
/>
