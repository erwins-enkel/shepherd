<script lang="ts">
  import { firstSafeHttpUrl } from "#lib/url.js";
  import type {
    DrainRunSummary,
    DrainStatus,
    Epic,
    EpicSummary,
    Issue,
    Steer,
  } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { relativeTimeAgo } from "#lib/format.js";
  import { dataSlot } from "#lib/data-slot.js";
  import { getLocale } from "#lib/i18n.js";
  import { clock } from "#lib/now.svelte.js";
  import { chipFor, epicRole, queuePosition, slotHeldBy, stateLabel } from "../epic-panel";
  import {
    ACTIVE_LABEL,
    activate,
    lastChange,
    stripEpicPrefix,
    type IssueListRow,
  } from "../issues-panel";
  import IssueMenuLayer from "../IssueMenuLayer.svelte";
  import { issueMenuTrigger } from "../issue-menu-trigger";
  import EpicHeaderRow from "./EpicHeaderRow.svelte";

  // The backlog list's rows (#2617), rendered from IssuesPanel's flat row model: epic headers,
  // an expanded epic's child rows, then the "Einzelne Issues" section. Rows are listbox
  // options — the list container (IssuesPanel) owns focus + ↑/↓ via aria-activedescendant, so
  // no row is a tab stop. Single rows keep the right-click / long-press issue menu.
  let {
    rows,
    selectedKey,
    epicSummaries,
    epicFor,
    issueActions,
    runSummary = null,
    drain = null,
    mobile = false,
    running = undefined,
    oninject = undefined,
    onopensession = undefined,
    onopenautomation = undefined,
    onselect,
    ontoggle,
  }: {
    rows: IssueListRow[];
    selectedKey: string | null;
    epicSummaries: Map<number, EpicSummary>;
    epicFor: (n: number) => Epic | undefined;
    issueActions: Steer[];
    /** The repo's run picture (#2620): epic roles and the child holding a slot. */
    runSummary?: DrainRunSummary | null;
    /** The repo's drain — an epic row shows a sandbox, CLI or host halt (#3455) or another hold
     *  with its action (#3457) from it. */
    drain?: DrainStatus | null;
    /** Phone layout: a halt's fix opens as a bottom sheet. */
    mobile?: boolean;
    /** Whether a single issue is being worked (a live session or the claim label). */
    running?: (issue: Issue) => boolean;
    oninject?: (issue: Issue, steer: Steer) => void;
    /** An epic row's hold opens the stuck session (#3457). */
    onopensession?: (sessionId: string) => void;
    /** An epic row's bootstrap hold opens the Automation tab (#3457). */
    onopenautomation?: () => void;
    onselect: (key: string) => void;
    ontoggle: (n: number) => void;
  } = $props();

  /** Meta-line separator — rendered via a variable so its spaces survive Svelte's whitespace
   *  trimming at block and element edges. */
  const SEP = " · ";
  /** Between label chips: invisible in their flex row, but keeps "docs bug" apart for screen
   *  readers and copied text. A variable for the same whitespace-trimming reason as SEP. */
  const GAP = " ";
  /** Label chips a single row shows before folding the rest into "+N". */
  const MAX_CHIPS = 2;
  // The labels the meta line names, except the drain's claim label — a running issue says so
  // with its own "läuft" segment.
  const metaLabels = (issue: Issue) => (issue.labels ?? []).filter((l) => l !== ACTIVE_LABEL);
  // Spelled-out age of the last change ("vor 44 Tagen"), in the UI's locale.
  const metaAge = (issue: Issue) => relativeTimeAgo(lastChange(issue), clock.current, getLocale());

  const firstSingle = $derived(rows.find((r) => r.kind === "single")?.key ?? null);
  // "Einzelne Issues" only separates singles from epics — without an epic it labels nothing.
  const hasEpics = $derived(rows.some((r) => r.kind === "epic"));

  type MenuState = { issue: Issue; x: number; y: number; opener: HTMLElement; canSteer: boolean };
  type DetailsState = { issue: Issue; x: number; y: number; opener: HTMLElement };
  let menu = $state<MenuState | null>(null);
  let details = $state<DetailsState | null>(null);

  function openMenu(issue: Issue, x: number, y: number, node: HTMLElement) {
    menu = { issue, x, y, opener: node, canSteer: oninject != null };
  }
  function showDetails() {
    const d = menu;
    menu = null;
    if (d) details = { issue: d.issue, x: d.x, y: d.y, opener: d.opener };
  }
  function openIssue() {
    const d = menu;
    menu = null;
    const url = firstSafeHttpUrl(d?.issue.url);
    if (url) window.open(url, "_blank", "noopener");
  }
  function pickSteer(steer: Steer) {
    const d = menu;
    menu = null;
    if (d) oninject?.(d.issue, steer);
  }
</script>

{#each rows as row (row.key)}
  {#if row.kind === "epic"}
    <EpicHeaderRow
      issue={row.issue}
      summary={epicSummaries.get(row.issue.number)}
      epic={epicFor(row.issue.number)}
      role={epicRole(runSummary, row.issue.number)}
      position={queuePosition(runSummary, row.issue.number)}
      {drain}
      {mobile}
      {onopensession}
      {onopenautomation}
      expanded={row.expanded}
      selected={row.key === selectedKey}
      optionId={`issue-opt-${row.key}`}
      onselect={() => onselect(row.key)}
      ontoggle={() => ontoggle(row.issue.number)}
    />
  {:else if row.kind === "loading"}
    <div class="child-row loading" role="presentation">{m.common_loading()}</div>
  {:else if row.kind === "child"}
    {@const tone = chipFor(row.child.state).tone}
    {@const slot = slotHeldBy(runSummary, row.child.number)}
    <div
      class="child-row"
      class:selected={row.key === selectedKey}
      id={`issue-opt-${row.key}`}
      role="option"
      aria-selected={row.key === selectedKey}
      tabindex="-1"
      onclick={() => onselect(row.key)}
      onkeydown={(e) => activate(e, () => onselect(row.key))}
    >
      <span
        class="dot dot-{tone}"
        role="img"
        aria-label={stateLabel(row.child.state)}
        title={stateLabel(row.child.state)}
      ></span>
      <span class="child-body">
        <span class="child-line">
          <span class="num">#{row.child.number}</span>
          <span class="title">{stripEpicPrefix(row.child.title, row.parent)}</span>
        </span>
        {#if slot}
          <span class="status">{m.epic_slot_held({ index: slot.index, max: slot.max })}</span>
        {/if}
      </span>
    </div>
  {:else}
    {@const issue = row.issue}
    {@const labels = metaLabels(issue)}
    {@const shown = labels.slice(0, MAX_CHIPS)}
    {@const rest = labels.slice(MAX_CHIPS)}
    {@const age = metaAge(issue)}
    {#if row.key === firstSingle && hasEpics}
      <div class="section-heading" role="presentation">{m.issuespanel_singles_heading()}</div>
    {/if}
    <div
      class="issue-row single-row"
      class:selected={row.key === selectedKey}
      id={`issue-opt-${row.key}`}
      role="option"
      aria-selected={row.key === selectedKey}
      tabindex="-1"
      onclick={() => onselect(row.key)}
      onkeydown={(e) => activate(e, () => onselect(row.key))}
      use:issueMenuTrigger={{ onopen: (x, y, node) => openMenu(issue, x, y, node) }}
    >
      <span class="title issue-title">{issue.title}</span>
      <!-- SEP is a variable on purpose: a literal separator loses its spaces at block/element edges. -->
      <span class="meta"
        >#{issue.number}{#if running?.(issue)}{SEP}<span class="dot dot-running" aria-hidden="true"
          ></span>{m.issuelist_running()}{/if}{#if shown.length}{SEP}<span class="lchips"
            >{#each shown as label, i (label)}{#if i}{GAP}{/if}<span
                class="lchip"
                style:--lc="var(--data-{dataSlot(label)})">{label}</span
              >{/each}{#if rest.length}{GAP}<span class="lchip more" title={rest.join(", ")}
                >+{rest.length}</span
              >{/if}</span
          >{/if}{SEP}<span class="age" title={m.issuelist_age_tip({ age })}>{age}</span></span
      >
    </div>
  {/if}
{/each}

<IssueMenuLayer
  {menu}
  {details}
  steers={issueActions}
  onopenissue={openIssue}
  onshowdetails={showDetails}
  onsteer={pickSteer}
  onclosemenu={() => (menu = null)}
  onclosedetails={() => (details = null)}
/>

<style>
  .child-row,
  .single-row {
    min-width: 0;
    border: 1px solid transparent;
    border-radius: 2px;
    color: var(--color-ink);
    cursor: pointer;
  }
  /* Hover is a bare surface; only the selection carries the bright left edge (#2638), so the
     row under the pointer never reads as the selected one. */
  .child-row:hover,
  .single-row:hover {
    background: var(--color-panel);
  }
  .child-row.selected,
  .single-row.selected {
    background: var(--color-sel);
    box-shadow: inset 2px 0 0 var(--color-ink-bright);
    color: var(--color-ink-bright);
  }
  /* The listbox owns keyboard focus (aria-activedescendant): ring its active row. */
  :global(.issue-options:focus-visible) .child-row.selected,
  :global(.issue-options:focus-visible) .single-row.selected {
    box-shadow:
      inset 2px 0 0 var(--color-ink-bright),
      inset 0 0 0 1px var(--color-amber);
  }

  /* Children hang under their epic header on a leading rail (as in EpicPanel). */
  .child-row {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    margin-left: 12px;
    padding: 3px 8px;
    border-left: 1px solid color-mix(in srgb, var(--status-running) 30%, var(--color-line));
    font-size: var(--fs-meta);
  }
  .child-row.loading {
    color: var(--color-faint);
    cursor: default;
  }

  .dot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--color-muted);
  }
  /* Beside the first text line of a child row (which may wrap below it). */
  .child-row > .dot {
    margin-top: 0.45em;
  }
  .dot-done {
    background: var(--status-done);
  }
  .dot-review {
    background: var(--color-blue);
  }
  .dot-running {
    background: var(--status-running);
  }
  .dot-ready {
    background: var(--color-green);
  }
  .dot-muted {
    background: var(--color-faint);
  }

  .num {
    flex: none;
    color: var(--color-muted);
    font-size: var(--fs-micro);
  }

  /* Titles wrap in full — the list column is narrow and a cut title can't be told apart from
     its neighbour; long unbroken names (branches, paths) break instead of overflowing. */
  .title {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .child-body {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .child-line {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
  }
  .child-line .title {
    flex: 1;
  }

  /* "hält Platz i/m" (#2620) under the title: neutral — the dot beside the number carries the
     state color. */
  .status {
    color: var(--color-faint);
    font-size: var(--fs-micro);
  }

  .section-heading {
    margin-top: 10px;
    padding: 4px 2px;
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }

  .single-row {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 4px 8px;
    font-size: var(--fs-base);
  }
  .meta {
    color: var(--color-faint);
    font-size: var(--fs-micro);
    overflow-wrap: anywhere;
  }
  /* Running marker in the meta line: the child rows' dot, set inline. */
  .meta .dot {
    display: inline-block;
    margin-right: 5px;
    vertical-align: middle;
  }
  /* Label chips: a categorical `--data-N` tint from a stable hash of the name (never a status
     colour, never the forge's) so a label keeps its hue across rows; "+N" stays neutral. */
  .lchips {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 3px;
    vertical-align: middle;
  }
  .lchip {
    padding: 0 5px;
    border-radius: 2px;
    background: color-mix(in oklch, var(--lc) 15%, transparent);
    color: var(--lc);
    line-height: 1.5;
  }
  .lchip.more {
    --lc: var(--color-muted);
  }

  @media (max-width: 768px), (pointer: coarse) {
    .child-row,
    .single-row {
      min-height: var(--mobile-actionbar-hit);
      justify-content: center;
    }
  }
</style>
