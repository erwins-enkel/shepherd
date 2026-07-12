<script lang="ts">
  import { anchorPopover } from "$lib/floating-anchor";
  import { issuesFilter } from "$lib/issues-filter.svelte";
  import { coachTarget } from "$lib/actions/coachTarget.svelte";
  import { m } from "$lib/paraglide/messages";
  import { labelChipStyle } from "$lib/label-color";

  // showMine: when false the "mine & unassigned" row is NOT rendered (viewer unknown).
  // coachTargets: when true, the trigger carries use:coachTarget={"issue-filters"}.
  // authors/labels: distinct option sets for the repo-scoped author + label filters
  //   (computed by the parent from the raw issue list). selectedAuthor/selectedLabels are
  //   the current selection; the parent owns the state and mutates it via the callbacks.
  //   All optional — omitted (empty) → neither section renders, so existing callers are
  //   unaffected. labelColors: name → forge hex (see label-color.ts), used to hue an
  //   unselected toggle; omitted (empty) → toggles render neutral, as before.
  let {
    showMine,
    coachTargets = false,
    authors = [],
    labels = [],
    labelColors = {},
    selectedAuthor = null,
    selectedLabels = [],
    onauthor = undefined,
    ontogglelabel = undefined,
  }: {
    showMine: boolean;
    coachTargets?: boolean;
    authors?: string[];
    labels?: string[];
    labelColors?: Record<string, string>;
    selectedAuthor?: string | null;
    selectedLabels?: string[];
    onauthor?: (author: string | null) => void;
    ontogglelabel?: (label: string) => void;
  } = $props();

  // Show the Author section at >=2 authors OR whenever a selection is set — the OR-guard
  // keeps a still-valid author selection clearable when a refresh shrinks the option set to
  // one (an absent selection is pruned upstream, so a non-null selectedAuthor is always in
  // `authors`). The Labels section needs no such guard: its >=1 threshold can't hide a
  // still-present selected label (an absent one is pruned upstream).
  const showAuthorSection = $derived(authors.length >= 2 || selectedAuthor != null);
  const showLabelSection = $derived(labels.length >= 1);

  // SSR-stable per-instance id for aria-controls wiring.
  const popoverId = $props.id();

  let open = $state(false);
  let wasOpen = false; // tracks previous open value; not reactive — managed in the focus effect
  let btnEl = $state<HTMLButtonElement | null>(null);
  let popEl = $state<HTMLDivElement | null>(null);

  // Active count — gates mine toggle on showMine so a persisted hideOthers=true
  // doesn't inflate the badge when the mine row isn't shown. The author + label filters
  // add one each per active selection (author = 0/1, labels = count).
  const activeCount = $derived(
    (showMine && issuesFilter.hideOthers ? 1 : 0) +
      (issuesFilter.hideActive ? 1 : 0) +
      (issuesFilter.hideSubIssues ? 1 : 0) +
      (selectedAuthor != null ? 1 : 0) +
      selectedLabels.length,
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
  // (unlike InfoTip tooltip) because the checkboxes are interactive.
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
  aria-label={m.issue_filter_button_aria({ count: activeCount })}
  onclick={() => (open = !open)}
  use:coachTarget={coachTargets ? "issue-filters" : ""}
>
  {m.issue_filter_button()}
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
  aria-label={m.issue_filter_heading()}
  popover="manual"
>
  {#if showMine}
    <label class="filter-row">
      <input
        type="checkbox"
        checked={issuesFilter.hideOthers}
        onchange={() => issuesFilter.toggle()}
      />
      <span class="row-text">
        <span class="row-label">{m.issues_filter_mine_label()}</span>
        <span class="row-desc">{m.issues_filter_mine_title()}</span>
      </span>
    </label>
  {/if}
  <label class="filter-row">
    <input
      type="checkbox"
      checked={issuesFilter.hideActive}
      onchange={() => issuesFilter.toggleActive()}
    />
    <span class="row-text">
      <span class="row-label">{m.issues_filter_active_label()}</span>
      <span class="row-desc">{m.issues_filter_active_title()}</span>
    </span>
  </label>
  <label class="filter-row">
    <input
      type="checkbox"
      checked={issuesFilter.hideSubIssues}
      onchange={() => issuesFilter.toggleSubIssues()}
    />
    <span class="row-text">
      <span class="row-label">{m.issues_filter_subissues_label()}</span>
      <span class="row-desc">{m.issues_filter_subissues_title()}</span>
    </span>
  </label>

  {#if showAuthorSection}
    <div class="section-divider" role="separator"></div>
    <div class="section" role="radiogroup" aria-label={m.issues_filter_author_heading()}>
      <div class="section-heading">{m.issues_filter_author_heading()}</div>
      <label class="filter-row author-row">
        <input
          type="radio"
          name="issue-author-filter-{popoverId}"
          checked={selectedAuthor == null}
          onchange={() => onauthor?.(null)}
        />
        <span class="row-label">{m.issues_filter_author_all()}</span>
      </label>
      {#each authors as author (author)}
        <label class="filter-row author-row">
          <input
            type="radio"
            name="issue-author-filter-{popoverId}"
            checked={selectedAuthor === author}
            onchange={() => onauthor?.(author)}
          />
          <span class="row-label author-login">{author}</span>
        </label>
      {/each}
    </div>
  {/if}

  {#if showLabelSection}
    <div class="section-divider" role="separator"></div>
    <div class="section">
      <div class="section-heading" id="issue-label-heading-{popoverId}">
        {m.issues_filter_labels_heading()}
      </div>
      <div class="label-chips" role="group" aria-labelledby="issue-label-heading-{popoverId}">
        {#each labels as label (label)}
          {@const on = selectedLabels.includes(label)}
          {@const style = !on ? labelChipStyle(labelColors[label] ?? "") : null}
          <button
            type="button"
            class={["label-toggle", { on, hued: style !== null }]}
            {style}
            aria-pressed={on}
            onclick={() => ontogglelabel?.(label)}>{label}</button
          >
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  /* Trigger button — matches the .filter-chip recipe in ProjectBacklogList.svelte. */
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
    /* Cap the height so a label-/author-heavy repo scrolls the picker instead of
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

  /* Entrance animation — same pattern as InfoTip. Global blanket in app.css
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

  /* Author + label filter sections, separated from the boolean toggles by a hairline. */
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

  .label-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 2px 0 4px;
  }

  .label-toggle {
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-muted);
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    padding: 1px 6px;
    cursor: pointer;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    transition:
      color 0.12s,
      border-color 0.12s,
      background 0.12s;
  }

  .label-toggle:hover {
    color: var(--color-ink);
    border-color: var(--color-line-bright);
  }

  /* Selected label — amber accent matches the other "active filter" affordances. */
  .label-toggle.on {
    color: var(--color-amber);
    border-color: var(--color-amber);
    background: color-mix(in srgb, var(--color-amber) 14%, transparent);
  }

  /* Real forge label color (issue: labels-almost-invisible) — sanctioned exception to
     "accent hues are semantic, not decorative" (see /design-system). Only applied to
     UNSELECTED toggles (the template only computes a style when !on), so .on's amber
     "selected" semantic always wins where it applies. */
  .label-toggle.hued {
    color: var(--lc-text-d);
    border-color: var(--lc-border-d);
    background: var(--lc-fill-d);
  }
  :global([data-theme="light"]) .label-toggle.hued {
    color: var(--lc-text-l);
    border-color: var(--lc-border-l);
    background: var(--lc-fill-l);
  }

  /* A hued toggle pins its own color/border, so the neutral .label-toggle:hover rule
     (equal specificity, earlier in source) can't tint it — hover would be invisible.
     Brighten instead: hue-agnostic, works in both themes, needs no extra vars. */
  .label-toggle.hued:hover {
    filter: brightness(1.18);
  }

  .label-toggle:focus-visible {
    outline: 2px solid var(--color-line-bright);
    outline-offset: 1px;
  }
</style>
