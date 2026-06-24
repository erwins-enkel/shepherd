<script lang="ts">
  import type { CompletedEpic } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { formatAgo } from "$lib/format";
  import IntegratedEpicLanding from "./IntegratedEpicLanding.svelte";

  let {
    epic,
    ondismiss,
    onackmigrations,
    onland,
    focused = false,
    nowMs = Date.now(),
  }: {
    epic: CompletedEpic;
    ondismiss: (repoPath: string, parent: number) => void;
    onackmigrations: (repoPath: string, parent: number) => void;
    onland: (repoPath: string, parent: number) => void;
    // a Rundown epics-to-land deep-link (#1045) targeted this row → auto-open, scroll into view,
    // and briefly highlight so the operator's eye lands on the Land CTA.
    focused?: boolean;
    nowMs?: number;
  } = $props();

  let open = $state(false);

  let rowEl = $state<HTMLDivElement | null>(null);
  let highlight = $state(false);
  // When this row becomes the deep-link focus, open it, scroll it into view, and flash a highlight.
  $effect(() => {
    if (!focused || !rowEl) return;
    open = true;
    rowEl.scrollIntoView({ behavior: "smooth", block: "center" });
    highlight = true;
    const t = setTimeout(() => (highlight = false), 1600);
    return () => clearTimeout(t);
  });

  // repo basename — last path segment (e.g. "community-map")
  const repoName = $derived(epic.repoPath.split("/").filter(Boolean).at(-1) ?? epic.repoPath);

  // merged = count of shepherd-integrated children; total = all done children
  const total = $derived(epic.children.length);
  const merged = $derived(epic.children.filter((c) => c.integrated).length);

  // Whether this row is in "action needed" open-landing state.
  const isOpen = $derived(epic.landingState === "open");
</script>

<div
  class="row"
  class:row-focused={highlight}
  bind:this={rowEl}
  role="region"
  aria-label={epic.parentTitle}
>
  <button
    type="button"
    class="row-head"
    class:row-head-open={isOpen}
    aria-expanded={open}
    aria-label={open
      ? m.integrated_epics_collapse_aria({ number: epic.parentIssueNumber })
      : m.integrated_epics_expand_aria({ number: epic.parentIssueNumber })}
    onclick={() => (open = !open)}
  >
    <span class="chev" class:collapsed={!open} aria-hidden="true">▾</span>
    <span class="repo" title={repoName}>{repoName}</span>
    <span class="title">{epic.parentTitle}</span>
    <span class="num">#{epic.parentIssueNumber}</span>
    {#if isOpen}
      <span class="chip chip-warn">{m.integrated_epics_awaiting_landing_pill()}</span>
      <span class="chip chip-done chip-secondary">{m.integrated_epics_chip({ merged, total })}</span
      >
    {:else}
      <span class="chip chip-done">{m.integrated_epics_chip({ merged, total })}</span>
    {/if}
    <span class="ago"
      >{m.integrated_epics_finished_ago({ ago: formatAgo(nowMs - epic.completedAt) })}</span
    >
  </button>

  {#if open}
    <ul class="children">
      {#each epic.children as c (c.number)}
        <li class="child">
          {#if c.integrated}
            {#if c.prUrl}
              <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external forge URL -->
              <a class="ref" href={c.prUrl} target="_blank" rel="noopener noreferrer"
                >{c.prNumber != null
                  ? m.integrated_epics_pr_ref({ number: c.prNumber })
                  : m.integrated_epics_pr_ref_nonum()}</a
              >
            {:else if c.prNumber != null}
              <!-- integrated but the PR url was empty at merge time → ref as plain text -->
              <span class="ref">{m.integrated_epics_pr_ref({ number: c.prNumber })}</span>
            {:else}
              <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external forge URL -->
              <a class="ref" href={c.url} target="_blank" rel="noopener noreferrer">#{c.number}</a>
            {/if}
            <span class="title">{c.title}</span>
            <span class="child-ago"
              >{m.integrated_epics_child_merged_ago({
                ago: formatAgo(nowMs - (c.mergedAt ?? epic.completedAt)),
              })}</span
            >
          {:else}
            <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external forge URL -->
            <a class="ref" href={c.url} target="_blank" rel="noopener noreferrer">#{c.number}</a>
            <span class="title">{c.title}</span>
            <span class="closed">{m.integrated_epics_child_closed()}</span>
          {/if}
        </li>
      {/each}
    </ul>

    <IntegratedEpicLanding {epic} {nowMs} {onland} {ondismiss} {onackmigrations} />
  {/if}
</div>

<style>
  .row {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    border-radius: 3px;
    transition: box-shadow 0.4s ease;
  }
  /* Deep-link highlight (#1045): a brief amber ring when a Rundown epics-to-land item targets this
     row, drawing the eye to the Land CTA. Fades out after ~1.6s. */
  .row-focused {
    box-shadow: 0 0 0 2px var(--color-amber);
  }

  /* Collapsed header — quiet/slate, matching the done-state recipe. */
  .row-head {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    border: 0;
    background: none;
    font: inherit;
    color: var(--status-done);
    text-align: left;
    cursor: pointer;
    padding: 4px 8px;
  }
  /* Open-landing re-tone: action-needed warn hue on the head */
  .row-head.row-head-open {
    color: var(--status-warn);
  }
  .row-head:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }

  .chev {
    flex: none;
    transition: transform 0.12s ease;
  }
  .chev.collapsed {
    transform: rotate(-90deg);
  }

  .repo {
    flex: 0 1 auto;
    min-width: 0;
    color: var(--color-muted);
    max-width: 16ch;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .title {
    flex: 1;
    min-width: 0;
    color: var(--color-ink);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .num {
    flex: none;
    color: var(--color-muted);
  }

  .ago {
    flex: none;
    color: var(--color-faint);
    font-size: var(--fs-micro);
  }

  /* Slate "done" chip — NEVER green; mirrors EpicPanel's .chip-done recipe. */
  .chip {
    flex: none;
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 1px 5px;
    border-radius: 2px;
    white-space: nowrap;
  }
  .chip-done {
    color: var(--status-done);
    background: color-mix(in oklab, var(--status-done) 12%, transparent);
  }
  /* Secondary (smaller, less prominent) done chip alongside the warn pill */
  .chip-secondary {
    opacity: 0.7;
  }
  /* Warn chip for "Awaiting landing" action-needed state */
  .chip-warn {
    color: var(--status-warn);
    background: color-mix(in oklab, var(--status-warn) 12%, transparent);
  }

  /* Expanded rollup. */
  .children {
    margin: 0;
    padding: 0 8px;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .child {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }
  .ref {
    flex: none;
    color: var(--color-muted);
    font-size: var(--fs-micro);
    text-decoration: none;
  }
  .ref:hover {
    color: var(--color-ink-bright);
    text-decoration: underline;
  }
  .child-ago {
    flex: none;
    color: var(--color-faint);
    font-size: var(--fs-micro);
  }
  .closed {
    flex: none;
    color: var(--color-faint);
    font-size: var(--fs-micro);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
</style>
