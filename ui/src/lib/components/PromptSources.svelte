<script lang="ts">
  import { untrack } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { getTodo, listIssues, getCommands } from "$lib/api";
  import type { Issue, SlashCommand, Steer } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import {
    commandInsertable,
    commandInvocation,
    commandInvocationProvider,
    commandProviders,
  } from "$lib/slash";
  import {
    hideOthers,
    hideActive,
    hideSubIssues,
    hideBlockedIssues,
    filterByAuthor,
    filterByLabels,
    distinctAuthors,
    distinctLabels,
    labelColorMap,
  } from "./issues-panel";
  import { issuesFilter } from "$lib/issues-filter.svelte";
  import { viewerCache } from "$lib/viewer-cache.svelte";
  import IssueFilterPopover from "./IssueFilterPopover.svelte";
  import IssueMenuLayer from "./IssueMenuLayer.svelte";
  import { issueMenuTrigger } from "./issue-menu-trigger";
  import { steers } from "$lib/steers.svelte";
  import { repos } from "$lib/repos.svelte";
  import { steerAppliesToRepo } from "$lib/steer-scope";
  import IssueLabelChips from "./IssueLabelChips.svelte";

  let {
    repoPath,
    onpick,
    onpickcommand,
    onpickissue,
    onpicksteer = undefined,
    allowIssues = true,
    agentProvider = "claude",
    epicParents = new Set(),
    nativeSubIssues = new Set(),
    epicsLoaded = false,
  }: {
    repoPath: string;
    onpick: (prompt: string) => void;
    onpickcommand?: (cmd: SlashCommand) => void;
    onpickissue: (issue: Issue) => void;
    /** Inject an issue-scoped steer into the composer (append + attach the issue),
     *  from the row's right-click / long-press context menu. Never spawns. */
    onpicksteer?: (issue: Issue, steer: Steer) => void;
    allowIssues?: boolean;
    agentProvider?: "claude" | "codex";
    epicParents?: Set<number>;
    nativeSubIssues?: Set<number>;
    epicsLoaded?: boolean;
  } = $props();

  // Issue-scoped steers (same set the backlog shows as quick buttons), gated to the
  // steers bound to this repo (or universal ones). Offered as inject actions in the
  // per-row context menu.
  const issueActions = $derived(
    steers.list.filter((s) => s.onIssues && steerAppliesToRepo(s, repos.nameFor(repoPath))),
  );

  // Right-click / long-press context menu + details preview state. Only one of each is
  // open at a time (opening a second requires a pointerdown that dismisses the first).
  let menu = $state<{
    issue: Issue;
    x: number;
    y: number;
    opener: HTMLElement;
    canSteer: boolean;
  } | null>(null);
  let details = $state<{ issue: Issue; x: number; y: number; opener: HTMLElement } | null>(null);

  function openMenu(issue: Issue, canSteer: boolean, x: number, y: number, node: HTMLElement) {
    menu = { issue, x, y, opener: node, canSteer };
  }
  // "Show details" is a menu item (inside the menu), so the outside-pointerdown
  // dismiss won't close the menu — close it explicitly and carry the ROW as the
  // popover's opener so focus returns to the row when the popover closes.
  function showDetails() {
    const d = menu;
    menu = null;
    if (d) details = { issue: d.issue, x: d.x, y: d.y, opener: d.opener };
  }
  function openIssue() {
    const i = menu?.issue;
    menu = null;
    if (i) window.open(i.url, "_blank", "noopener");
  }
  function pickSteer(steer: Steer) {
    const i = menu?.issue;
    menu = null;
    if (i) onpicksteer?.(i, steer);
  }
  function closeMenu() {
    menu = null;
  }
  function closeDetails() {
    details = null;
  }

  let tab = $state<"todo" | "issues" | "commands">("todo");
  let todos = $state<string[]>([]);
  let issues = $state<Issue[]>([]);
  let commands = $state<SlashCommand[]>([]);
  let slug = $state<string | null>(null);
  let viewer = $state<string | null>(null);
  let loading = $state(false);
  // True when the issue fetch failed (rate-limit/unauth/network) rather than the
  // repo genuinely having no open issues — drives a distinct empty state.
  let loadError = $state(false);
  // "Mine & unassigned" filter (#824), shared with IssuesPanel via issuesFilter.
  // No-op identity when the chip is hidden (viewer unknown) → fail open. Composed
  // with the viewer-agnostic "hide in progress" filter; the explicit
  // assigneeFiltered intermediate lets each empty state be attributed to the
  // filter that caused it.
  // Repo-scoped author + label filters (shared UI recipe with IssuesPanel). Selection is
  // local, reset on repo change and pruned on refresh (see the effects below); options are
  // derived from the RAW `issues` list so picking one value doesn't drop the others.
  let selectedAuthor = $state<string | null>(null);
  const selectedLabels = new SvelteSet<string>();
  let availableAuthors = $derived(distinctAuthors(issues));
  let availableLabels = $derived(
    distinctLabels(issues, { excludeBlocked: issuesFilter.hideBlocked }),
  );
  let labelColorsMap = $derived(labelColorMap(issues));
  let assigneeFiltered = $derived(hideOthers(issues, viewer, issuesFilter.hideOthers));
  let activeFiltered = $derived(hideActive(assigneeFiltered, issuesFilter.hideActive));
  // Toggle-filtered set (mine → active → sub-issue), BEFORE the author/label filters.
  // allHiddenBySubIssues keys off this intermediate so its attribution isn't stolen by an
  // author/label miss downstream.
  let subFiltered = $derived(
    hideSubIssues(
      activeFiltered,
      issuesFilter.hideSubIssues && epicsLoaded,
      nativeSubIssues,
      epicParents,
    ),
  );
  // "Hide blocked" filter, applied AFTER the sub-issue filter and BEFORE the author/label
  // filters (mirrors IssuesPanel; see hideBlockedIssues in issues-panel.ts).
  let blockedFiltered = $derived(hideBlockedIssues(subFiltered, issuesFilter.hideBlocked));
  let visibleIssues = $derived(
    filterByLabels(filterByAuthor(blockedFiltered, selectedAuthor), selectedLabels),
  );
  let allHiddenByAssignee = $derived(
    issues.length > 0 && assigneeFiltered.length === 0 && viewer != null && issuesFilter.hideOthers,
  );
  // The active filter emptied the remainder the assignee filter left behind.
  let allHiddenByActive = $derived(
    !allHiddenByAssignee &&
      assigneeFiltered.length > 0 &&
      activeFiltered.length === 0 &&
      issuesFilter.hideActive,
  );
  let allHiddenBySubIssues = $derived(
    !allHiddenByAssignee &&
      !allHiddenByActive &&
      activeFiltered.length > 0 &&
      subFiltered.length === 0 &&
      issuesFilter.hideSubIssues &&
      epicsLoaded,
  );
  // The blocked filter emptied the remainder the sub-issue filter left behind.
  let allHiddenByBlocked = $derived(
    !allHiddenByAssignee &&
      !allHiddenByActive &&
      !allHiddenBySubIssues &&
      subFiltered.length > 0 &&
      blockedFiltered.length === 0 &&
      issuesFilter.hideBlocked,
  );
  let filter = $state("");
  let filterInput = $state<HTMLInputElement>();
  // null = TODO.md presence not yet resolved for this repo; hide the tab until known.
  let hasTodo = $state<boolean | null>(null);

  const OPEN_RE = /^\s*-\s\[ \]\s+(.*)$/;

  // Resolve TODO.md eagerly per repo (independent of the active tab) so the To-Do
  // tab is hidden outright when the repo has no TODO.md, and the panel opens on
  // Issues instead of a dead empty To-Do tab.
  $effect(() => {
    const rp = repoPath;
    hasTodo = null;
    todos = [];
    // Repo-scoped author/label selection resets on repo change (its option sets are
    // repo-specific). Keyed on repoPath here (not the tab/issues fetch), so switching tabs
    // never clears an active filter.
    selectedAuthor = null;
    selectedLabels.clear();
    if (!rp) return;
    getTodo(rp)
      .then((r) => {
        if (rp !== repoPath) return;
        hasTodo = r.exists;
        const matches: string[] = [];
        for (const line of r.content.split("\n")) {
          const match = OPEN_RE.exec(line);
          if (match) matches.push(match[1].trim());
        }
        todos = matches;
        // Don't leave the user on a tab that's about to vanish.
        if (!r.exists) untrack(() => tab === "todo" && (tab = allowIssues ? "issues" : "commands"));
      })
      .catch(() => {
        if (rp !== repoPath) return;
        hasTodo = false;
        todos = [];
        untrack(() => tab === "todo" && (tab = allowIssues ? "issues" : "commands"));
      });
  });

  $effect(() => {
    const rp = repoPath;
    const provider = agentProvider;
    const t = tab;
    if (!rp || t === "todo") return; // todo is loaded eagerly above
    loading = true;
    if (t === "commands") {
      getCommands(rp, { provider })
        .then((r) => {
          if (rp !== repoPath || provider !== agentProvider || t !== tab) return;
          commands = r.commands;
          loading = false;
        })
        .catch(() => {
          if (rp !== repoPath || provider !== agentProvider || t !== tab) return;
          commands = [];
          loading = false;
        });
    } else {
      listIssues(rp)
        .then((r) => {
          if (rp !== repoPath || t !== tab) return;
          slug = r.slug;
          issues = r.issues;
          viewer = r.viewer;
          viewerCache.set(rp, r.viewer);
          loadError = r.error != null;
          loading = false;
        })
        .catch(() => {
          if (rp !== repoPath || t !== tab) return;
          slug = null;
          issues = [];
          viewer = null;
          loadError = true;
          loading = false;
        });
    }
  });

  // Case-insensitive typeahead over name + description (the list spans every
  // installed skill/command, so narrowing is the primary way to find one).
  const filteredCommands = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q),
    );
  });

  // Land the caret in the filter as soon as the Commands tab is ready, so the
  // user can just start typing to narrow. Deps are tab/loading only — typing in
  // the filter doesn't re-run this, so it never steals focus mid-search.
  $effect(() => {
    if (tab === "commands" && !loading) filterInput?.focus();
  });

  // Prune any selected author/label a refresh removed from the current set (mirrors
  // IssuesPanel), so an absent-but-selected value can't keep filtering while its picker
  // entry is gone. Keyed on the option sets (which depend on `issues`, not the selection).
  $effect(() => {
    const authors = availableAuthors;
    const labels = availableLabels;
    untrack(() => {
      if (selectedAuthor != null && !authors.includes(selectedAuthor)) selectedAuthor = null;
      for (const label of [...selectedLabels]) {
        if (!labels.includes(label)) selectedLabels.delete(label);
      }
    });
  });

  /** Author filter: null clears it (radio "All authors"). */
  function pickAuthor(author: string | null) {
    selectedAuthor = author;
  }

  /** Label filter: toggle a label in/out of the AND-set. */
  function toggleLabel(label: string) {
    if (selectedLabels.has(label)) selectedLabels.delete(label);
    else selectedLabels.add(label);
  }

  function providerBadge(cmd: SlashCommand): string {
    const providers = commandProviders(cmd);
    if (providers.length > 1) return m.provider_badge_both();
    return providers[0] === "codex" ? m.provider_badge_codex() : m.provider_badge_claude();
  }

  function marker(cmd: SlashCommand): string {
    const provider = commandInvocationProvider(cmd, agentProvider);
    if (!commandInsertable(cmd, provider)) return "@";
    return provider === "claude" ? "/" : "$";
  }

  function commandRowClass(cmd: SlashCommand): string {
    const provider = commandInvocationProvider(cmd, agentProvider);
    return commandInsertable(cmd, provider) ? "row" : "row disabled";
  }

  function pickCommand(cmd: SlashCommand) {
    const provider = commandInvocationProvider(cmd, agentProvider);
    if (!commandInsertable(cmd, provider)) return;
    if (onpickcommand) onpickcommand(cmd);
    else onpick(commandInvocation(cmd, provider) + " ");
  }
</script>

<div class="ps-wrap">
  <div class="ps-head">
    <span class="micro seed-label">{m.promptsources_title()}</span>
    <div class="tabs">
      {#if hasTodo}
        <button
          class="tab"
          class:active={tab === "todo"}
          type="button"
          onclick={() => (tab = "todo")}
        >
          {m.promptsources_todo_tab()}
        </button>
      {/if}
      {#if allowIssues}
        <button
          class="tab"
          class:active={tab === "issues"}
          type="button"
          onclick={() => (tab = "issues")}
        >
          {m.promptsources_issues_tab()}
        </button>
      {/if}
      <button
        class="tab"
        class:active={tab === "commands"}
        type="button"
        onclick={() => (tab = "commands")}
      >
        {m.promptsources_commands_tab()}
      </button>
    </div>
  </div>

  <div class="ps-body">
    {#if loading || (tab === "todo" && hasTodo === null)}
      <div class="muted">{m.common_loading()}</div>
    {:else if tab === "todo"}
      {#if todos.length === 0}
        <div class="muted">{m.promptsources_no_todos()}</div>
      {:else}
        {#each todos as text (text)}
          <button class="row" type="button" onclick={() => onpick(text)}>
            <span class="row-marker">□</span>
            <span class="row-text">{text}</span>
          </button>
        {/each}
      {/if}
    {:else if tab === "commands"}
      <div class="ps-filter-bar">
        <input
          class="cmd-filter"
          type="text"
          bind:this={filterInput}
          bind:value={filter}
          placeholder={m.promptsources_commands_filter()}
          aria-label={m.promptsources_commands_filter()}
        />
      </div>
      {#if filteredCommands.length === 0}
        <div class="muted">{m.promptsources_no_commands()}</div>
      {:else}
        {#each filteredCommands as c (c.id ?? c.scope + ":" + c.name)}
          <button
            class={commandRowClass(c)}
            type="button"
            disabled={!commandInsertable(c, commandInvocationProvider(c, agentProvider))}
            onclick={() => pickCommand(c)}
          >
            <span class="row-marker">{marker(c)}</span>
            <span class="cmd-name">{c.name}</span>
            <span class="row-text cmd-desc">{c.description}</span>
            <span class="chip">{providerBadge(c)}</span>
            {#if c.scope === "user"}<span class="chip">user</span>{/if}
          </button>
        {/each}
      {/if}
    {:else if allowIssues}
      <!-- Issues path: only reachable when allowIssues. The "issues" tab is
           absent and the no-TODO auto-switch is redirected to Commands when
           !allowIssues, so this branch is provably unreachable in that mode. -->
      {#if loadError}
        <div class="muted">{m.common_issues_load_failed()}</div>
      {:else if slug === null}
        <div class="muted">{m.promptsources_no_github()}</div>
      {:else if issues.length === 0}
        <div class="muted">{m.common_no_open_issues()}</div>
      {:else}
        <div class="ps-filter-bar">
          <IssueFilterPopover
            showMine={viewer != null}
            authors={availableAuthors}
            labels={availableLabels}
            labelColors={labelColorsMap}
            {selectedAuthor}
            selectedLabels={[...selectedLabels]}
            onauthor={pickAuthor}
            ontogglelabel={toggleLabel}
          />
        </div>
        {#if allHiddenByAssignee}
          <div class="muted">{m.issues_filter_all_assigned_to_others()}</div>
        {:else if allHiddenByActive}
          <div class="muted">{m.issues_filter_all_in_progress()}</div>
        {:else if allHiddenBySubIssues}
          <div class="muted">{m.issues_filter_all_sub_issues()}</div>
        {:else if allHiddenByBlocked}
          <div class="muted">{m.issues_filter_all_blocked()}</div>
        {:else if visibleIssues.length === 0}
          <!-- Author/label filters emptied the list (no text search on this tab). -->
          <div class="muted">{m.issues_filter_no_match()}</div>
        {/if}
        {#each visibleIssues as i (i.number)}
          {#if epicParents.has(i.number)}
            <!-- Epic-parent tracking issue: not pickable as a manual task (it would
                 collide with the Epic Runner). Shown disabled with an EPIC tag + hint;
                 epics launch via the epic panel's Start control. -->
            <div
              class="issue-list-row issue-source-row row-epic"
              aria-disabled="true"
              title={m.promptsources_epic_hint()}
              use:issueMenuTrigger={{ onopen: (x, y, node) => openMenu(i, false, x, y, node) }}
            >
              <span class="issue-list-number">#{i.number}</span>
              <span class="issue-list-title">{i.title}</span>
              {@render issueAuthor(i.author)}
              <span class="source-epic-tag">{m.promptsources_epic_tag()}</span>
              <IssueLabelChips labels={i.labels} labelColors={i.labelColors} />
            </div>
          {:else}
            <button
              class="issue-list-row is-interactive issue-source-row"
              type="button"
              onclick={() => onpickissue(i)}
              use:issueMenuTrigger={{
                onopen: (x, y, node) => openMenu(i, onpicksteer != null, x, y, node),
              }}
            >
              <span class="issue-list-number">#{i.number}</span>
              <span class="issue-list-title">{i.title}</span>
              {@render issueAuthor(i.author)}
              <IssueLabelChips labels={i.labels} labelColors={i.labelColors} />
            </button>
          {/if}
        {/each}
      {/if}
    {/if}
  </div>
</div>

<IssueMenuLayer
  {menu}
  {details}
  steers={issueActions}
  onopenissue={openIssue}
  onshowdetails={showDetails}
  onsteer={pickSteer}
  onclosemenu={closeMenu}
  onclosedetails={closeDetails}
/>

{#snippet issueAuthor(login: string | undefined)}
  {#if login}
    <span class="issue-list-author">{m.issuerow_author_by({ login })}</span>
  {/if}
{/snippet}

<style>
  .ps-wrap {
    border: 1px solid var(--color-line);
    border-radius: 2px;
    background: var(--color-inset);
    margin-top: 4px;
  }

  .ps-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 8px 4px;
    /* Breathing room below the header divider lives here — OUTSIDE the scroll
       area — not as .ps-body top padding (which would let a scrolled row bleed
       above the sticky filter bar). */
    margin-bottom: 4px;
    border-bottom: 1px solid var(--color-line);
  }

  .seed-label {
    font-size: var(--fs-micro);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-faint);
    flex-shrink: 0;
  }

  .micro {
    font-family: var(--font-mono);
  }

  .tabs {
    display: flex;
    gap: 2px;
    margin-left: auto;
  }

  .tab {
    background: transparent;
    border: 1px solid transparent;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    padding: 2px 8px;
    border-radius: 2px;
    cursor: pointer;
    transition:
      color 0.12s,
      border-color 0.12s;
  }

  .tab:hover {
    color: var(--color-ink);
  }

  .tab.active {
    color: var(--color-amber);
    border-color: var(--color-amber);
  }

  .ps-body {
    max-height: 180px;
    overflow-y: auto;
    /* No top padding: it sits inside the scroll area and constrains the sticky
       filter bar to pin below it, leaving a band where a scrolled row bleeds
       above the bar. The top gap lives on .ps-head instead. */
    padding: 0 2px 4px;
    display: flex;
    flex-direction: column;
  }

  .ps-body::-webkit-scrollbar {
    width: 3px;
  }
  .ps-body::-webkit-scrollbar-track {
    background: transparent;
  }
  .ps-body::-webkit-scrollbar-thumb {
    background: var(--color-faint);
    border-radius: 2px;
  }

  .muted {
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    color: var(--color-faint);
    padding: 6px 10px;
  }

  .row {
    display: flex;
    align-items: baseline;
    gap: 6px;
    background: transparent;
    border: none;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--fs-base);
    text-align: left;
    padding: 4px 10px;
    cursor: pointer;
    border-radius: 2px;
    transition:
      background 0.1s,
      color 0.1s;
    width: 100%;
  }

  .row:hover {
    background: var(--color-panel);
    color: var(--color-ink-bright);
  }

  .row.disabled {
    color: var(--color-faint);
    cursor: default;
  }

  .row.disabled:hover {
    background: transparent;
    color: var(--color-faint);
  }

  .row-marker {
    color: var(--color-faint);
    flex-shrink: 0;
    font-size: var(--fs-micro);
  }

  /* Epic-parent rows are listed but not selectable. Their amber EPIC badge is
     the state signal; the row itself stays quiet and has no hover affordance. */
  .row-epic {
    cursor: default;
  }

  .row-epic .issue-list-number,
  .row-epic .issue-list-title {
    color: var(--color-faint);
  }

  .source-epic-tag {
    flex: none;
    padding: 0 4px;
    border: 1px solid var(--status-running);
    border-radius: 2px;
    background: color-mix(in srgb, var(--status-running) 14%, transparent);
    color: var(--status-running);
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  /* Search input fills the sticky .ps-filter-bar wrapper (which provides the
     sticky behaviour + full-width opaque coverage + 12px inset). */
  .cmd-filter {
    flex: 1;
    min-width: 0;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    color: var(--color-ink-bright);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    padding: 4px 8px;
    border-radius: 2px;
  }

  .cmd-filter:focus {
    outline: none;
    border-color: var(--color-line-bright);
  }

  /* Sticky bar pinned above the scrolling rows — hosts the IssueFilterPopover
     "Filters" trigger (Issues tab) and the search input (Commands tab). It reaches
     the full scroll width via the flex-column .ps-body's `align-items: stretch` (no
     explicit width here) — KEEP it a direct flex child of .ps-body, or scrolled
     rows bleed past its sides. The 0 10px padding (+ .ps-body's 2px) insets the
     trigger/input to 12px, matching the rows' text. */
  .ps-filter-bar {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    margin: 0 0 4px;
    padding: 0 10px;
    background: var(--color-inset);
  }

  .cmd-name {
    color: var(--color-ink-bright);
    flex-shrink: 0;
  }

  .cmd-desc {
    color: var(--color-faint);
  }

  .row-text {
    flex: 1;
    /* Keep To-Do and command descriptions readable beside their fixed markers. */
    min-width: 6rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chip {
    /* Commands-tab scope marker (for example "user"). Issue labels use the
       shared IssueLabelChips component instead. */
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-slate);
    border: 1px solid var(--color-faint);
    border-radius: 2px;
    padding: 0 4px;
    max-width: 14ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
