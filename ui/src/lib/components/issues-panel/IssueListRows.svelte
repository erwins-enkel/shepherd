<script lang="ts">
  import type { DrainRunSummary, Epic, EpicSummary, Issue, Steer } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { relativeAge } from "#lib/format.js";
  import { clock } from "#lib/now.svelte.js";
  import { chipFor, epicRole, queuePosition, slotHeldBy, stateLabel } from "../epic-panel";
  import { activate, type IssueListRow } from "../issues-panel";
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
    oninject = undefined,
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
    oninject?: (issue: Issue, steer: Steer) => void;
    onselect: (key: string) => void;
    ontoggle: (n: number) => void;
  } = $props();

  // "#12 · label · 3d" — number, first label (when any), age.
  function metaLine(issue: Issue): string {
    const label = issue.labels?.[0];
    const age = relativeAge(issue.createdAt, clock.current);
    return [`#${issue.number}`, ...(label ? [label] : []), age].join(" · ");
  }

  const firstSingle = $derived(rows.find((r) => r.kind === "single")?.key ?? null);

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
    if (d) window.open(d.issue.url, "_blank", "noopener");
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
      <span class="num">#{row.child.number}</span>
      <span class="title">{row.child.title}</span>
      {#if slot}
        <span class="slot">{m.epic_slot_held({ index: slot.index, max: slot.max })}</span>
      {/if}
    </div>
  {:else}
    {@const issue = row.issue}
    {#if row.key === firstSingle}
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
      <span class="meta">{metaLine(issue)}</span>
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
    align-items: center;
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

  /* Two lines before the ellipsis (#2638): the list column is narrow, one line cut most titles. */
  .title {
    flex: 1;
    min-width: 0;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    overflow-wrap: anywhere;
  }

  /* "holds slot i/m" (#2620): neutral — the dot beside the number carries the state color. */
  .slot {
    flex: none;
    padding: 0 5px;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
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
  .single-row .title {
    flex: none;
  }
  .meta {
    overflow: hidden;
    color: var(--color-faint);
    font-size: var(--fs-micro);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @media (max-width: 768px), (pointer: coarse) {
    .child-row,
    .single-row {
      min-height: var(--mobile-actionbar-hit);
      justify-content: center;
    }
  }
</style>
