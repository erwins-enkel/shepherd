<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { repoConfig } from "#lib/reviews.svelte.js";
  import { epicAutoFix } from "#lib/epic-auto-fix.svelte.js";
  import { repoSettingsWindow } from "#lib/repo-settings-window.svelte.js";
  import { effectiveRepoProvider } from "#lib/repo-cli.js";
  import { repoShortStatus } from "./sections";

  // A repo's short status under "Repo settings …" in the repo tab's and the session row's context
  // menus (#3445): level · CLI · merge mode, then one line per hint the window shows on top — in
  // its words, from the same inputs, so menu and window never disagree.
  let {
    repoPath,
    noPrCiPayload = false,
  }: {
    repoPath: string;
    /** The backlog payload's no-PR-CI hold, read until the repo's config has loaded. */
    noPrCiPayload?: boolean;
  } = $props();

  $effect(() => void repoConfig.ensure(repoPath));
  $effect(() => epicAutoFix.watch(repoPath, repoSettingsWindow.drainFor(repoPath)));

  const line = $derived(
    repoConfig.isConfigLoaded(repoPath)
      ? repoShortStatus({
          cli: effectiveRepoProvider(
            repoConfig.agentProviderFor(repoPath),
            repoSettingsWindow.globals()?.defaultAgentProvider ?? "claude",
          ),
          lightweight: repoConfig.repoModeFor(repoPath) === "lightweight",
          flags: repoConfig.flags(repoPath),
        })
      : "",
  );
  // The window's hint cards, in their order: AutomationNoPrCiHold, then RepoEpicHaltHint.
  const hints = $derived(
    [
      repoConfig.noPrCiHeld(repoPath, noPrCiPayload) ? m.repo_chip_no_pr_ci() : "",
      epicAutoFix.repoHalts(repoPath) > 0 ? m.reposettings_menu_halt_sandbox() : "",
    ].filter(Boolean),
  );
</script>

{#if line || hints.length > 0}
  <span class="rms" data-repo-menu-status>
    {#if line}<span class="rms-line">{line}</span>{/if}
    {#each hints as hint (hint)}
      <span class="rms-hint"><span aria-hidden="true">⚠</span> {hint}</span>
    {/each}
  </span>
{/if}

<style>
  .rms {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .rms-line {
    color: var(--color-muted);
    font-size: var(--fs-micro);
  }
  .rms-hint {
    color: var(--status-warn);
    font-size: var(--fs-micro);
  }
</style>
