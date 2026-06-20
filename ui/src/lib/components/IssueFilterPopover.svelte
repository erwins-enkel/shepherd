<script lang="ts">
  import { anchorPopover } from "$lib/floating-anchor";
  import { issuesFilter } from "$lib/issues-filter.svelte";
  import { coachTarget } from "$lib/actions/coachTarget.svelte";
  import { m } from "$lib/paraglide/messages";

  // showMine: when false the "mine & unassigned" row is NOT rendered (viewer unknown).
  // coachTargets: when true, the trigger carries use:coachTarget={"issue-filters"}.
  let { showMine, coachTargets = false }: { showMine: boolean; coachTargets?: boolean } = $props();

  let open = $state(false);
  let btnEl = $state<HTMLButtonElement | null>(null);
  let popEl = $state<HTMLDivElement | null>(null);

  // Active count — gates mine toggle on showMine so a persisted hideOthers=true
  // doesn't inflate the badge when the mine row isn't shown.
  const activeCount = $derived(
    (showMine && issuesFilter.hideOthers ? 1 : 0) +
      (issuesFilter.hideActive ? 1 : 0) +
      (issuesFilter.hideSubIssues ? 1 : 0),
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

  // Focus management: focus first checkbox on open; restore trigger on close.
  $effect(() => {
    if (typeof window === "undefined") return;
    if (open) {
      const first = popEl?.querySelector<HTMLInputElement>("input[type=checkbox]");
      if (first) {
        // defer so popover is visible before we focus
        setTimeout(() => first.focus(), 0);
      }
    } else {
      btnEl?.focus();
    }
  });
</script>

<button
  bind:this={btnEl}
  class={["filter-chip", { active: open || activeCount > 0 }]}
  type="button"
  aria-haspopup="dialog"
  aria-expanded={open}
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
</div>

<style>
  /* Trigger button — matches the .filter-chip recipe in IssuesPanel.svelte. */
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
</style>
