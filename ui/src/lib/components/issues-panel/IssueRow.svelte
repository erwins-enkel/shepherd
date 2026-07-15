<script lang="ts">
  import type { Issue, Steer, EpicSummary, Epic, DrainStatus } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { fitLabels } from "$lib/fit-labels";
  import { relativeAge } from "$lib/format";
  import { clock } from "$lib/now.svelte";
  import { epicFlagForOthers } from "../issues-panel";
  import { progress } from "../epic-panel";
  import EpicPanel from "../EpicPanel.svelte";
  import IssueMenuLayer from "../IssueMenuLayer.svelte";
  import { issueMenuTrigger } from "../issue-menu-trigger";
  import EpicOthersPill from "./EpicOthersPill.svelte";
  import IssueLabelChips from "../IssueLabelChips.svelte";

  // One backlog issue row, extracted from IssuesPanel so the panel template clears the
  // Tier-1 <template> complexity bar (#855). The row owns all its nested conditionals
  // (epic badge, body preview, labels/age, quick + task actions, inline EpicPanel).
  let {
    issue,
    epicSummary = undefined,
    isExpanded = false,
    epic = undefined,
    repoPath,
    drain = null,
    bodyPreview = false,
    age = false,
    showAssignees = false,
    issueActions,
    onnewtask,
    onquick = undefined,
    oninject = undefined,
    ontoggleepic,
  }: {
    issue: Issue;
    /** Epic summary for this issue (number → EpicSummary), when it parents an epic. */
    epicSummary?: EpicSummary | undefined;
    /** Whether the inline EpicPanel is expanded. */
    isExpanded?: boolean;
    /** Resolved Epic record for the expanded panel (live store value or one-shot fetch). */
    epic?: Epic | undefined;
    repoPath: string;
    /** This repo's live drain status — forwarded to the expanded EpicPanel so it can
     *  surface the hold reason. Null when the drain is disabled / unknown. */
    drain?: DrainStatus | null;
    bodyPreview?: boolean;
    age?: boolean;
    /** Show a chip per assignee login — set only when the "mine & unassigned" filter
     *  isn't hiding others' issues (#824), so the assignee isn't redundant noise. */
    showAssignees?: boolean;
    issueActions: Steer[];
    onnewtask: (issue: Issue) => void;
    onquick?: (issue: Issue, action: Steer) => void;
    /** Inject an issue-scoped steer: open the New Task dialog pre-seeded with the
     *  steer's prompt + this issue attached (does NOT spawn). From the row's
     *  right-click / long-press context menu. Omitted → no steer items in the menu. */
    oninject?: (issue: Issue, steer: Steer) => void;
    ontoggleepic: (number: number) => void;
  } = $props();

  // Right-click / long-press context menu + details preview state. Both carry the
  // issue so <IssueMenuLayer> stays host-agnostic (shared with PromptSources).
  type MenuState = { issue: Issue; x: number; y: number; opener: HTMLElement; canSteer: boolean };
  type DetailsState = { issue: Issue; x: number; y: number; opener: HTMLElement };
  let menu = $state<MenuState | null>(null);
  let details = $state<DetailsState | null>(null);

  // Trigger opener (mouse right-click / touch long-press). Epic-parent rows omit the
  // steer items (canSteer), same footgun guard as the disabled quick-launch/+Task.
  function openMenu(x: number, y: number, node: HTMLElement) {
    menu = { issue, x, y, opener: node, canSteer: !isEpicParent && oninject != null };
  }
  // "Show details" lives inside the menu, so the outside-pointerdown dismiss won't
  // close it — close explicitly and carry the ROW as the popover's opener.
  function showDetails() {
    const d = menu;
    menu = null;
    if (d) details = { issue: d.issue, x: d.x, y: d.y, opener: d.opener };
  }
  function openIssue() {
    menu = null;
    window.open(issue.url, "_blank", "noopener");
  }
  function pickSteer(steer: Steer) {
    menu = null;
    oninject?.(issue, steer);
  }
  function closeMenu() {
    menu = null;
  }
  function closeDetails() {
    details = null;
  }

  // Epic-parent rows disable quick-launch + Task: an epic is launched via the epic
  // panel's Start, not by spawning a manual session against the parent tracking issue.
  const isEpicParent = $derived(!!epicSummary);

  // "Someone else is already working / owns this epic" (#1616): null on non-epic rows and on
  // the operator's own epics (the server excludes the viewer). Drives the collapsed-row pill
  // (EpicOthersPill) + the soft notice next to Start (forwarded to EpicPanel).
  const othersFlag = $derived(epicFlagForOthers(epicSummary));

  // Badge count: prefer the live/fetched Epic's authoritative (native-first) child counts
  // over the list summary, which is markdown-first and can go stale after an epic is
  // restructured (e.g. badge "0/6" while the real state is "3/6"). Mirrors EpicBadge.svelte.
  // Falls back to the summary when no live record exists (idle epic), then to zero.
  const counts = $derived(
    epic
      ? progress(epic.children)
      : epicSummary
        ? { merged: epicSummary.merged, total: epicSummary.total }
        : { merged: 0, total: 0 },
  );

  const interactiveSelector = [
    "a",
    "button",
    "input",
    "select",
    "textarea",
    "summary",
    "[role='button']",
    "[role='link']",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");

  function onRowClick(event: MouseEvent) {
    if (!isEpicParent) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest("[data-epic-panel]")) return;
    if (target.closest(interactiveSelector)) return;
    ontoggleepic(issue.number);
  }

  function epicRowClick(node: HTMLElement) {
    const click = (event: MouseEvent) => onRowClick(event);
    node.addEventListener("click", click);
    return {
      destroy() {
        node.removeEventListener("click", click);
      },
    };
  }
</script>

<div
  class="issue-row"
  class:is-epic={isEpicParent}
  id={`epic-issue-row-${issue.number}`}
  use:epicRowClick
  use:issueMenuTrigger={{ onopen: openMenu }}
>
  <div class="issue-list-row is-interactive issue-main">
    <!-- eslint-disable svelte/no-navigation-without-resolve -- external GitHub URL, not an app route -->
    <a
      class="issue-num issue-list-number"
      href={issue.url}
      target="_blank"
      rel="noopener"
      title={m.issuespanel_open_on_github()}>#{issue.number}</a
    >
    <a
      class="issue-title issue-list-title"
      href={issue.url}
      target="_blank"
      rel="noopener"
      title={m.issuespanel_open_on_github()}>{issue.title}</a
    >
    <!-- eslint-enable svelte/no-navigation-without-resolve -->
    {#if issue.author}
      <span class="issue-list-author">{m.issuerow_author_by({ login: issue.author })}</span>
    {/if}
    {#if !isEpicParent && issue.blockedBy?.length}
      <span class="blocked-chip"
        >{m.issuerow_blocked_on({ deps: issue.blockedBy.map((n) => `#${n}`).join(", ") })}</span
      >
    {/if}
    {#if showAssignees}
      {#each issue.assignees as login (login)}
        <span class="label-chip assignee" title={m.issuerow_assignee_title({ login })}
          ><span class="assignee-glyph" aria-hidden="true">👤</span>{login}</span
        >
      {/each}
    {/if}
    <IssueLabelChips labels={issue.labels} labelColors={issue.labelColors} />
    {#if age}
      <span class="issue-list-meta age-chip">{relativeAge(issue.createdAt, clock.current)}</span>
    {/if}
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
        onclick={() => ontoggleepic(issue.number)}
        >{isNative
          ? m.subissues_badge({ merged: counts.merged, total: counts.total })
          : m.epic_badge({ merged: counts.merged, total: counts.total })}</button
      >
    {/if}
    <!-- Collapsed-row signal that this epic is someone else's. The launch-point reassurance
         ("you can still start") lives in EpicPanel next to Start, the only epic launch path —
         so the row carries just the pill, no duplicate notice. Extracted into a child so the
         tier→copy branching doesn't inflate this row's <template> complexity. -->
    <EpicOthersPill flag={othersFlag} />
    <!-- fitLabels toggles `compact` when the buttons overflow their available
         trailing region: emoji-carrying controls shed the visible label while
         title/aria-label keep the full action name. -->
    <div class="issue-actions issue-list-actions" use:fitLabels>
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
            >{#if a.emoji}<span class="act-emoji" aria-hidden="true">{a.emoji}</span>{/if}<span
              class="act-label">{a.label}</span
            ></button
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
  </div>
  {#if bodyPreview && issue.body}
    <div class="body-preview">{issue.body}</div>
  {/if}
  {#if epicSummary && isExpanded}
    <div data-epic-panel>
      {#if epic}
        <EpicPanel {repoPath} parent={issue.number} {epic} {drain} {othersFlag} />
      {:else}
        <div class="muted">{m.common_loading()}</div>
      {/if}
    </div>
  {/if}
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

<style>
  .issue-row {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }

  .issue-main {
    flex-wrap: wrap;
  }

  /* Epic state is carried by the EPIC/sub-issue badge plus a quiet full-row
     treatment. No colored side stripe: the whole row is one state surface. */
  .issue-row.is-epic .issue-main {
    border-color: color-mix(in srgb, var(--status-running) 35%, var(--color-line));
    background: color-mix(in oklab, var(--status-running) 6%, var(--color-inset));
    cursor: pointer;
  }

  .issue-num {
    color: var(--color-faint);
    transition: color 0.12s;
  }

  .issue-num:hover {
    color: var(--color-ink-bright);
  }

  .issue-title {
    line-height: 1.4;
    transition: color 0.12s;
  }

  .issue-title:hover {
    color: var(--color-ink-bright);
  }

  .label-chip {
    flex: 0 1 auto;
    max-width: 14ch;
    overflow: hidden;
    padding: 1px 5px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.1em;
    text-overflow: ellipsis;
    text-transform: uppercase;
    white-space: nowrap;
  }

  /* "blocked on #N" — standalone (non-epic-parent) issues held back by an open dependency.
     Uses the semantic blocked token (red); never green, never a raw hex. Mirrors EpicPanel's
     .deps chip but as its own class since it lives in the label-row, not the epic child list. */
  .blocked-chip {
    flex: 0 1 auto;
    max-width: 18ch;
    overflow: hidden;
    padding: 1px 5px;
    border: 1px solid var(--status-blocked);
    border-radius: 2px;
    background: color-mix(in srgb, var(--status-blocked) 14%, transparent);
    color: var(--status-blocked);
    font-size: var(--fs-micro);
    letter-spacing: 0.1em;
    text-overflow: ellipsis;
    text-transform: uppercase;
    white-space: nowrap;
  }

  /* Assignee chip — reuses the label-chip recipe but keeps the login verbatim (logins are
     mixed-case, so no uppercasing/letter-spacing) and leads the row with a person glyph.
     Shown only when the "mine & unassigned" filter isn't hiding others' issues (#824). */
  .label-chip.assignee {
    display: inline-flex;
    align-items: baseline;
    gap: 4px;
    text-transform: none;
    letter-spacing: normal;
  }

  .assignee-glyph {
    font-size: var(--fs-micro);
  }

  .body-preview {
    display: -webkit-box;
    margin: 0 10px 4px 42px;
    overflow: hidden;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    line-height: 1.4;
    word-break: break-word;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
  }

  .age-chip {
    letter-spacing: 0.1em;
  }

  .issue-actions {
    flex: 0 1 auto;
    max-width: 45%;
    min-width: 0;
    /* Final fallback when even the compact (emoji-only) rendering overflows — e.g.
       several emoji-less actions: scroll instead of clipping. */
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

  [data-epic-panel] {
    padding-top: 6px;
    border-top: 1px solid var(--color-line);
  }

  @container issue-list-row (max-width: 560px) {
    .issue-actions {
      flex-basis: 100%;
      max-width: 100%;
      padding-left: 42px;
    }
  }

  @media (max-width: 768px), (pointer: coarse) {
    .task-btn,
    .quick-btn {
      min-height: var(--mobile-actionbar-hit);
      padding: 2px 14px;
    }

    .issue-num,
    .issue-title {
      min-height: var(--mobile-actionbar-hit);
      line-height: var(--mobile-actionbar-hit);
    }

    .issue-num {
      min-width: var(--mobile-actionbar-hit);
      text-align: center;
    }
  }
</style>
