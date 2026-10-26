<script module lang="ts">
  import type { UpNextItem, UpNextPr } from "#lib/types.js";

  type BandFrame = {
    id: string;
    title: string;
    /** The CSS color the band and its heading are tinted with. */
    tone: string;
    totalCount: number;
    cap: number;
  };
  /** One tinted band: the cross-repo priority tier, or one label (bug, enhancement, …, none).
   *  tone is the CSS color the band and its heading are tinted with. */
  export type UpNextBandGroup = BandFrame & {
    kind?: "issue";
    /** The label this band groups by; its rows omit it from their chips. Null for priority/unlabeled. */
    label: string | null;
    items: UpNextItem[];
  };
  /** One PR band (ready, review, blocked, dependabot), classified server-side. */
  export type UpNextPrBandGroup = BandFrame & { kind: "pr"; items: UpNextPr[] };
</script>

<script lang="ts">
  import { formatAgo } from "#lib/format.js";
  import { clock } from "#lib/now.svelte.js";
  import { m } from "#lib/paraglide/messages.js";
  import type { UpNextPrActions } from "#lib/up-next-pr-actions.svelte.js";
  import { upNextKey, upNextPrKey, upNextUi } from "#lib/up-next-ui.svelte.js";
  import IssueLabelChips from "./IssueLabelChips.svelte";
  import UpNextPrRowStatus from "./UpNextPrRowStatus.svelte";

  // One Up Next band: its fold-toggle heading and its rows. A row's checkbox ticks it for the
  // batch bar; its title opens the issue or PR in the preview (upNextUi.previewKey). A PR row
  // also carries its one next action on the right.
  let {
    group,
    open,
    expanded,
    showRepo,
    labelsOf = () => [],
    onfold,
    onexpand,
    ontick,
    prActions = undefined,
  }: {
    group: UpNextBandGroup | UpNextPrBandGroup;
    /** Rows shown (heading unfolded). */
    open: boolean;
    /** Past the cap ("show all N"). */
    expanded: boolean;
    /** Bands mix repos, so a row names its repo whenever more than one is on screen. */
    showRepo: boolean;
    labelsOf?: (it: UpNextItem) => string[];
    onfold: () => void;
    onexpand: () => void;
    ontick?: (it: UpNextItem) => void;
    /** Runs a PR row's action; a PR band without it shows its buttons disabled. */
    prActions?: UpNextPrActions;
  } = $props();

  const selected = upNextUi.selected;
  const prs = $derived(group.kind === "pr" ? group.items : []);
  const issues = $derived(group.kind === "pr" ? [] : group.items);
  const keys = $derived(group.kind === "pr" ? prs.map(upNextPrKey) : issues.map(upNextKey));
  const shownPrs = $derived(expanded ? prs : prs.slice(0, group.cap));
  const shown = $derived(expanded ? issues : issues.slice(0, group.cap));
  // Ticked rows a folded band hides — its heading says so, so a batch never starts unseen work.
  const hidden = $derived(open ? 0 : keys.filter((key) => selected.has(key)).length);
  const repoBase = (p: string | null) => p?.split("/").filter(Boolean).at(-1) ?? "";
  const groupLabel = $derived(group.kind === "pr" ? null : group.label);
</script>

{#snippet tickBox(key: string, label: string, onchange: () => void)}
  <label class="un-check">
    <input type="checkbox" checked={selected.has(key)} {onchange} aria-label={label} />
  </label>
{/snippet}

{#snippet prRow(pr: UpNextPr)}
  {@const key = upNextPrKey(pr)}
  {@const current = upNextUi.previewKey === key}
  <li class="un-row" class:un-row-selected={selected.has(key)} class:un-row-current={current}>
    {@render tickBox(key, m.upnext_pr_select_aria({ number: pr.number, title: pr.title }), () =>
      upNextUi.toggle(key),
    )}
    <div class="un-main">
      <button
        type="button"
        class="un-link"
        aria-current={current ? "true" : undefined}
        onclick={() => (upNextUi.previewKey = key)}>{pr.title}</button
      >
      <UpNextPrRowStatus {pr} {showRepo} actions={prActions} />
    </div>
    <span class="un-meta">
      <span class="un-num unpr-num"
        ><svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          role="img"
          aria-label={m.upnext_pr_glyph()}
          ><circle cx="4" cy="3.5" r="1.75" /><circle cx="4" cy="12.5" r="1.75" /><circle
            cx="12"
            cy="12.5"
            r="1.75"
          /><path d="M4 5.25v5.5M12 10.75V6.5a2 2 0 0 0-2-2H7" /><path
            d="M8.5 3 7 4.5 8.5 6"
          /></svg
        >#{pr.number}</span
      >
      <span class="un-age">{formatAgo(clock.current - pr.createdAt)}</span>
    </span>
  </li>
{/snippet}

<div class="un-section" style:--band={group.tone}>
  <button type="button" class="un-section-head" aria-expanded={open} onclick={onfold}>
    <span class="un-chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>
    <span class="un-section-title">{group.title}</span>
    {#if hidden > 0}
      <span class="un-section-hidden">{m.upnext_selected_count({ count: hidden })}</span>
    {/if}
    <span class="un-section-count">{group.totalCount}</span>
  </button>
  {#if open}
    <ul class="un-list">
      {#each shownPrs as pr (upNextPrKey(pr))}
        {@render prRow(pr)}
      {/each}
      {#each shown as it (upNextKey(it))}
        {@const key = upNextKey(it)}
        {@const labels = labelsOf(it).filter(
          (label) => label.toLowerCase() !== groupLabel?.toLowerCase(),
        )}
        {@const current = upNextUi.previewKey === key}
        <li class="un-row" class:un-row-selected={selected.has(key)} class:un-row-current={current}>
          {@render tickBox(key, m.upnext_select_aria({ number: it.number, title: it.title }), () =>
            ontick?.(it),
          )}
          <div class="un-main">
            <!-- The title reads the issue in the preview; GitHub is one click further, from there. -->
            <button
              type="button"
              class="un-link"
              aria-current={current ? "true" : undefined}
              onclick={() => (upNextUi.previewKey = key)}>{it.title}</button
            >
            {#if showRepo || it.kind === "epic" || it.fromFork || labels.length > 0}
              <span class="un-sub">
                {#if it.kind === "epic"}<span class="un-pill">{m.upnext_pill_epic()}</span>{/if}
                {#if it.fromFork}<span class="un-pill un-fork"
                    >{it.mine ? m.upnext_filter_tag_fork() : m.upnext_filter_tag_upstream()}</span
                  >{/if}
                {#if showRepo}<span>{it.repoLabel || repoBase(it.repoPath)}</span>{/if}
                <IssueLabelChips {labels} labelColors={it.labelColors} all />
              </span>
            {/if}
          </div>
          <span class="un-meta">
            <span class="un-num">#{it.number}</span>
            <span class="un-age">{formatAgo(clock.current - it.createdAt)}</span>
          </span>
        </li>
      {/each}
    </ul>
    {#if group.totalCount > group.cap}
      <button type="button" class="un-expand" onclick={onexpand}>
        {expanded ? m.upnext_show_less() : m.upnext_show_all({ count: group.totalCount })}
      </button>
    {/if}
  {/if}
</div>

<style>
  /* One band per group, tinted with its --band tone (set inline per group). */
  .un-section {
    display: flex;
    flex-direction: column;
  }
  /* The heading is the band's fold toggle. It sticks to the top of the scrolling list while its
     band's rows pass under it (the next band's heading pushes it out), so the band in view
     stays named. Above rows, below the batch bar (z 2). */
  .un-section-head {
    position: sticky;
    top: 0;
    z-index: 1;
    margin: 0;
    width: 100%;
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 7px 14px;
    border-inline: 0;
    font-family: inherit;
    text-align: left;
    cursor: pointer;
    font-size: var(--fs-micro);
    font-weight: 700;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--band);
    background: color-mix(in srgb, var(--band) 9%, var(--color-panel));
    border-block: 1px solid color-mix(in srgb, var(--band) 26%, var(--color-panel));
  }
  .un-section-head:hover {
    background: color-mix(in srgb, var(--band) 15%, var(--color-panel));
  }
  .un-section-head:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--band);
  }
  .un-chevron {
    flex: none;
    width: 1ch;
    letter-spacing: 0;
  }
  .un-section-hidden {
    flex: none;
    font-weight: 400;
    letter-spacing: 0.04em;
    text-transform: none;
    color: var(--color-amber);
  }
  .un-section-title {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .un-section-count {
    flex: none;
    letter-spacing: 0;
  }

  .un-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  /* The title owns the row's width and wraps instead of truncating; number and age
     move to a narrow right-aligned column so nothing competes with it. */
  .un-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 9px 14px;
    border-bottom: 1px solid var(--color-line);
    transition: background 0.12s;
  }
  .un-row:hover,
  .un-row:focus-within {
    background: var(--color-hover);
  }
  .un-row.un-row-selected {
    background: var(--color-sel);
  }
  /* The row open in the preview. */
  .un-row.un-row-current {
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .un-check {
    flex: none;
    display: flex;
    align-items: center;
    padding-top: 2px;
  }
  .un-check input {
    margin: 0;
    accent-color: var(--color-amber);
    cursor: pointer;
  }
  .un-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .un-link {
    align-self: flex-start;
    padding: 0;
    background: none;
    border: 0;
    font-family: inherit;
    text-align: left;
    cursor: pointer;
    font-size: var(--fs-base);
    line-height: 1.45;
    color: var(--color-ink-bright);
    text-decoration: none;
    overflow-wrap: anywhere;
    transition: color 0.12s ease;
  }
  .un-link:hover,
  .un-row-current .un-link {
    color: var(--color-amber);
  }
  .un-link:focus-visible {
    outline: none;
    box-shadow: 0 1px 0 var(--color-amber);
  }
  .un-sub {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 2px 8px;
    font-size: var(--fs-micro);
    color: var(--color-muted);
  }
  .un-pill {
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    padding: 0 4px;
    color: var(--color-ink-bright);
  }
  /* Fork origin is context, not a call to action — quieter than the epic pill. */
  .un-fork {
    color: var(--color-muted);
  }
  .un-meta {
    flex: none;
    min-width: 5ch;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 2px;
    padding-top: 2px;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .un-age {
    color: var(--color-faint);
  }

  .unpr-num {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  @media (max-width: 768px), (pointer: coarse) {
    .un-check {
      justify-content: center;
      min-width: var(--mobile-actionbar-hit);
      min-height: var(--mobile-actionbar-hit);
      padding-top: 0;
    }
    .un-link {
      display: flex;
      align-items: center;
      min-height: var(--mobile-actionbar-hit);
    }
  }

  .un-expand {
    align-self: flex-start;
    background: none;
    border: 0;
    padding: 8px 14px;
    font: inherit;
    font-size: var(--fs-micro);
    color: var(--color-muted);
    cursor: pointer;
  }
  .un-expand:hover {
    color: var(--color-amber);
  }
</style>
