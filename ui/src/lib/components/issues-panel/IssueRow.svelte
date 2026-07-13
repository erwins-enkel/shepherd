<script lang="ts">
  import type { Issue, Steer, EpicSummary, Epic, DrainStatus } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { fitLabels } from "$lib/fit-labels";
  import { relativeAge } from "$lib/format";
  import { clock } from "$lib/now.svelte";
  import { labelChipStyle } from "$lib/label-color";
  import { ACTIVE_LABEL } from "../issues-panel";
  import { progress } from "../epic-panel";
  import EpicPanel from "../EpicPanel.svelte";
  import IssueMenuLayer from "../IssueMenuLayer.svelte";
  import { issueMenuTrigger } from "../issue-menu-trigger";

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
        onclick={() => ontoggleepic(issue.number)}
        >{isNative
          ? m.subissues_badge({ merged: counts.merged, total: counts.total })
          : m.epic_badge({ merged: counts.merged, total: counts.total })}</button
      >
    {/if}
  </div>
  {#if bodyPreview && issue.body}
    <div class="body-preview">{issue.body}</div>
  {/if}
  {#if issue.labels.length > 0 || age || issue.author || (showAssignees && issue.assignees.length > 0) || (!isEpicParent && issue.blockedBy?.length)}
    <div class="label-row">
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
      {#each issue.labels as label (label)}
        {@const style =
          label !== ACTIVE_LABEL ? labelChipStyle(issue.labelColors?.[label] ?? "") : null}
        <span
          class="label-chip"
          class:active={label === ACTIVE_LABEL}
          class:hued={style !== null}
          {style}
          title={label === ACTIVE_LABEL ? m.issuespanel_active_label_title() : undefined}
          >{label}</span
        >
      {/each}
      {#if issue.author}
        <span class="issue-author">{m.issuerow_author_by({ login: issue.author })}</span>
      {/if}
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
  {#if epicSummary && isExpanded}
    <div data-epic-panel>
      {#if epic}
        <EpicPanel {repoPath} parent={issue.number} {epic} {drain} />
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
    padding: 7px 8px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    background: var(--color-inset);
  }

  /* Epic parent rows stand out from ordinary issues: an amber (--status-running,
     the epic/in-progress semantic) left accent + a faint amber wash. The tint is
     deliberately low (6%) so the accent, the amber EPIC badge, and amber button
     hovers on the same row read as one signal, not three competing ones. The
     2px left border compensates 1px off the left padding to keep text aligned
     with neighbouring non-epic rows. */
  .issue-row.is-epic {
    border-left: 2px solid var(--status-running);
    padding-left: 7px;
    background: color-mix(in oklab, var(--status-running) 6%, var(--color-inset));
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

  /* "blocked on #N" — standalone (non-epic-parent) issues held back by an open dependency.
     Uses the semantic blocked token (red); never green, never a raw hex. Mirrors EpicPanel's
     .deps chip but as its own class since it lives in the label-row, not the epic child list. */
  .blocked-chip {
    font-size: var(--fs-micro);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--status-blocked);
    border: 1px solid var(--status-blocked);
    border-radius: 2px;
    padding: 1px 5px;
    background: color-mix(in srgb, var(--status-blocked) 14%, transparent);
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

  /* shepherd:active — claimed work. Uses the semantic running/in-progress token so a
     taken issue stands out from neutral labels with the same hue as running sessions. */
  .label-chip.active {
    color: var(--status-running);
    border-color: var(--status-running);
    background: color-mix(in srgb, var(--status-running) 14%, transparent);
  }

  /* Real forge label color (issue: labels-almost-invisible) — sanctioned exception to
     "accent hues are semantic, not decorative" (see /design-system). Never coexists with
     .active: labelChipStyle is only computed for non-active labels, so the semantic amber
     rule above always wins where it applies. Vars come from labelChipStyle(); dark is the
     default, [data-theme="light"] overrides. */
  .label-chip.hued {
    color: var(--lc-text-d);
    border-color: var(--lc-border-d);
    background: var(--lc-fill-d);
  }
  :global([data-theme="light"]) .label-chip.hued {
    color: var(--lc-text-l);
    border-color: var(--lc-border-l);
    background: var(--lc-fill-l);
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

  /* Subtle "by {login}" author text — dimmed, no chip border, so it reads as metadata
     alongside the age and distinct from the 👤 assignee chip. Logins are verbatim. */
  .issue-author {
    font-size: var(--fs-micro);
    color: var(--color-faint);
    padding: 1px 0;
    white-space: nowrap;
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
    .task-btn,
    .quick-btn {
      min-height: 40px;
      padding: 2px 14px;
    }
  }
</style>
