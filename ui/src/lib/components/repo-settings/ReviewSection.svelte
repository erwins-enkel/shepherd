<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { reviews } from "#lib/reviews.svelte.js";
  import { useRepoConfig } from "./repo-config-editor.svelte.js";
  const repoConfig = useRepoConfig();
  import RepoSettingRow from "./RepoSettingRow.svelte";

  // Review (#3443): the Critic, what builds on it (auto-address, the smell lens), and the
  // repo-wide critic for PRs no session opened.
  let { repoPath, sessionId }: { repoPath: string; sessionId?: string } = $props();

  const flags = $derived(repoConfig.flags(repoPath));
  const lightweight = $derived(repoConfig.repoModeFor(repoPath) === "lightweight");
  // Switch-pulse is per-task; only meaningful when the window was opened from a session.
  const reviewing = $derived(sessionId ? reviews.isReviewing(sessionId) : false);
  // #3444: switching the Critic off moved a Draft sign-off that needed it to Human — say so here,
  // the Sign-off select itself sits in the Merge section.
  let signoffReset = $state(false);
</script>

<RepoSettingRow
  field="criticEnabled"
  glyph="⌕"
  name={m.automation_critic_name()}
  desc={m.automation_critic_desc()}
  detail={{ id: "critic", text: m.automation_critic_detail() }}
  warn={m.reposettings_signoff_reset_human()}
  warnShown={signoffReset && !flags.critic}
  checked={flags.critic}
  busy={reviewing}
  ontoggle={async () => (signoffReset = await repoConfig.toggle(repoPath))}
/>
<RepoSettingRow
  field="autoAddressEnabled"
  glyph="◆"
  name={m.automation_autoaddress_name()}
  desc={m.automation_autoaddress_desc()}
  detail={{ id: "auto-address", text: m.automation_autoaddress_detail() }}
  indent
  locked={flags.critic ? undefined : m.automation_autoaddress_needs_critic()}
  checked={flags.autoAddress && flags.critic}
  ontoggle={() => repoConfig.toggleAutoAddress(repoPath)}
/>
<RepoSettingRow
  field="criticSmellLensEnabled"
  glyph="⚗"
  name={m.automation_smelllens_name()}
  desc={m.automation_smelllens_desc()}
  detail={{ id: "smell-lens", text: m.automation_smelllens_detail() }}
  indent
  locked={flags.critic ? undefined : m.automation_smelllens_needs_critic()}
  checked={flags.smellLens && flags.critic}
  ontoggle={() => repoConfig.toggleSmellLens(repoPath)}
/>
<RepoSettingRow
  field="criticAllPrs"
  glyph="⌗"
  name={m.automation_allprs_name()}
  desc={m.automation_allprs_desc()}
  detail={{ id: "critic-all-prs", text: m.automation_allprs_detail() }}
  locked={lightweight ? m.automation_lightweight_unavailable() : undefined}
  checked={flags.criticAllPrs && !lightweight}
  ontoggle={() => repoConfig.toggleAllPrs(repoPath)}
/>
