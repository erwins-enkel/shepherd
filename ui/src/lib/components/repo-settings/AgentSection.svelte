<script lang="ts">
  import { onMount } from "svelte";
  import { m } from "#lib/paraglide/messages.js";
  import { repoConfig } from "#lib/reviews.svelte.js";
  import { ApiError, getSettings, openRepoBrowser } from "#lib/api.js";
  import { toasts } from "#lib/toasts.svelte.js";
  import {
    browserAllowedHostsExplanation,
    claudeAiConnectorsExplanation,
    egressExtraHostsExplanation,
    egressRiskExplanation,
    egressRiskLabel,
    sharedBrowserExplanation,
  } from "#lib/tooltips/explanations.js";
  import { classifyEgressHost } from "#lib/egress-trust.js";
  import { checkBrowserHost, checkEgressHost } from "#lib/list-entries.js";
  import type { DrainStatus, RepoSandboxSetting, SandboxProfile, Settings } from "#lib/types.js";
  import RepoSettingRow from "./RepoSettingRow.svelte";
  import AgentModelFields from "./AgentModelFields.svelte";
  import ListField, { type ListItemWarning } from "./ListField.svelte";
  import AgentExtensions from "../automation-settings/AgentExtensions.svelte";
  import EgressBlockedHosts from "./EgressBlockedHosts.svelte";
  import { drainSandboxHeld } from "./drain-hold";
  import "../automation-settings/automation-fields.css";

  // Agent environment (#3443): what the repo's agents run with — CLI, model, effort, sandbox,
  // the Shared browser, claude.ai connectors and the plugins/skills they load.
  let {
    repoPath,
    sessionId,
    drain = null,
    globals: given,
    armCoachmarks = false,
  }: {
    repoPath: string;
    /** The task the window was opened from: "Open shared browser" opens at its dev server. */
    sessionId?: string;
    drain?: DrainStatus | null;
    /** The global settings, when the host loaded them; absent = loaded here. */
    globals?: Settings | null;
    armCoachmarks?: boolean;
  } = $props();

  let loaded = $state<Settings | null>(null);
  const globals = $derived(given === undefined ? loaded : given);
  // Fail open while unknown: this is guidance only, and the spawn path still enforces availability.
  const fableAvailable = $derived(globals?.fableAvailable ?? true);
  let openingBrowser = $state(false);

  onMount(() => {
    if (given !== undefined) return;
    getSettings()
      .then((s) => (loaded = s))
      .catch(() => {
        // Fail open, as above.
      });
  });

  const SANDBOX_NAMES: Record<SandboxProfile, () => string> = {
    trusted: m.sandbox_profile_trusted,
    standard: m.sandbox_profile_standard,
    autonomous: m.sandbox_profile_autonomous,
  };
  const PROFILES: SandboxProfile[] = ["trusted", "standard", "autonomous"];
  // "Inherit" names what it resolves to, so the operator sees the effective default.
  const sandboxInheritLabel = $derived.by(() => {
    const d = repoConfig.sandboxDefaultFor(repoPath);
    return d
      ? m.automation_sandbox_inherit({ profile: SANDBOX_NAMES[d]() })
      : m.automation_sandbox_inherit_unresolved();
  });
  const held = $derived(drainSandboxHeld(repoPath, drain));
  const browserOn = $derived(repoConfig.sharedBrowserOn(repoPath));
  // The extra hosts only widen the Autonomous egress firewall; Trusted and Standard don't restrict
  // the network, so the list hides there (its stored hosts stay).
  const autonomous = $derived(repoConfig.effectiveSandboxProfileFor(repoPath) === "autonomous");
  // Blocked hosts (#3922) can come from a task run Autonomous on a repo that defaults otherwise,
  // so either list shows while there are blocks to review.
  let blockedCount = $state(0);
  const showEgress = $derived(autonomous || blockedCount > 0);

  const BROWSER_HOST_ERRORS = {
    empty: () => m.automation_browser_hosts_err_empty(),
    invalid: () => m.automation_browser_hosts_err_invalid(),
    ip: () => m.automation_browser_hosts_err_ip(),
    duplicate: () => m.automation_browser_hosts_err_duplicate(),
  };
  const EGRESS_HOST_ERRORS = {
    empty: () => m.automation_egress_hosts_err_empty(),
    invalid: () => m.automation_egress_hosts_err_invalid(),
    duplicate: () => m.automation_egress_hosts_err_duplicate(),
  };

  /** A risky extra host (#3922) gets a warning: adding it takes "Add anyway", its chip a ⚠. */
  function egressWarning(host: string): ListItemWarning | null {
    const t = classifyEgressHost(host);
    if (t.tier !== "risky") return null;
    const reason = egressRiskLabel(t.reason);
    return {
      text: m.automation_egress_hosts_warn({ reason }),
      label: m.automation_egress_hosts_risky_chip({ host, reason }),
      explanation: egressRiskExplanation(t.reason),
    };
  }

  /** Toast copy for a failed "Open shared browser", keyed by the server's refusal code. */
  function sharedBrowserOpenError(e: unknown): string {
    const code = e instanceof ApiError ? e.code : undefined;
    if (code === "missing-binary") return m.automation_shared_browser_open_missing_binary();
    if (code === "cap") return m.automation_shared_browser_open_cap();
    return m.automation_shared_browser_open_failed();
  }

  async function openSharedBrowser() {
    openingBrowser = true;
    try {
      await openRepoBrowser(repoPath, sessionId);
    } catch (e) {
      toasts.info(sharedBrowserOpenError(e), { alert: true });
    } finally {
      openingBrowser = false;
    }
  }

  /** Flip the connector switch; a flip that restarts sessions says how many, now and later. */
  async function toggleClaudeAiConnectors() {
    const restart = await repoConfig.toggleClaudeAiConnectors(repoPath);
    if (restart && restart.now + restart.later > 0) {
      toasts.info(m.automation_claudeai_connectors_restart_toast(restart));
    }
  }
</script>

<AgentModelFields {repoPath} {fableAvailable} {globals} />

<!-- Sandbox confinement: "inherit" follows the global default (#2100: standard where bwrap works,
     else trusted); auto/drain sessions need autonomous or trusted. -->
<RepoSettingRow
  field="sandboxProfile"
  name={m.automation_sandbox_profile_label()}
  desc={m.automation_sandbox_profile_summary()}
  detail={{
    id: "sandbox",
    paragraphs: [m.automation_sandbox_profile_hint(), m.automation_sandbox_profile_caveats()],
  }}
  warn={m.reposettings_sandbox_drain_held()}
  warnShown={held}
  coach={armCoachmarks ? "sandbox-profile" : ""}
>
  {#snippet control()}
    <select
      class="afield-num afield-select"
      aria-label={m.automation_sandbox_profile_label()}
      value={repoConfig.sandboxProfileFor(repoPath)}
      onchange={(e) =>
        repoConfig.setSandboxProfile(
          repoPath,
          (e.currentTarget as HTMLSelectElement).value as RepoSandboxSetting,
        )}
    >
      <option value="inherit">{sandboxInheritLabel}</option>
      {#each PROFILES as profile (profile)}
        <option value={profile}>{SANDBOX_NAMES[profile]()}</option>
      {/each}
    </select>
  {/snippet}
</RepoSettingRow>
{#if showEgress}
  <ListField
    field="egressExtraHosts"
    name={m.automation_egress_hosts_label()}
    explanation={egressExtraHostsExplanation()}
    items={repoConfig.egressExtraHostsFor(repoPath)}
    check={checkEgressHost}
    errors={EGRESS_HOST_ERRORS}
    placeholder={m.automation_egress_hosts_placeholder()}
    addLabel={m.automation_egress_hosts_add()}
    removeLabel={(host) => m.automation_egress_hosts_remove({ host })}
    empty={m.automation_egress_hosts_empty()}
    hint={m.automation_egress_hosts_hint()}
    warn={egressWarning}
    addAnywayLabel={m.automation_egress_hosts_add_anyway()}
    onchange={(hosts) => repoConfig.setEgressExtraHosts(repoPath, hosts)}
  />
{/if}
<EgressBlockedHosts {repoPath} bind:count={blockedCount} />

<RepoSettingRow
  field="sharedBrowserEnabled"
  glyph="◫"
  name={m.automation_shared_browser_name()}
  explanation={sharedBrowserExplanation()}
  desc={m.automation_shared_browser_desc()}
  checked={browserOn}
  ontoggle={() => repoConfig.toggleSharedBrowser(repoPath)}
>
  {#snippet below()}
    {#if browserOn}
      <button
        class="bs-btn browser-open"
        type="button"
        disabled={openingBrowser}
        onclick={openSharedBrowser}>{m.automation_shared_browser_open()}</button
      >
    {/if}
  {/snippet}
</RepoSettingRow>
<!-- Only meaningful while the Shared browser is on: the allowlist governs its autonomous attaches. -->
{#if browserOn}
  <ListField
    field="browserAllowedHosts"
    name={m.automation_browser_hosts_label()}
    explanation={browserAllowedHostsExplanation()}
    items={repoConfig.browserAllowedHostsFor(repoPath)}
    check={checkBrowserHost}
    errors={BROWSER_HOST_ERRORS}
    placeholder={m.automation_browser_hosts_placeholder()}
    addLabel={m.automation_browser_hosts_add()}
    removeLabel={(host) => m.automation_browser_hosts_remove({ host })}
    empty={m.automation_browser_hosts_empty()}
    hint={m.automation_browser_hosts_hint()}
    onchange={(hosts) => repoConfig.setBrowserAllowedHosts(repoPath, hosts)}
  />
{/if}

<RepoSettingRow
  field="claudeAiConnectorsEnabled"
  glyph="⧉"
  name={m.automation_claudeai_connectors_name()}
  explanation={claudeAiConnectorsExplanation()}
  desc={m.automation_claudeai_connectors_desc()}
  checked={repoConfig.claudeAiConnectorsOn(repoPath)}
  ontoggle={toggleClaudeAiConnectors}
>
  {#snippet below()}
    <p class="note">{m.reposettings_connectors_claude_only()}</p>
  {/snippet}
</RepoSettingRow>
<AgentExtensions {repoPath} />

<style>
  .note {
    margin: 2px 0 0;
    font-size: var(--fs-micro);
    color: var(--color-faint);
  }
  .browser-open {
    margin-top: 6px;
  }
</style>
