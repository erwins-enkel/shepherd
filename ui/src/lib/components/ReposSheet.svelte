<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import { dialog } from "$lib/a11yDialog";
  import { basename } from "./learnings-drawer";
  import type { RepoChip } from "$lib/components/queue-strip";

  // The phone's repo surface (D14, docs/design/mobile-herd). It replaces the top-edge repo rail,
  // which cost 48px of a 932px screen for three 10px labels and put the filter out of thumb
  // reach. It opens from REPOS in the bottom navigation and carries BOTH things that button's
  // label promises: the per-repo filter, and the way into the backlog.
  //
  // A blocking surface, so per .claude/rules/ui-design-system.md it dims AND blurs what's behind
  // it — the canonical `.scrim` from app.css, not a hand-rolled backdrop.
  let {
    chips,
    repoFilter,
    onrepofilter,
    onclearfilter,
    onbacklog,
    onclose,
  }: {
    chips: RepoChip[];
    /** Currently filtered repo paths; empty = every repo shown. */
    repoFilter: Set<string>;
    onrepofilter: (repoPath: string, additive: boolean) => void;
    /** Clears the filter outright. NOT expressible by replaying `onrepofilter(p, false)` per
     *  entry: that path runs through `nextRepoFilter`, which only returns the empty set for a
     *  ONE-element selection and otherwise collapses to `{p}` — so a Shift-selected pair would
     *  end up with one repo still filtered. The page owns the set, so it clears it directly. */
    onclearfilter: () => void;
    /** Absent when there is no backlog to open (no sessions yet) — the row is then omitted. */
    onbacklog?: () => void;
    onclose: () => void;
  } = $props();

  const total = $derived(chips.reduce((n, c) => n + c.count, 0));
  const showingAll = $derived(repoFilter.size === 0);

  function pick(repoPath: string) {
    onrepofilter(repoPath, false);
    onclose();
  }

  function clearFilter() {
    onclearfilter();
    onclose();
  }
</script>

<!-- eslint-disable-next-line svelte/no-static-element-interactions -- the scrim's only job is
     outside-click dismissal; Escape above covers the keyboard path. -->
<div class="scrim rs-sheet-scrim" onclick={onclose} aria-hidden="true"></div>
<!-- `use:dialog` is the house modal contract (a11yDialog.ts): Tab-trap, Escape, and focus
     restore to whatever opened the sheet — which is what makes `aria-modal` honest here. -->
<div
  class="rs-sheet"
  role="dialog"
  aria-modal="true"
  aria-label={m.repos_sheet_title()}
  use:dialog={{ onclose }}
>
  <div class="rs-sheet-grip" aria-hidden="true"></div>
  <div class="rs-sheet-head">
    <span class="rs-sheet-title">{m.repos_sheet_title()}</span>
    <button type="button" class="rs-sheet-close" onclick={onclose} aria-label={m.common_close()}
      >✕</button
    >
  </div>

  <div class="rs-sheet-list">
    <button
      type="button"
      class="rs-sheet-row"
      class:rs-sheet-row--on={showingAll}
      aria-pressed={showingAll}
      onclick={clearFilter}
    >
      <span class="rs-sheet-check" aria-hidden="true">{showingAll ? "✓" : ""}</span>
      <span class="rs-sheet-glyph" aria-hidden="true">▣</span>
      <span class="rs-sheet-name">{m.repos_sheet_all()}</span>
      <span class="rs-sheet-count">{total}</span>
    </button>
    {#each chips as chip (chip.repoPath)}
      {@const on = repoFilter.has(chip.repoPath)}
      <button
        type="button"
        class="rs-sheet-row"
        class:rs-sheet-row--on={on}
        aria-pressed={on}
        onclick={() => pick(chip.repoPath)}
      >
        <span class="rs-sheet-check" aria-hidden="true">{on ? "✓" : ""}</span>
        <span class="rs-sheet-glyph" aria-hidden="true">▣</span>
        <span class="rs-sheet-name">{basename(chip.repoPath)}</span>
        <span class="rs-sheet-count">{chip.count}</span>
      </button>
    {/each}
  </div>

  {#if onbacklog}
    <div class="rs-sheet-foot">
      <button
        type="button"
        class="rs-sheet-row rs-sheet-row--nav"
        onclick={() => {
          onclose();
          onbacklog();
        }}
      >
        <span class="rs-sheet-check" aria-hidden="true"></span>
        <span class="rs-sheet-glyph" aria-hidden="true">☰</span>
        <span class="rs-sheet-name">{m.repos_sheet_backlog()}</span>
        <span class="rs-sheet-count" aria-hidden="true">›</span>
      </button>
    </div>
  {/if}
</div>

<style>
  .rs-sheet-scrim {
    z-index: 60;
  }
  /* Rising bottom sheet: the design system's one sanctioned drop shadow (DESIGN.md, Elevation —
     "Sheet lift"), the 12px `rounded.lg` reserved for exactly this, and `head` as its ground. */
  .rs-sheet {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 61;
    max-height: 80dvh;
    display: flex;
    flex-direction: column;
    background: var(--color-head);
    border-top: 1px solid var(--color-line-bright);
    border-radius: 12px 12px 0 0;
    box-shadow: 0 -8px 40px rgba(0, 0, 0, 0.5);
    padding: 12px 14px;
    padding-bottom: max(12px, env(safe-area-inset-bottom));
  }
  @media (prefers-reduced-motion: no-preference) {
    .rs-sheet {
      animation: rs-sheet-rise 0.18s ease-out;
    }
  }
  @keyframes rs-sheet-rise {
    from {
      transform: translateY(12px);
      opacity: 0;
    }
  }
  .rs-sheet:focus-visible {
    outline: none;
  }
  .rs-sheet-grip {
    width: 36px;
    height: 3px;
    border-radius: 2px;
    background: var(--color-line-bright);
    margin: 0 auto 12px;
    flex: none;
  }
  .rs-sheet-head {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: none;
  }
  .rs-sheet-title {
    font-size: var(--fs-meta);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-ink-bright);
    font-weight: 600;
    flex: 1;
  }
  .rs-sheet-close {
    min-width: 44px;
    min-height: 44px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 0;
    background: none;
    color: var(--color-muted);
    font: inherit;
    font-size: var(--fs-lg);
    cursor: pointer;
    border-radius: 2px;
  }
  .rs-sheet-close:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .rs-sheet-list {
    overflow-y: auto;
    min-height: 0;
  }
  .rs-sheet-foot {
    flex: none;
    border-top: 1px solid var(--color-line-bright);
    margin-top: 8px;
    padding-top: 8px;
  }
  /* 48px, not 44: Material's target value rather than the iOS floor. The list screen has to
     ration vertical space; a sheet does not, so it takes the better number. */
  .rs-sheet-row {
    width: 100%;
    min-height: 48px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 4px;
    border: 0;
    border-top: 1px solid var(--color-line);
    background: none;
    font: inherit;
    color: var(--color-ink-bright);
    text-align: left;
    cursor: pointer;
  }
  .rs-sheet-list .rs-sheet-row:first-child,
  .rs-sheet-foot .rs-sheet-row {
    border-top: 0;
  }
  .rs-sheet-row:hover {
    background: var(--color-hover);
  }
  .rs-sheet-row:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .rs-sheet-row--on {
    color: var(--color-amber);
  }
  .rs-sheet-row--nav {
    color: var(--color-blue);
  }
  .rs-sheet-check {
    width: 12px;
    flex: none;
    color: var(--color-amber);
    font-weight: 700;
  }
  .rs-sheet-glyph {
    flex: none;
    color: var(--color-muted);
    font-size: var(--fs-micro);
  }
  .rs-sheet-row--nav .rs-sheet-glyph {
    color: var(--color-blue);
    font-size: var(--fs-base);
  }
  .rs-sheet-name {
    flex: 1;
    min-width: 0;
    font-size: var(--fs-base);
    letter-spacing: 0.04em;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .rs-sheet-count {
    flex: none;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    font-variant-numeric: tabular-nums;
  }
</style>
