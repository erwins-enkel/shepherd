<script lang="ts">
  import { listIssues, getEpics, getEpic } from "$lib/api";
  import { steers } from "$lib/steers.svelte";
  import { fitLabels } from "$lib/fit-labels";
  import type { Issue, Steer, EpicSummary, Epic } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { relativeAge } from "$lib/format";
  import { clock } from "$lib/now.svelte";
  import { filterIssues } from "./issues-panel";
  import EpicPanel from "./EpicPanel.svelte";
  import { SvelteSet, SvelteMap } from "svelte/reactivity";
  import { tick } from "svelte";

  // Mirrors ACTIVE_LABEL in src/drain-core.ts — the label the drain stamps on an
  // issue it has claimed (auto session or human-linked task). Highlighted so a
  // claimed issue reads as "already taken" at a glance in the backlog.
  const ACTIVE_LABEL = "shepherd:active";

  let {
    repoPath,
    onnewtask,
    onquick = undefined,
    bodyPreview = false,
    age = false,
    epics = undefined,
    expandEpic = null,
  }: {
    repoPath: string;
    onnewtask: (issue: Issue) => void;
    /** Quick-launch: spawn a session with the picked issue action's prompt + this
     *  issue, skipping the New Task dialog. Omitted → no action buttons are shown. */
    onquick?: (issue: Issue, action: Steer) => void;
    bodyPreview?: boolean;
    age?: boolean;
    /** Live epic record from the store, keyed `${repoPath}#${parentIssueNumber}`.
     *  When present, WS-pushed updates refresh open panels without a re-fetch. */
    epics?: Record<string, Epic>;
    /** When set (e.g. from an EPIC badge click), expand that epic's row and scroll
     *  it into view — used to land the user on a specific epic in the backlog. */
    expandEpic?: number | null;
  } = $props();

  // Issue-scoped steers render as one quick-launch button each on every row.
  const issueActions = $derived(steers.list.filter((s) => s.onIssues));

  let issues = $state<Issue[]>([]);
  let slug = $state<string | null>(null);
  let loading = $state(true);
  let filter = $state("");
  let visibleIssues = $derived(filterIssues(issues, filter));

  // Epic summaries for this repo: number → EpicSummary.
  let epicByNumber = $state<Map<number, EpicSummary>>(new Map());
  // Set of expanded epic issue numbers (SvelteSet for fine-grained reactivity).
  const expanded = new SvelteSet<number>();
  // One-shot fetch cache: issue number → fetched Epic (avoids re-fetching on re-render).
  const fetched = new SvelteMap<number, Epic>();

  $effect(() => {
    const rp = repoPath;
    loading = true;
    filter = "";
    expanded.clear();
    epicByNumber = new Map();
    fetched.clear();
    listIssues(rp)
      .then((r) => {
        if (rp !== repoPath) return;
        slug = r.slug;
        issues = r.issues;
        loading = false;
      })
      .catch(() => {
        loading = false;
      });
    getEpics(rp)
      .then((summaries) => {
        if (rp !== repoPath) return;
        epicByNumber = new Map(summaries.map((s) => [s.parentIssueNumber, s]));
      })
      .catch(() => {
        /* leave empty — epics are an enhancement, not blocking */
      });
  });

  /** Return the live store value for an epic if available, else the cached fetch result. */
  function epicFor(n: number): Epic | undefined {
    return epics?.[`${repoPath}#${n}`] ?? fetched.get(n);
  }

  /** Expand an epic's panel + one-shot fetch its record if the store lacks it. */
  function expandEpicRow(number: number) {
    expanded.add(number);
    // Trigger a one-shot fetch if the live store doesn't have this epic yet.
    if (!epics?.[`${repoPath}#${number}`] && !fetched.has(number)) {
      getEpic(repoPath, number)
        .then((e) => fetched.set(number, e))
        .catch(() => {});
    }
  }

  function toggleEpic(number: number) {
    if (expanded.has(number)) {
      expanded.delete(number);
    } else {
      expandEpicRow(number);
    }
  }

  // Targeted expand+scroll driven by the `expandEpic` prop (e.g. EPIC badge click).
  // The expand fires as soon as a target is set; the scroll waits until the issue
  // row exists in the DOM (issues load async). Both are one-shot per target value.
  let scrolledTo = $state<number | null>(null);
  let appliedExpand = $state<number | null>(null);
  $effect(() => {
    const target = expandEpic;
    if (target == null) {
      appliedExpand = null;
      scrolledTo = null;
      return;
    }
    // Expand exactly once per target value. Keying off `appliedExpand` (NOT the
    // reactive `expanded` membership) means a later user collapse of the targeted
    // epic no longer re-fires this effect into re-expanding it.
    if (target !== appliedExpand) {
      appliedExpand = target;
      if (!expanded.has(target)) expandEpicRow(target);
    }
    // Scroll once the targeted row is actually rendered (its issue is loaded).
    if (target !== scrolledTo && issues.some((i) => i.number === target)) {
      scrolledTo = target;
      tick().then(() => {
        const el = document.getElementById(`epic-issue-row-${target}`);
        el?.scrollIntoView?.({ block: "center", behavior: "smooth" });
      });
    }
  });
</script>

<div class="issues-panel">
  <div class="issues-header">
    {#if slug}{m.issuespanel_title_with_slug({ slug })}{:else}{m.issuespanel_title()}{/if}
  </div>

  <div class="issues-list">
    {#if loading}
      <div class="muted">{m.common_loading()}</div>
    {:else if slug === null}
      <div class="muted">{m.issuespanel_no_host()}</div>
    {:else if issues.length === 0}
      <div class="muted">{m.common_no_open_issues()}</div>
    {:else}
      <input
        class="issue-filter"
        type="search"
        bind:value={filter}
        placeholder={m.issuespanel_filter_placeholder()}
        aria-label={m.issuespanel_filter_placeholder()}
      />
      {#if visibleIssues.length === 0}
        <div class="muted">{m.issuespanel_no_match()}</div>
      {/if}
      {#each visibleIssues as issue (issue.number)}
        {@const epicSummary = epicByNumber.get(issue.number)}
        {@const isEpicParent = !!epicSummary}
        {@const isExpanded = expanded.has(issue.number)}
        <div class="issue-row" id={`epic-issue-row-${issue.number}`}>
          <div class="issue-top">
            <!-- eslint-disable svelte/no-navigation-without-resolve -- external GitHub URL, not an app route -->
            <a
              class="issue-num"
              href={issue.url}
              target="_blank"
              rel="noopener"
              title={m.issuespanel_open_on_github()}>#{issue.number}</a
            >
            <a
              class="issue-title"
              href={issue.url}
              target="_blank"
              rel="noopener"
              title={m.issuespanel_open_on_github()}>{issue.title}</a
            >
            <!-- eslint-enable svelte/no-navigation-without-resolve -->
            {#if epicSummary}
              {@const isNative = epicSummary.source === "native"}
              <button
                class="epic-badge"
                class:expanded={isExpanded}
                type="button"
                aria-expanded={isExpanded}
                aria-label={isNative
                  ? isExpanded
                    ? m.subissues_badge_collapse_aria({ parent: issue.number })
                    : m.subissues_badge_expand_aria({ parent: issue.number })
                  : isExpanded
                    ? m.epic_badge_collapse_aria({ parent: issue.number })
                    : m.epic_badge_expand_aria({ parent: issue.number })}
                onclick={() => toggleEpic(issue.number)}
                >{isNative
                  ? m.subissues_badge({ merged: epicSummary.merged, total: epicSummary.total })
                  : m.epic_badge({ merged: epicSummary.merged, total: epicSummary.total })}</button
              >
            {/if}
          </div>
          {#if bodyPreview && issue.body}
            <div class="body-preview">{issue.body}</div>
          {/if}
          {#if issue.labels.length > 0 || age}
            <div class="label-row">
              {#each issue.labels as label (label)}
                <span
                  class="label-chip"
                  class:active={label === ACTIVE_LABEL}
                  title={label === ACTIVE_LABEL ? m.issuespanel_active_label_title() : undefined}
                  >{label}</span
                >
              {/each}
              {#if age}
                <span class="age-chip">{relativeAge(issue.createdAt, clock.current)}</span>
              {/if}
            </div>
          {/if}
          <!-- fitLabels toggles `compact` when the buttons overflow the row: emoji-
               carrying buttons collapse to their emoji (label stays in title/aria). -->
          <div class="issue-actions" use:fitLabels>
            {#if onquick}
              {#each issueActions as a (a.id)}
                <button
                  class="quick-btn"
                  class:has-emoji={!!a.emoji}
                  disabled={isEpicParent}
                  onclick={() => onquick(issue, a)}
                  aria-label={isEpicParent
                    ? m.issuespanel_task_button_epic_disabled()
                    : m.issuespanel_action_aria({ label: a.label })}
                  title={isEpicParent ? m.issuespanel_task_button_epic_disabled() : a.text}
                  >{#if a.emoji}<span class="act-emoji" aria-hidden="true">{a.emoji}</span
                    >{/if}<span class="act-label">{a.label}</span></button
                >
              {/each}
            {/if}
            <button
              class="task-btn has-emoji"
              disabled={isEpicParent}
              onclick={() => onnewtask(issue)}
              title={isEpicParent ? m.issuespanel_task_button_epic_disabled() : undefined}
              aria-label={isEpicParent
                ? m.issuespanel_task_button_epic_disabled()
                : m.issuespanel_task_button()}
              ><span class="act-emoji" aria-hidden="true">+</span><span class="act-label"
                >{m.issuespanel_task_button()}</span
              ></button
            >
          </div>
          {#if epicSummary && isExpanded}
            {@const e = epicFor(issue.number)}
            {#if e}
              <EpicPanel {repoPath} parent={issue.number} epic={e} />
            {:else}
              <div class="muted">{m.common_loading()}</div>
            {/if}
          {/if}
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .issues-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--color-inset);
    font-family: var(--font-mono);
    overflow: hidden;
  }

  .issues-header {
    padding: 6px 12px;
    font-size: var(--fs-micro);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
    border-bottom: 1px solid var(--color-line);
    flex-shrink: 0;
  }

  .issues-list {
    flex: 1;
    overflow-y: auto;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .issues-list::-webkit-scrollbar {
    width: 4px;
  }
  .issues-list::-webkit-scrollbar-track {
    background: transparent;
  }
  .issues-list::-webkit-scrollbar-thumb {
    background: var(--color-faint);
    border-radius: 2px;
  }

  /* Search field pinned above the scrolling rows — same recipe as the
     command filter in PromptSources (.cmd-filter). */
  .issue-filter {
    position: sticky;
    top: 0;
    z-index: 1;
    flex-shrink: 0;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    color: var(--color-ink-bright);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    padding: 4px 8px;
    border-radius: 2px;
  }

  .issue-filter:focus {
    outline: none;
    border-color: var(--color-line-bright);
  }

  .issue-row {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 7px 8px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    background: var(--color-inset);
  }

  .issue-top {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }

  .issue-num {
    font-size: var(--fs-meta);
    color: var(--color-faint);
    flex-shrink: 0;
    text-decoration: none;
    transition: color 0.12s;
  }

  .issue-num:hover {
    color: var(--color-ink-bright);
  }

  .issue-title {
    flex: 1;
    font-size: var(--fs-base);
    color: var(--color-ink);
    line-height: 1.4;
    word-break: break-word;
    text-decoration: none;
    transition: color 0.12s;
  }

  .issue-title:hover {
    color: var(--color-ink-bright);
  }

  .label-row {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .label-chip {
    font-size: var(--fs-micro);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--color-muted);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    padding: 1px 5px;
  }

  /* shepherd:active — claimed work. Uses the semantic running/in-progress token so a
     taken issue stands out from neutral labels with the same hue as running sessions. */
  .label-chip.active {
    color: var(--status-running);
    border-color: var(--status-running);
    background: color-mix(in srgb, var(--status-running) 14%, transparent);
  }

  .body-preview {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    word-break: break-word;
  }

  .age-chip {
    font-size: var(--fs-micro);
    letter-spacing: 0.1em;
    color: var(--color-faint);
    padding: 1px 0;
  }

  .issue-actions {
    display: flex;
    gap: 6px;
    margin-top: 2px;
    min-width: 0;
    /* Final fallback when even the compact (emoji-only) rendering overflows — e.g.
       several emoji-less actions: scroll instead of clipping. Right-alignment comes
       from the first child's auto margin (NOT justify-content: flex-end, whose
       start-side overflow would be unreachable in a scroll container). */
    overflow-x: auto;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
  }
  .issue-actions::-webkit-scrollbar {
    display: none;
  }
  .issue-actions > :first-child {
    margin-left: auto;
  }
  .issue-actions button {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  /* compact (set by fitLabels on overflow): emoji-carrying buttons shed their label —
     the emoji is the identifier (full label stays in title/aria-label). */
  .issue-actions:global(.compact) .has-emoji .act-label {
    display: none;
  }

  /* Quick-launch: amber-accented to signal it's the fast path that skips the dialog. */
  .quick-btn {
    background: transparent;
    border: 1px solid var(--color-amber);
    border-radius: 2px;
    color: var(--color-amber);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 2px 8px;
    cursor: pointer;
    transition:
      background 0.12s,
      border-color 0.12s,
      color 0.12s;
  }

  .quick-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--color-amber) 14%, transparent);
  }

  /* Epic-parent rows disable quick-launch steers for the same reason +Task is
     disabled: an epic is launched via the epic panel's Start, not by spawning a
     manual session linked to the parent tracking issue (footgun). */
  .quick-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .task-btn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 2px 8px;
    cursor: pointer;
    transition:
      border-color 0.12s,
      color 0.12s;
  }

  .task-btn:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }

  /* Epic-parent rows disable +Task: an epic is launched via the epic panel's Start,
     not by spawning a manual task against the parent tracking issue (footgun). */
  .task-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .muted {
    font-size: var(--fs-base);
    color: var(--color-faint);
    padding: 4px 0;
  }

  /* Epic badge: compact EPIC merged/total pill that toggles the inline EpicPanel.
     Uses the status-running token (amber) — an epic is active/in-progress work.
     .expanded state darkens the fill to signal the panel is open. */
  .epic-badge {
    flex-shrink: 0;
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--status-running);
    background: color-mix(in oklab, var(--status-running) 12%, transparent);
    border: 1px solid var(--status-running);
    border-radius: 2px;
    padding: 1px 5px;
    cursor: pointer;
    transition:
      background 0.12s,
      color 0.12s;
  }

  .epic-badge.expanded,
  .epic-badge:hover {
    background: color-mix(in oklab, var(--status-running) 22%, transparent);
  }

  @media (max-width: 768px) {
    .issues-list {
      -webkit-overflow-scrolling: touch;
    }
    .task-btn,
    .quick-btn {
      min-height: 40px;
      padding: 2px 14px;
    }
  }
</style>
