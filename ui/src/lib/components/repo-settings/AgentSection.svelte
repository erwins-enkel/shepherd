<script lang="ts">
  import { onMount } from "svelte";
  import { m } from "#lib/paraglide/messages.js";
  import { repoConfig } from "#lib/reviews.svelte.js";
  import { ApiError, getSettings, openRepoBrowser } from "#lib/api.js";
  import { toasts } from "#lib/toasts.svelte.js";
  import {
    claudeAiConnectorsExplanation,
    sharedBrowserExplanation,
  } from "#lib/tooltips/explanations.js";
  import type { DrainStatus, RepoSandboxSetting, SandboxProfile, Settings } from "#lib/types.js";
  import RepoSettingRow from "./RepoSettingRow.svelte";
  import AgentModelFields from "./AgentModelFields.svelte";
  import BrowserAllowedHosts from "../automation-settings/BrowserAllowedHosts.svelte";
  import AgentExtensions from "../automation-settings/AgentExtensions.svelte";
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
  // "Inherit" names what it resolves to, so the operator sees the effective default.
  const sandboxInheritLabel = $derived.by(() => {
    const d = repoConfig.sandboxDefaultFor(repoPath);
    return d
      ? m.automation_sandbox_inherit({ profile: SANDBOX_NAMES[d]() })
      : m.automation_sandbox_inherit_unresolved();
  });
  const held = $derived(drainSandboxHeld(repoPath, drain));
  const browserOn = $derived(repoConfig.sharedBrowserOn(repoPath));

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
      <option value="trusted">{m.sandbox_profile_trusted()}</option>
      <option value="standard">{m.sandbox_profile_standard()}</option>
      <option value="autonomous">{m.sandbox_profile_autonomous()}</option>
    </select>
  {/snippet}
</RepoSettingRow>

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
<BrowserAllowedHosts {repoPath} />

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
