<script lang="ts">
  import { anchorPopover } from "$lib/floating-anchor";
  import { prsFilter } from "$lib/prs-filter.svelte";
  import { m } from "$lib/paraglide/messages";

  // authors: distinct option set for the repo-scoped author filter (computed by the
  //   parent from the raw PR list). selectedAuthor is the current selection; the parent
  //   owns the state and mutates it via onauthor. Omitted (empty) → the author section
  //   doesn't render. The three boolean toggles read/write the global prsFilter store.
  let {
    authors = [],
    selectedAuthor = null,
    onauthor = undefined,
  }: {
    authors?: string[];
    selectedAuthor?: string | null;
    onauthor?: (author: string | null) => void;
  } = $props();

  // Show the Author section at >=2 authors OR whenever a selection is set — the OR-guard
  // keeps a still-valid author selection clearable when a refresh shrinks the option set
  // to one (an absent selection is pruned upstream, so a non-null selectedAuthor is always
  // in `authors`).
  const showAuthorSection = $derived(authors.length >= 2 || selectedAuthor != null);

  // SSR-stable per-instance id for aria-controls wiring.
  const popoverId = $props.id();

  let open = $state(false);
  let wasOpen = false; // tracks previous open value; not reactive — managed in the focus effect
  let btnEl = $state<HTMLButtonElement | null>(null);
  let popEl = $state<HTMLDivElement | null>(null);

  // Active count — one per enabled toggle plus the author selection (0/1).
  const activeCount = $derived(
    (prsFilter.hideDrafts ? 1 : 0) +
      (prsFilter.hideConflicts ? 1 : 0) +
      (prsFilter.hideFailingCi ? 1 : 0) +
      (selectedAuthor != null ? 1 : 0),
  );

  // Position the popover below the trigger whenever open + both elements exist.
  $effect(() => {
    if (!open || !btnEl || !popEl) return;
    try {
      popEl.showPopover();
    } catch {
      return; // not connected this tick — effect re-runs once popEl mounts
    }
    return anchorPopover(btnEl, popEl, 6, "bottom");
  });

  // Dismiss on Esc + outside pointerdown. Attach one tick after open so the
  // opening click doesn't immediately close. Do NOT dismiss on scroll/resize
  // because the checkboxes are interactive.
  $effect(() => {
    if (!open) return;
    function onKeydown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        open = false;
      }
    }
    function onPointerdown(e: PointerEvent) {
      if (
        popEl &&
        !popEl.contains(e.target as Node) &&
        btnEl &&
        !btnEl.contains(e.target as Node)
      ) {
        open = false;
      }
    }
    const tid = setTimeout(() => {
      window.addEventListener("keydown", onKeydown);
      window.addEventListener("pointerdown", onPointerdown);
    }, 0);
    return () => {
      clearTimeout(tid);
      window.removeEventListener("keydown", onKeydown);
      window.removeEventListener("pointerdown", onPointerdown);
    };
  });

  // Focus management: focus first checkbox on open→true; restore trigger on true→false.
  // Do NOT move focus on initial mount (wasOpen starts false, open starts false).
  $effect(() => {
    if (typeof window === "undefined") return;
    if (open) {
      wasOpen = true;
      const first = popEl?.querySelector<HTMLInputElement>("input[type=checkbox]");
      if (first) {
        // defer so popover is visible before we focus
        setTimeout(() => first.focus(), 0);
      }
    } else if (wasOpen) {
      // genuine open→closed transition
      btnEl?.focus();
    }
    // If open===false and wasOpen===false (initial mount), do nothing.
  });
</script>

<button
  bind:this={btnEl}
  class={["filter-chip", { active: open || activeCount > 0 }]}
  type="button"
  aria-haspopup="dialog"
  aria-expanded={open}
  aria-controls={popoverId}
  aria-label={m.prsfilter_button_aria({ count: activeCount })}
  onclick={() => (open = !open)}
>
  {m.prsfilter_button()}
  {#if activeCount > 0}
    <span class="badge" aria-hidden="true">{activeCount}</span>
  {/if}
  <span class="chevron" aria-hidden="true">▾</span>
</button>

<!-- popover="manual": native top-layer, escapes overflow:hidden containers.
     position:fixed + inset:auto + margin:0 so Floating UI's left/top drive placement.
     Non-modal: no aria-modal, no scrim (small anchored non-blocking popover, exempt per CLAUDE.md). -->
<div
  id={popoverId}
  bind:this={popEl}
  class="filter-popover"
  role="dialog"
  aria-label={m.prsfilter_heading()}
  popover="manual"
>
  <label class="filter-row">
    <input
      type="checkbox"
      checked={prsFilter.hideDrafts}
      onchange={() => prsFilter.toggleDrafts()}
    />
    <span class="row-text">
      <span class="row-label">{m.prsfilter_drafts_label()}</span>
      <span class="row-desc">{m.prsfilter_drafts_desc()}</span>
    </span>
  </label>
  <label class="filter-row">
    <input
      type="checkbox"
      checked={prsFilter.hideConflicts}
      onchange={() => prsFilter.toggleConflicts()}
    />
    <span class="row-text">
      <span class="row-label">{m.prsfilter_conflicts_label()}</span>
      <span class="row-desc">{m.prsfilter_conflicts_desc()}</span>
    </span>
  </label>
  <label class="filter-row">
    <input
      type="checkbox"
      checked={prsFilter.hideFailingCi}
      onchange={() => prsFilter.toggleFailingCi()}
    />
    <span class="row-text">
      <span class="row-label">{m.prsfilter_failing_ci_label()}</span>
      <span class="row-desc">{m.prsfilter_failing_ci_desc()}</span>
    </span>
  </label>

  {#if showAuthorSection}
    <div class="section-divider" role="separator"></div>
    <div class="section" role="radiogroup" aria-label={m.prsfilter_author_heading()}>
      <div class="section-heading">{m.prsfilter_author_heading()}</div>
      <label class="filter-row author-row">
        <input
          type="radio"
          name="pr-author-filter-{popoverId}"
          checked={selectedAuthor == null}
          onchange={() => onauthor?.(null)}
        />
        <span class="row-label">{m.prsfilter_author_all()}</span>
      </label>
      {#each authors as author (author)}
        <label class="filter-row author-row">
          <input
            type="radio"
            name="pr-author-filter-{popoverId}"
            checked={selectedAuthor === author}
            onchange={() => onauthor?.(author)}
          />
          <span class="row-label author-login">{author}</span>
        </label>
      {/each}
    </div>
  {/if}
</div>

<style>
  /* Trigger button — matches the .filter-chip recipe used by IssueFilterPopover. */
  .filter-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    flex-shrink: 0;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.1em;
    padding: 0 10px;
    cursor: pointer;
    touch-action: manipulation;
    transition:
      color 0.12s,
      border-color 0.12s;
  }

  .filter-chip:hover {
    color: var(--color-ink);
  }

  .filter-chip.active {
    color: var(--color-ink-bright);
    border-color: var(--color-line-bright);
    background: var(--color-inset);
  }

  .filter-chip:focus-visible {
    outline: 2px solid var(--color-line-bright);
    outline-offset: 2px;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 14px;
    height: 14px;
    padding: 0 3px;
    border-radius: 7px;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    color: var(--color-muted);
    font-size: var(--fs-micro);
    font-family: var(--font-mono);
    line-height: 1;
  }

  .chevron {
    font-size: var(--fs-micro);
    color: var(--color-muted);
  }

  /* Top-layer popover: position:fixed + inset:auto + margin:0 lets Floating UI
     drive left/top without fighting browser default centering. */
  [popover].filter-popover {
    position: fixed;
    inset: auto;
    margin: 0;
    min-width: 240px;
    max-width: min(320px, 90vw);
    /* Cap the height so an author-heavy repo scrolls the picker instead of
       overflowing the viewport. */
    max-height: min(70vh, 460px);
    overflow-y: auto;
    padding: 8px 0;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-meta);
    line-height: 1.5;
  }

  /* Entrance animation — same pattern as IssueFilterPopover. Global blanket in app.css
     suppresses this under prefers-reduced-motion via animation:none !important. */
  @keyframes popover-in {
    from {
      opacity: 0;
      transform: translateY(3px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  [popover].filter-popover:popover-open {
    animation: popover-in 120ms ease-out;
  }

  .filter-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 6px 12px;
    cursor: pointer;
  }

  .filter-row:hover {
    background: var(--color-surface);
  }

  .filter-row input[type="checkbox"] {
    margin-top: 2px;
    flex-shrink: 0;
    cursor: pointer;
  }

  .row-text {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .row-label {
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.05em;
  }

  .row-desc {
    color: var(--color-muted);
    font-size: var(--fs-micro);
    line-height: 1.4;
  }

  /* Author filter section, separated from the boolean toggles by a hairline. */
  .section-divider {
    height: 1px;
    margin: 6px 12px;
    background: var(--color-line);
  }

  .section {
    padding: 0 12px;
  }

  .section-heading {
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-faint);
    padding: 2px 0 4px;
  }

  /* Single-line radio rows for the author picker — tighter than the two-line boolean
     rows above; overrides .filter-row's flex-start/padding. */
  .author-row {
    align-items: center;
    gap: 8px;
    padding: 3px 0;
    margin: 0 -12px; /* full-width hover, re-inset by padding below */
    padding-left: 12px;
    padding-right: 12px;
  }

  .author-row input[type="radio"] {
    flex-shrink: 0;
    cursor: pointer;
  }

  /* Logins are mixed-case — keep them verbatim (no uppercasing). */
  .author-login {
    font-family: var(--font-mono);
  }
</style>
