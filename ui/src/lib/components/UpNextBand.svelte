<script module lang="ts">
  import type { UpNextItem } from "#lib/types.js";

  /** One tinted band: the cross-repo priority tier, or one label (bug, enhancement, …, none).
   *  tone is the CSS color the band and its heading are tinted with. */
  export type UpNextBandGroup = {
    id: string;
    title: string;
    /** The label this band groups by; its rows omit it from their chips. Null for priority/unlabeled. */
    label: string | null;
    tone: string;
    items: UpNextItem[];
    totalCount: number;
    cap: number;
  };
</script>

<script lang="ts">
  import { formatAgo } from "#lib/format.js";
  import { clock } from "#lib/now.svelte.js";
  import { m } from "#lib/paraglide/messages.js";
  import { upNextKey, upNextUi } from "#lib/up-next-ui.svelte.js";
  import IssueLabelChips from "./IssueLabelChips.svelte";

  // One Up Next band: its fold-toggle heading and its rows. A row's checkbox ticks it for the
  // batch bar; its title opens the issue in the preview (upNextUi.previewKey).
  let {
    group,
    open,
    expanded,
    showRepo,
    labelsOf,
    onfold,
    onexpand,
    ontick,
  }: {
    group: UpNextBandGroup;
    /** Rows shown (heading unfolded). */
    open: boolean;
    /** Past the cap ("show all N"). */
    expanded: boolean;
    /** Bands mix repos, so a row names its repo whenever more than one is on screen. */
    showRepo: boolean;
    labelsOf: (it: UpNextItem) => string[];
    onfold: () => void;
    onexpand: () => void;
    ontick: (it: UpNextItem) => void;
  } = $props();

  const selected = upNextUi.selected;
  const shown = $derived(expanded ? group.items : group.items.slice(0, group.cap));
  // Ticked rows a folded band hides — its heading says so, so a batch never starts unseen work.
  const hidden = $derived(
    open ? 0 : group.items.filter((it) => selected.has(upNextKey(it))).length,
  );
  const repoBase = (p: string | null) => p?.split("/").filter(Boolean).at(-1) ?? "";
</script>

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
      {#each shown as it (upNextKey(it))}
        {@const key = upNextKey(it)}
        {@const labels = labelsOf(it).filter(
          (label) => label.toLowerCase() !== group.label?.toLowerCase(),
        )}
        {@const current = upNextUi.previewKey === key}
        <li class="un-row" class:un-row-selected={selected.has(key)} class:un-row-current={current}>
          <label class="un-check">
            <input
              type="checkbox"
              checked={selected.has(key)}
              onchange={() => ontick(it)}
              aria-label={m.upnext_select_aria({ number: it.number, title: it.title })}
            />
          </label>
          <div class="un-main">
            <!-- The title reads the issue in the preview; GitHub is one click further, from there. -->
            <button
              type="button"
              class="un-link"
              aria-current={current ? "true" : undefined}
              onclick={() => (upNextUi.previewKey = key)}>{it.title}</button
            >
            {#if showRepo || it.kind === "epic" || labels.length > 0}
              <span class="un-sub">
                {#if it.kind === "epic"}<span class="un-pill">{m.upnext_pill_epic()}</span>{/if}
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
