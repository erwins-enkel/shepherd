<script lang="ts">
  import { onMount } from "svelte";
  import { m } from "#lib/paraglide/messages.js";
  import { dialog } from "#lib/a11yDialog.js";
  import { basename } from "#lib/basename.js";
  import { repos } from "#lib/repos.svelte.js";
  import { repoConfig } from "#lib/reviews.svelte.js";
  import { epicAutoFix } from "#lib/epic-auto-fix.svelte.js";
  import { schedules } from "#lib/schedules.svelte.js";
  import { DOCS_URL } from "#lib/build-info.js";
  import type { DrainStatus, Session, Settings } from "#lib/types.js";
  import {
    REPO_SETTINGS_SECTIONS,
    sectionLabel,
    sectionSummary,
    type RepoSettingsSection as SectionId,
  } from "./sections";
  import { provideOpenDetail } from "./detail-context.svelte.js";
  import RepoModeChoice from "./RepoModeChoice.svelte";
  import RepoSettingsHints from "./RepoSettingsHints.svelte";
  import RepoSettingsNav, { type NavItem } from "./RepoSettingsNav.svelte";
  import RepoSettingsSection from "./RepoSettingsSection.svelte";
  import { effectiveRepoProvider } from "#lib/repo-cli.js";

  // The repo settings window (#3443): every repo setting in one modal, its sections ordered by how
  // work flows. A rail with each section's short status beside the active section on desktop;
  // full screen with wrapping section chips on a phone. Hints sit above the section, and the
  // section a hint concerns is marked in the rail.
  let {
    repoPath,
    section,
    sessionId,
    planPhase = null,
    drain = null,
    globals = null,
    onsetupci,
    onclose,
  }: {
    repoPath: string;
    /** The section to open at; absent = the first one a hint marks, else the agent environment. */
    section?: SectionId;
    /** The task it was opened from: its review pulse and plan gate show here. */
    sessionId?: string;
    planPhase?: Session["planPhase"];
    /** The repo's live drain: epic mode, the drain's rails, a sandbox-held epic. */
    drain?: DrainStatus | null;
    /** The page's global settings an "inherit" follows; null while they load. */
    globals?: Settings | null;
    /** Seed a New Task that sets up PR CI for this repo (#3305). */
    onsetupci?: () => void;
    onclose: () => void;
  } = $props();

  provideOpenDetail();
  $effect(() => void repoConfig.ensure(repoPath));

  const panelId = $props.id();
  const repoName = $derived(repos.nameFor(repoPath) ?? basename(repoPath));
  const lightweight = $derived(repoConfig.repoModeFor(repoPath) === "lightweight");
  const flagged = $derived<Partial<Record<SectionId, boolean>>>({
    merge: repoConfig.noPrCiHeld(repoPath),
    agent: epicAutoFix.repoHalts(repoPath) > 0,
  });

  // Until the operator picks a section, the default follows the hints as they load in.
  // svelte-ignore state_referenced_locally
  let picked = $state<SectionId | null>(section ?? null);
  const active = $derived(
    picked ?? REPO_SETTINGS_SECTIONS.find((id) => flagged[id]) ?? ("agent" as SectionId),
  );

  const items = $derived<NavItem[]>(
    REPO_SETTINGS_SECTIONS.map((id) => ({
      id,
      label: sectionLabel(id),
      flagged: flagged[id] ?? false,
      summary: sectionSummary(id, {
        cli: effectiveRepoProvider(
          repoConfig.agentProviderFor(repoPath),
          globals?.defaultAgentProvider ?? "claude",
        ),
        sandbox: repoConfig.effectiveSandboxProfileFor(repoPath),
        lightweight,
        flags: repoConfig.flags(repoPath),
        schedules: schedules.listFor(repoPath)?.length ?? null,
        epicStacks: repoConfig.epicStacksOn(repoPath),
        preWarmEpicLandingCi: repoConfig.preWarmEpicLandingCiOn(repoPath),
        pinned: repoConfig.isPinned(repoPath, false),
        hidden: repoConfig.isHidden(repoPath, false),
        previewOpenMode: repoConfig.previewOpenModeFor(repoPath),
      }),
    })),
  );

  $effect(() => void schedules.load(repoPath));

  let card = $state<HTMLDivElement>();
  let pane = $state<HTMLDivElement>();
  // Open on the section's tab, so the arrow keys move between sections right away.
  onMount(() => card?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus());
  // A switched section starts at its top; the focus follows a tab the hints picked.
  $effect(() => {
    void active;
    if (pane) pane.scrollTop = 0;
    if (
      document.activeElement?.getAttribute("role") === "tab" &&
      card?.contains(document.activeElement)
    )
      card.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  });
</script>

<div
  class="overlay"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose();
  }}
>
  <div
    bind:this={card}
    class="card"
    role="dialog"
    aria-modal="true"
    aria-label={m.reposettings_dialog_label({ repo: repoName })}
    use:dialog={{ onclose }}
    data-repo-settings
  >
    <header class="head">
      <div class="title">
        <span class="kicker">{m.reposettings_title()}</span>
        <h2 class="repo">{repoName}</h2>
        <span class="sub">{m.automation_panel_subtitle()}</span>
      </div>
      <div class="mode-slot"><RepoModeChoice {repoPath} armCoachmarks /></div>
      <button type="button" class="x" onclick={onclose} aria-label={m.common_close()}>✕</button>
    </header>
    <div class="body">
      <div class="rail">
        <RepoSettingsNav {items} bind:active={() => active, (id) => (picked = id)} {panelId} />
        <!-- eslint-disable svelte/no-navigation-without-resolve -- external docs URL -->
        <a
          class="guide"
          href={`${DOCS_URL}hands-off-epics/`}
          target="_blank"
          rel="noopener noreferrer">{m.automation_handsoff_hint()}</a
        >
        <!-- eslint-enable svelte/no-navigation-without-resolve -->
      </div>
      <div
        bind:this={pane}
        class="pane"
        role="tabpanel"
        id={panelId}
        aria-labelledby="{panelId}-tab-{active}"
      >
        <RepoSettingsHints {repoPath} {drain} {onsetupci} />
        <RepoSettingsSection
          section={active}
          {repoPath}
          {sessionId}
          {planPhase}
          {drain}
          {globals}
          armCoachmarks
        />
      </div>
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: var(--color-scrim);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 40;
  }
  .card {
    position: relative;
    width: min(820px, 94vw);
    height: min(720px, 88vh);
    border: 1px solid var(--color-line-bright);
    background: var(--color-inset);
    box-shadow: var(--shadow-popover);
    color: var(--color-ink);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px 16px;
    padding: 12px 12px 10px 16px;
    border-bottom: 1px solid var(--color-line);
  }
  .title {
    display: flex;
    flex-direction: column;
    gap: 1px;
    flex: 1 1 auto;
    min-width: 0;
  }
  .kicker {
    font-size: var(--fs-micro);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .repo {
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--fs-base);
    font-weight: normal;
    color: var(--color-ink-bright);
    overflow-wrap: anywhere;
  }
  .sub {
    font-size: var(--fs-meta);
    color: var(--color-faint);
  }
  .x {
    min-width: 32px;
    min-height: 32px;
    border: 0;
    background: transparent;
    color: var(--color-muted);
    font-size: var(--fs-base);
    cursor: pointer;
  }
  .x:hover,
  .x:focus-visible {
    color: var(--color-amber);
    outline: none;
  }
  .body {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
  }
  .rail {
    flex: 0 0 200px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    border-right: 1px solid var(--color-line);
    background: var(--color-panel);
    overflow-y: auto;
  }
  .guide {
    display: block;
    padding: 8px 14px 12px;
    font-size: var(--fs-micro);
    color: var(--color-blue);
    text-decoration: none;
  }
  .guide:hover {
    text-decoration: underline;
  }
  .pane {
    flex: 1 1 auto;
    min-width: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding-bottom: 12px;
  }
  /* Phone: full screen, the chips above the section, one scroller. */
  @media (max-width: 768px) {
    .card {
      width: 100vw;
      height: 100dvh;
      border: 0;
      padding: env(safe-area-inset-top) env(safe-area-inset-right) 0 env(safe-area-inset-left);
    }
    .x {
      order: 1;
      min-width: 44px;
      min-height: 44px;
    }
    /* title and ✕ share the first line, the repo mode takes the second */
    .mode-slot {
      order: 2;
      flex-basis: 100%;
    }
    .body {
      flex-direction: column;
      overflow-y: auto;
      overflow-x: hidden;
    }
    .rail {
      flex: 0 0 auto;
      border-right: 0;
      overflow: visible;
    }
    .guide {
      display: none;
    }
    .pane {
      flex: 0 0 auto;
      overflow: visible;
      padding-bottom: max(12px, env(safe-area-inset-bottom));
    }
  }
</style>
