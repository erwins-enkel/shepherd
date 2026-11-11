<script lang="ts">
  import { onDestroy, onMount, tick, type Snippet } from "svelte";
  import { firstSafeHttpUrl } from "#lib/url.js";
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
  import { providePendingConfig } from "./pending-config-context.svelte.js";
  import { provideOpenDetail } from "./detail-context.svelte.js";
  import { focusSetting, revealSetting, provideSettingLink } from "./setting-link";
  import { searchRepoSettings, type RepoSettingsSearchEntry } from "./search";
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
  providePendingConfig(() => repoConfig.pendingRules[repoPath] ?? null);
  onMount(() => {
    void (repoConfig.isConfigLoaded(repoPath)
      ? repoConfig.reload(repoPath)
      : repoConfig.ensure(repoPath));
  });
  $effect(() => {
    if (!repoConfig.pendingRules[repoPath]) return;
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      void repoConfig.reload(repoPath).finally(() => {
        running = false;
      });
    }, 60_000);
    return () => clearInterval(timer);
  });

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
  let query = $state("");
  let searchInput = $state<HTMLInputElement>();
  const searching = $derived(query.trim().length > 0);
  const results = $derived(searchRepoSettings(query));
  let stopReveal = () => {};
  let navigation = 0;
  onDestroy(() => {
    navigation++;
    stopReveal();
  });

  function selectSection(id: SectionId) {
    navigation++;
    stopReveal();
    query = "";
    picked = id;
  }

  async function openResult(entry: RepoSettingsSearchEntry) {
    stopReveal();
    const current = ++navigation;
    query = "";
    if (entry.section) picked = entry.section;
    await tick();
    if (!root || current !== navigation) return;
    if (focusSetting(root, entry.field)) return;
    if (entry.fallbackField && focusSetting(root, entry.fallbackField)) return;
    stopReveal = revealSetting(root, entry.field, 5000, true);
  }

  // A setting's link to another one (#3444): open that section, then focus its row's control.
  provideSettingLink(async (id, field) => {
    selectSection(id);
    await tick();
    if (root) focusSetting(root, field);
  });
  // A switched section starts at its top; the focus follows a tab the hints picked.
  $effect(() => {
    void active;
    void query;
    if (pane) {
      pane.scrollTop = 0;
      if (searching && pane.parentElement) pane.parentElement.scrollTop = 0;
    }
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
  <div class="search-bar">
    <label for="{panelId}-search">{m.reposettings_search_label()}</label>
    <div class="search-field">
      <input
        bind:this={searchInput}
        id="{panelId}-search"
        type="search"
        bind:value={query}
        oninput={() => {
          navigation++;
          stopReveal();
        }}
      />
      {#if query}
        <button
          type="button"
          class="clear-search"
          onclick={() => {
            query = "";
            searchInput?.focus();
          }}>{m.reposettings_search_clear()}</button
        >
      {/if}
    </div>
  </div>
  <div class="body">
    <div class="rail">
      <RepoSettingsNav {items} bind:active={() => active, selectSection} {panelId} />
    </div>
    <div
      bind:this={pane}
      class="pane"
      role={searching ? "region" : "tabpanel"}
      id={panelId}
      aria-labelledby={searching ? undefined : `${panelId}-tab-${active}`}
      aria-label={searching ? m.reposettings_search_results() : undefined}
    >
      <div class="col">
        <p class="search-status" role="status">
          {#if searching}
            {results.length
              ? m.reposettings_search_count({ count: results.length })
              : m.reposettings_search_empty()}
          {/if}
        </p>
        {#if searching}
          <ul class="search-results">
            {#each results as entry (entry.field)}
              <li>
                <button
                  type="button"
                  class="search-result"
                  onclick={() => openResult(entry)}
                  aria-label={entry.section
                    ? `${entry.name} ${sectionLabel(entry.section)}`
                    : entry.name}
                >
                  <span class="result-name">{entry.name}</span>
                  {#if entry.section}<span class="result-section"
                      >{sectionLabel(entry.section)}</span
                    >{/if}
                  {#if entry.description}<span class="result-desc">{entry.description}</span>{/if}
                </button>
              </li>
            {/each}
          </ul>
        {:else}
          {#if repoConfig.pendingRules[repoPath]}
            <p class="pending-rules" role="status">
              {m.reposettings_pending_summary()}
              <!-- eslint-disable svelte/no-navigation-without-resolve -- external forge PR URL -->
              <a
                href={firstSafeHttpUrl(repoConfig.pendingRules[repoPath]!.url) ?? undefined}
                target="_blank"
                rel="noopener noreferrer"
              >
                {m.reposettings_pending_link({ number: repoConfig.pendingRules[repoPath]!.number })}
              </a>
              <!-- eslint-enable svelte/no-navigation-without-resolve -->
              {#if Object.hasOwn(repoConfig.pendingRules[repoPath]!.changes, "leitrechner")}
                <span
                  >{m.reposettings_pending_leader({
                    value:
                      repoConfig.pendingRules[repoPath]!.changes.leitrechner ??
                      m.reposettings_pending_none(),
                  })}</span
                >
              {/if}
            </p>
          {/if}
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
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  .search-bar {
    padding: 8px 12px;
    border-bottom: 1px solid var(--color-line);
  }
  .search-bar label {
    display: block;
    margin-bottom: 4px;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .search-field {
    display: flex;
    gap: 8px;
  }
  .search-field input {
    flex: 1;
    min-width: 0;
    padding: 8px 10px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    background: var(--color-inset);
    color: var(--color-ink);
    font: inherit;
  }
  .search-field input:focus-visible {
    outline: 1px solid var(--color-line-bright);
  }
  .clear-search {
    padding: 4px 8px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    background: transparent;
    color: var(--color-muted);
    font: inherit;
    font-size: var(--fs-meta);
    cursor: pointer;
  }
  .search-status {
    padding: 8px 12px;
    margin: 0;
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }
  .search-status:empty {
    padding: 0;
  }
  .search-results {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .search-result {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    width: 100%;
    padding: 10px 12px;
    border: 0;
    border-top: 1px solid var(--color-line);
    background: transparent;
    text-align: left;
    color: var(--color-ink);
    font: inherit;
    cursor: pointer;
    overflow-wrap: anywhere;
  }
  .search-result:hover {
    background: var(--color-hover);
  }
  .search-result:focus-visible,
  .clear-search:focus-visible {
    outline: 1px solid var(--color-amber);
    outline-offset: -1px;
  }
  .result-name {
    color: var(--color-ink-bright);
  }
  .result-section,
  .result-desc {
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }
  .result-desc {
    flex-basis: 100%;
  }
  @media (pointer: coarse) {
    .search-field input,
    .clear-search,
    .search-result {
      min-height: 44px;
    }
  }
  .pending-rules {
    margin: 8px 12px;
    font-size: var(--fs-meta);
    color: var(--color-amber);
    overflow-wrap: anywhere;
  }
  .pending-rules a {
    color: inherit;
    text-decoration: underline;
  }
  .pending-rules span {
    display: block;
  }

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
