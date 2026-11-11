<script lang="ts">
  import { tick, type Snippet } from "svelte";
  import { m } from "#lib/paraglide/messages.js";
  import { basename } from "#lib/basename.js";
  import { repos } from "#lib/repos.svelte.js";
  import { repoConfig } from "#lib/reviews.svelte.js";
  import { epicAutoFix } from "#lib/epic-auto-fix.svelte.js";
  import { schedules } from "#lib/schedules.svelte.js";
  import type { DrainStatus, Session, Settings } from "#lib/types.js";
  import {
    REPO_SETTINGS_SECTIONS,
    sectionLabel,
    sectionSummary,
    type RepoSettingsSection as SectionId,
  } from "./sections";
  import { provideOpenDetail } from "./detail-context.svelte.js";
  import { focusSetting, provideSettingLink } from "./setting-link";
  import RepoModeChoice from "./RepoModeChoice.svelte";
  import RepoSettingsHints from "./RepoSettingsHints.svelte";
  import RepoSettingsNav, { type NavItem } from "./RepoSettingsNav.svelte";
  import RepoSettingsSection from "./RepoSettingsSection.svelte";
  import { effectiveRepoProvider } from "#lib/repo-cli.js";

  // Every repo setting (#3443), its sections ordered by how work flows: a rail with each
  // section's short status beside the active section when there is room; wrapping section chips
  // above it, one scroller, when the container is narrow. Hints sit above the section, and the
  // section a hint concerns is marked in the rail. The repo settings window wraps it in a modal
  // ("window"); a session tab embeds it inline ("tab"), and so does the Backlog's Settings tab
  // ("embedded"), whose header already names the repo.
  let {
    repoPath,
    section,
    sessionId,
    planPhase = null,
    drain = null,
    globals = null,
    onsetupci,
    variant = "window",
    headEnd,
  }: {
    repoPath: string;
    /** The section to open at; absent = the first one a hint marks, else Autonomy. */
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
    /** "window" titles itself with a kicker; "tab" sits inline under its own tab label;
     *  "embedded" drops the repo's name too, for a host that shows it already. */
    variant?: "window" | "tab" | "embedded";
    /** Rendered at the end of the head, e.g. the window's ✕. */
    headEnd?: Snippet;
  } = $props();

  // coachTargets keys one node per id: only the window registers its settings' coach targets, so
  // an inline tab open beside it can't steal or (on unmount) drop the window's anchor.
  const coach = $derived(variant === "window");

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
    picked ?? REPO_SETTINGS_SECTIONS.find((id) => flagged[id]) ?? REPO_SETTINGS_SECTIONS[0],
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

  let root = $state<HTMLDivElement>();
  let pane = $state<HTMLDivElement>();
  // A setting's link to another one (#3444): open that section, then focus its row's control.
  provideSettingLink(async (id, field) => {
    picked = id;
    await tick();
    if (root) focusSetting(root, field);
  });
  // A switched section starts at its top; the focus follows a tab the hints picked.
  $effect(() => {
    void active;
    if (pane) pane.scrollTop = 0;
    if (
      document.activeElement?.getAttribute("role") === "tab" &&
      root?.contains(document.activeElement)
    )
      root.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  });
</script>

<div bind:this={root} class="root">
  <header class="head">
    <div class="title">
      {#if variant === "window"}<span class="kicker">{m.reposettings_title()}</span>{/if}
      {#if variant !== "embedded"}<h2 class="repo">{repoName}</h2>{/if}
      <span class="sub">{m.automation_panel_subtitle()}</span>
    </div>
    <div class="mode-slot"><RepoModeChoice {repoPath} armCoachmarks={coach} /></div>
    {@render headEnd?.()}
  </header>
  <div class="body">
    <div class="rail">
      <RepoSettingsNav {items} bind:active={() => active, (id) => (picked = id)} {panelId} />
    </div>
    <div
      bind:this={pane}
      class="pane"
      role="tabpanel"
      id={panelId}
      aria-labelledby="{panelId}-tab-{active}"
    >
      <div class="col">
        <RepoSettingsHints {repoPath} {drain} {onsetupci} />
        <RepoSettingsSection
          section={active}
          {repoPath}
          {sessionId}
          {planPhase}
          {drain}
          {globals}
          armCoachmarks={coach}
        />
      </div>
    </div>
  </div>
</div>

<style>
  .root {
    container-type: inline-size;
    flex: 1 1 auto;
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    color: var(--color-ink);
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
  .body {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
  }
  .rail {
    flex: 0 0 200px;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--color-line);
    background: var(--color-panel);
    overflow-y: auto;
  }
  .pane {
    flex: 1 1 auto;
    min-width: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding-bottom: 12px;
  }
  /* A wide host (the Backlog, a wide session) keeps the window's reading width. */
  .col {
    max-width: 720px;
  }
  /* Narrow (a phone, or a narrow desktop pane): the chips above the section, one scroller. */
  @container (max-width: 640px) {
    /* title and the head's end (✕) share the first line, the repo mode takes the second */
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
    .pane {
      flex: 0 0 auto;
      overflow: visible;
      padding-bottom: max(12px, env(safe-area-inset-bottom));
    }
  }
</style>
