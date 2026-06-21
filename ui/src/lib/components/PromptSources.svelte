<script lang="ts">
  import { untrack } from "svelte";
  import { getTodo, listIssues, getCommands } from "$lib/api";
  import type { Issue, SlashCommand } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { hideOthers, hideActive, hideSubIssues, ACTIVE_LABEL } from "./issues-panel";
  import { issuesFilter } from "$lib/issues-filter.svelte";
  import IssueFilterPopover from "./IssueFilterPopover.svelte";

  let {
    repoPath,
    onpick,
    onpickissue,
    allowIssues = true,
    epicParents = new Set(),
    nativeSubIssues = new Set(),
    epicsLoaded = false,
  }: {
    repoPath: string;
    onpick: (prompt: string) => void;
    onpickissue: (issue: Issue) => void;
    allowIssues?: boolean;
    epicParents?: Set<number>;
    nativeSubIssues?: Set<number>;
    epicsLoaded?: boolean;
  } = $props();

  let tab = $state<"todo" | "issues" | "commands">("todo");
  let todos = $state<string[]>([]);
  let issues = $state<Issue[]>([]);
  let commands = $state<SlashCommand[]>([]);
  let slug = $state<string | null>(null);
  let viewer = $state<string | null>(null);
  let loading = $state(false);
  // "Mine & unassigned" filter (#824), shared with IssuesPanel via issuesFilter.
  // No-op identity when the chip is hidden (viewer unknown) → fail open. Composed
  // with the viewer-agnostic "hide in progress" filter; the explicit
  // assigneeFiltered intermediate lets each empty state be attributed to the
  // filter that caused it.
  let assigneeFiltered = $derived(hideOthers(issues, viewer, issuesFilter.hideOthers));
  let activeFiltered = $derived(hideActive(assigneeFiltered, issuesFilter.hideActive));
  let visibleIssues = $derived(
    hideSubIssues(
      activeFiltered,
      issuesFilter.hideSubIssues && epicsLoaded,
      nativeSubIssues,
      epicParents,
    ),
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
      visibleIssues.length === 0 &&
      issuesFilter.hideSubIssues &&
      epicsLoaded,
  );
  let filter = $state("");
  let filterInput = $state<HTMLInputElement>();
  // null = TODO.md presence not yet resolved for this repo; hide the tab until known.
  let hasTodo = $state<boolean | null>(null);

  const OPEN_RE = /^\s*-\s\[ \]\s+(.*)$/;

  // ACTIVE_LABEL (imported from ./issues-panel) is surfaced first + highlighted so
  // a taken issue reads as already-being-worked-on, same as the Issues panel.
  // Active-first ordering so the claimed marker survives the 3-chip cap below.
  const orderedLabels = (labels: string[]): string[] =>
    labels.includes(ACTIVE_LABEL)
      ? [ACTIVE_LABEL, ...labels.filter((l) => l !== ACTIVE_LABEL)]
      : labels;

  // Resolve TODO.md eagerly per repo (independent of the active tab) so the To-Do
  // tab is hidden outright when the repo has no TODO.md, and the panel opens on
  // Issues instead of a dead empty To-Do tab.
  $effect(() => {
    const rp = repoPath;
    hasTodo = null;
    todos = [];
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
    const t = tab;
    if (!rp || t === "todo") return; // todo is loaded eagerly above
    loading = true;
    if (t === "commands") {
      getCommands(rp)
        .then((r) => {
          if (rp !== repoPath || t !== tab) return;
          commands = r.commands;
          loading = false;
        })
        .catch(() => {
          if (rp !== repoPath || t !== tab) return;
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
          loading = false;
        })
        .catch(() => {
          if (rp !== repoPath || t !== tab) return;
          slug = null;
          issues = [];
          viewer = null;
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
        {#each filteredCommands as c (c.scope + ":" + c.name)}
          <button class="row" type="button" onclick={() => onpick("/" + c.name + " ")}>
            <span class="row-marker">/</span>
            <span class="cmd-name">{c.name}</span>
            <span class="row-text cmd-desc">{c.description}</span>
            {#if c.scope === "user"}<span class="chip">user</span>{/if}
          </button>
        {/each}
      {/if}
    {:else if allowIssues}
      <!-- Issues path: only reachable when allowIssues. The "issues" tab is
           absent and the no-TODO auto-switch is redirected to Commands when
           !allowIssues, so this branch is provably unreachable in that mode. -->
      {#if slug === null}
        <div class="muted">{m.promptsources_no_github()}</div>
      {:else if issues.length === 0}
        <div class="muted">{m.common_no_open_issues()}</div>
      {:else}
        <div class="ps-filter-bar">
          <IssueFilterPopover showMine={viewer != null} />
        </div>
        {#if allHiddenByAssignee}
          <div class="muted">{m.issues_filter_all_assigned_to_others()}</div>
        {:else if allHiddenByActive}
          <div class="muted">{m.issues_filter_all_in_progress()}</div>
        {:else if allHiddenBySubIssues}
          <div class="muted">{m.issues_filter_all_sub_issues()}</div>
        {/if}
        {#each visibleIssues as i (i.number)}
          {@const ordered = orderedLabels(i.labels)}
          {#if epicParents.has(i.number)}
            <!-- Epic-parent tracking issue: not pickable as a manual task (it would
                 collide with the Epic Runner). Shown disabled with an EPIC tag + hint;
                 epics launch via the epic panel's Start control. -->
            <div class="row row-epic" aria-disabled="true" title={m.promptsources_epic_hint()}>
              <span class="issue-num">#{i.number}</span>
              <span class="row-text">{i.title}</span>
              <span class="chips">
                <span class="chip chip-epic">{m.promptsources_epic_tag()}</span>
                {@render labelChips(ordered)}
              </span>
            </div>
          {:else}
            <button class="row" type="button" onclick={() => onpickissue(i)}>
              <span class="issue-num">#{i.number}</span>
              <span class="row-text">{i.title}</span>
              {#if ordered.length > 0}
                <span class="chips">{@render labelChips(ordered)}</span>
              {/if}
            </button>
          {/if}
        {/each}
      {/if}
    {/if}
  </div>
</div>

{#snippet labelChips(ordered: string[])}
  {#each ordered.slice(0, 1) as lbl (lbl)}
    <span
      class="chip"
      class:active={lbl === ACTIVE_LABEL}
      title={lbl === ACTIVE_LABEL ? m.issuespanel_active_label_title() : undefined}>{lbl}</span
    >
  {/each}
  {#if ordered.length > 1}
    <span class="chip chip-more" title={ordered.slice(1).join(", ")}>
      {m.promptsources_more_labels({ count: ordered.length - 1 })}
    </span>
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

  /* Epic-parent rows are listed but not selectable — muted, no hover affordance. */
  .row-epic {
    color: var(--color-faint);
    cursor: default;
  }

  .row-marker {
    color: var(--color-faint);
    flex-shrink: 0;
    font-size: var(--fs-micro);
  }

  .issue-num {
    color: var(--color-muted);
    flex-shrink: 0;
    font-size: var(--fs-meta);
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
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Single label chip + a "+N" count (labelChips caps inline chips at 1). The group
     is bounded so the title keeps the row instead of being crushed to a character:
     it may shrink (min-width:0), the label chip ellipsates, and the count never clips. */
  .chips {
    display: flex;
    gap: 3px;
    min-width: 0;
    flex-shrink: 1;
  }

  .chip {
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-slate);
    border: 1px solid var(--color-faint);
    border-radius: 2px;
    padding: 0 4px;
    /* Cap a pathologically long single label (e.g. COMPONENT/VALUEMAP…) so it
       truncates instead of pushing the "+N" count off the row. */
    max-width: 14ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* shepherd:active — claimed work. Same semantic running/in-progress token as
     IssuesPanel so a taken issue stands out with the running-session hue.
     The EPIC tag (.chip-epic) shares this hue, matching the backlog epic badge. */
  .chip.active,
  .chip-epic {
    color: var(--status-running);
    border-color: var(--status-running);
    background: color-mix(in srgb, var(--status-running) 14%, transparent);
  }

  .chip-more {
    color: var(--color-muted);
    border-color: transparent;
    cursor: default;
    /* Always visible — the count is the signal that more labels exist, so it must
       never be the thing that gets clipped when the row is tight. */
    flex-shrink: 0;
    max-width: none;
  }
</style>
