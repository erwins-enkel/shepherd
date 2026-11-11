<script lang="ts">
  import type { DrainStatus, Epic, EpicSummary, Issue } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { chipFor, progress, sandboxHaltedEpic, type EpicRole } from "../epic-panel";
  import { activate } from "../issues-panel";
  import { drainHold } from "../epic-hold";
  import EpicRoleBadge from "./EpicRoleBadge.svelte";
  import EpicRowHalt from "./EpicRowHalt.svelte";
  import EpicHoldLine from "./EpicHoldLine.svelte";

  // Compact epic header of the backlog list (#2617), two lines: chevron, number and the wrapping
  // title on top; below it the role badge, a segmented progress bar and "m/n". Segments are per
  // child (tinted by state) once the epic's record is loaded; before that they come from the list
  // summary (merged vs. rest). A third line shows a sandbox, CLI or host halt with its fix (#3455),
  // or another drain hold with its action (#3457). The card's amber says the epic is part of the
  // repo's run: solid while it leads, dashed while queued; an epic outside the run stays quiet.
  let {
    issue,
    summary = undefined,
    epic = undefined,
    role = null,
    position = null,
    drain = null,
    mobile = false,
    onopensession = undefined,
    onopenautomation = undefined,
    expanded,
    selected,
    optionId,
    onselect,
    ontoggle,
  }: {
    issue: Issue;
    summary?: EpicSummary;
    epic?: Epic;
    /** Role in the repo's run (#2620) — "leads" / "winding down"; null → no badge. */
    role?: EpicRole | null;
    /** 1-based place in the repo's epic queue (#2624), shown on a "queued" badge. */
    position?: number | null;
    /** The repo's drain — whether it holds this epic at a sandbox, CLI or host gate (#3455). */
    drain?: DrainStatus | null;
    /** Phone layout: the halt's fix opens as a bottom sheet instead of a popover. */
    mobile?: boolean;
    /** Opens the stuck session a hold names (#3457). */
    onopensession?: (sessionId: string) => void;
    /** Switches to the Automation tab — the project bootstrap's home (#3457). */
    onopenautomation?: () => void;
    expanded: boolean;
    selected: boolean;
    optionId: string;
    onselect: () => void;
    ontoggle: () => void;
  } = $props();

  // Prefer the record's authoritative (native-first) counts over the markdown-first summary,
  // which can go stale after a restructure — same rule as the former row badge.
  const counts = $derived(
    epic ? progress(epic.children) : { merged: summary?.merged ?? 0, total: summary?.total ?? 0 },
  );
  const segments = $derived(
    epic
      ? [...epic.children].sort((a, b) => a.order - b.order).map((c) => chipFor(c.state).tone)
      : Array.from({ length: counts.total }, (_, i) => (i < counts.merged ? "done" : "empty")),
  );
  const halted = $derived(sandboxHaltedEpic(drain) === issue.number);
  // #3457: the drain's other holds while it runs this epic — bootstrap, usage, base, agent, approval.
  const hold = $derived(drain?.epicParent === issue.number ? drainHold(drain) : null);
</script>

<div
  class="issue-row epic-row"
  class:selected
  class:expanded
  data-role={role ?? undefined}
  id={optionId}
  role="option"
  aria-selected={selected}
  tabindex="-1"
  onclick={onselect}
  onkeydown={(e) => activate(e, onselect)}
>
  <div class="line">
    <button
      class="chevron epic-toggle"
      type="button"
      tabindex="-1"
      aria-expanded={expanded}
      aria-label={expanded
        ? m.epic_badge_collapse_aria({ parent: issue.number })
        : m.epic_badge_expand_aria({ parent: issue.number })}
      onclick={(e) => {
        e.stopPropagation();
        ontoggle();
      }}>{expanded ? "▾" : "▸"}</button
    >
    <span class="num" id={`epic-issue-row-${issue.number}`}>#{issue.number}</span>
    <span class="title issue-title">{issue.title}</span>
  </div>
  <div class="line sub">
    <!-- short: the run rail beside this row shows a queued epic's place. -->
    {#if role}<EpicRoleBadge {role} {position} short />{/if}
    {#if counts.total > 0}
      <span class="bar" aria-hidden="true">
        {#each segments as tone, i (i)}<span class="seg seg-{tone}"></span>{/each}
      </span>
    {/if}
    <span class="count" title={m.epic_progress({ merged: counts.merged, total: counts.total })}
      >{counts.merged}/{counts.total}</span
    >
  </div>
  {#if halted && drain}
    <EpicRowHalt repoPath={drain.repoPath} parent={issue.number} {epic} {drain} {mobile} />
  {:else if hold && drain}
    <div class="hold-slot">
      <EpicHoldLine
        repoPath={drain.repoPath}
        parent={issue.number}
        view={hold}
        {onopensession}
        {onopenautomation}
      />
    </div>
  {/if}
</div>

<style>
  .epic-row {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    padding: 5px 8px 5px 4px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    background: var(--color-inset);
    color: var(--color-ink);
    font-size: var(--fs-base);
    cursor: pointer;
  }
  .epic-row:hover {
    background: var(--color-panel);
  }
  .epic-row[data-role="leading"] {
    border-color: var(--status-running);
    background: color-mix(in oklab, var(--status-running) 13%, var(--color-inset));
    color: var(--color-ink-bright);
  }
  .epic-row[data-role="leading"]:hover {
    background: color-mix(in oklab, var(--status-running) 17%, var(--color-inset));
  }
  .epic-row[data-role="winding"] {
    border-color: color-mix(in srgb, var(--status-running) 35%, var(--color-line));
    background: color-mix(in oklab, var(--status-running) 6%, var(--color-inset));
  }
  .epic-row[data-role="queued"] {
    border-style: dashed;
    border-color: color-mix(in srgb, var(--status-running) 55%, var(--color-line-bright));
    background: color-mix(in oklab, var(--status-running) 4%, var(--color-inset));
  }
  .epic-row[data-role="winding"]:hover,
  .epic-row[data-role="queued"]:hover {
    background: color-mix(in oklab, var(--status-running) 9%, var(--color-inset));
  }
  /* Selection as on every other list row (#2638) — an amber frame would read as "leads". */
  .epic-row.selected,
  .epic-row.selected:hover {
    background: var(--color-sel);
    box-shadow: inset 2px 0 0 var(--color-ink-bright);
    color: var(--color-ink-bright);
  }
  :global(.issue-options:focus-visible) .epic-row.selected {
    box-shadow:
      inset 2px 0 0 var(--color-ink-bright),
      inset 0 0 0 1px var(--color-amber);
  }

  .line {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
  }
  /* Status line, indented under the title (past the chevron). */
  .sub {
    align-items: center;
    padding-left: 24px;
  }

  .chevron {
    flex: none;
    width: 18px;
    padding: 0;
    background: transparent;
    border: 0;
    color: var(--color-muted);
    font: inherit;
    cursor: pointer;
  }
  [data-role="leading"] .chevron {
    color: var(--status-running);
  }
  [data-role="winding"] .chevron,
  [data-role="queued"] .chevron {
    color: color-mix(in srgb, var(--status-running) 80%, var(--color-muted));
  }

  .num {
    font-family: var(--font-mono);
    flex: none;
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }

  .title {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .bar {
    display: flex;
    flex: 1;
    gap: 1px;
    min-width: 40px;
    max-width: 140px;
    height: 6px;
  }
  .seg {
    flex: 1;
    min-width: 1px;
    border-radius: 1px;
    background: var(--color-line);
  }
  .seg-done {
    background: var(--status-done);
  }
  .seg-review {
    background: var(--color-blue);
  }
  .seg-running {
    background: var(--status-running);
  }
  .seg-ready {
    background: var(--color-green);
  }
  .seg-muted {
    background: var(--color-faint);
  }

  /* Indented under the title, as EpicRowHalt's line. */
  .hold-slot {
    margin: 2px 0 0 24px;
  }

  .count {
    flex: none;
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
  }

  @media (max-width: 768px), (pointer: coarse) {
    .epic-row {
      min-height: var(--mobile-actionbar-hit);
    }
    .chevron {
      width: 32px;
      min-height: 32px;
    }
    .sub {
      padding-left: 38px;
    }
    .hold-slot {
      margin-left: 38px;
    }
  }
</style>
