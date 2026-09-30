<script lang="ts">
  import { anchorPopover } from "$lib/floating-anchor";
  import { m } from "$lib/paraglide/messages";

  // Repo-list filters ("Has issues" / "Has PRs") behind a funnel icon next to the repo
  // search — the /design-system "Filter popover" recipe, like PrFilterPopover. The parent
  // (BacklogView, via ProjectBacklogList) owns the state; this only renders + toggles it.
  let {
    hasIssues,
    hasPRs,
    ontoggleissues,
    ontoggleprs,
  }: {
    hasIssues: boolean;
    hasPRs: boolean;
    ontoggleissues: () => void;
    ontoggleprs: () => void;
  } = $props();

  // SSR-stable per-instance id for aria-controls wiring.
  const popoverId = $props.id();

  let open = $state(false);
  let wasOpen = false; // tracks previous open value; not reactive — managed in the focus effect
  let btnEl = $state<HTMLButtonElement | null>(null);
  let popEl = $state<HTMLDivElement | null>(null);

  const activeCount = $derived((hasIssues ? 1 : 0) + (hasPRs ? 1 : 0));

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
  });
</script>

<button
  bind:this={btnEl}
  class={["repo-filter-trigger", { active: open || activeCount > 0 }]}
  type="button"
  aria-haspopup="dialog"
  aria-expanded={open}
  aria-controls={popoverId}
  aria-label={m.backlog_repo_filter_aria({ count: activeCount })}
  title={m.backlog_repo_filter_heading()}
  onclick={() => (open = !open)}
>
  <svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true">
    <path
      d="M4.25 5.61C6.27 8.2 10 13 10 13v6c0 .55.45 1 1 1h2c.55 0 1-.45 1-1v-6s3.72-4.8 5.74-7.39A.998.998 0 0 0 18.95 4H5.04c-.83 0-1.3.95-.79 1.61z"
    />
  </svg>
  {#if activeCount > 0}
    <span class="badge" aria-hidden="true">{activeCount}</span>
  {/if}
</button>

<!-- popover="manual": native top-layer, escapes overflow:hidden containers.
     position:fixed + inset:auto + margin:0 so Floating UI's left/top drive placement.
     Non-modal: no aria-modal, no scrim (small anchored non-blocking popover, exempt per .claude/rules/ui-design-system.md). -->
<div
  id={popoverId}
  bind:this={popEl}
  class="filter-popover"
  role="dialog"
  aria-label={m.backlog_repo_filter_heading()}
  popover="manual"
>
  <label class="filter-row">
    <input type="checkbox" checked={hasIssues} onchange={ontoggleissues} />
    <span class="row-label">{m.backlog_filter_has_issues()}</span>
  </label>
  <label class="filter-row">
    <input type="checkbox" checked={hasPRs} onchange={ontoggleprs} />
    <span class="row-label">{m.backlog_filter_has_prs()}</span>
  </label>
</div>

<style>
  /* Square icon trigger — the .filter-chip look (transparent at rest, lined when
     active) at the search field's 36px height. */
  .repo-filter-trigger {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 36px;
    min-height: 36px;
    padding: 0;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 2px;
    color: var(--color-muted);
    font-size: var(--fs-base);
    cursor: pointer;
    touch-action: manipulation;
    transition:
      color 0.12s,
      border-color 0.12s;
  }

  .repo-filter-trigger:hover {
    color: var(--color-ink);
  }

  .repo-filter-trigger.active {
    color: var(--color-ink-bright);
    border-color: var(--color-line-bright);
    background: var(--color-inset);
  }

  .repo-filter-trigger:focus-visible {
    outline: 2px solid var(--color-line-bright);
    outline-offset: 2px;
  }

  @media (pointer: coarse) {
    .repo-filter-trigger {
      width: 44px;
      min-height: 44px;
    }
  }

  /* Active-filter count, tucked into the icon's top-right corner. */
  .badge {
    position: absolute;
    top: 2px;
    right: 2px;
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

  /* Top-layer popover: position:fixed + inset:auto + margin:0 lets Floating UI
     drive left/top without fighting browser default centering. */
  [popover].filter-popover {
    position: fixed;
    inset: auto;
    margin: 0;
    min-width: 180px;
    max-width: min(320px, 90vw);
    padding: 6px 0;
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
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    cursor: pointer;
  }

  .filter-row:hover {
    background: var(--color-surface);
  }

  .filter-row input[type="checkbox"] {
    flex-shrink: 0;
    cursor: pointer;
  }

  .row-label {
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.05em;
  }
</style>
