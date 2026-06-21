<script lang="ts">
  import type { DocAgentRun } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { anchorPopover } from "$lib/floating-anchor";
  import { coachTarget } from "$lib/actions/coachTarget.svelte";
  import { formatAgo } from "$lib/format";
  import { clock } from "$lib/now.svelte";

  let {
    act,
    running,
    runs,
    disabled,
    coach,
    ontrigger,
  }: {
    act: boolean;
    running: boolean;
    runs: DocAgentRun[];
    disabled: boolean;
    coach: boolean;
    ontrigger: () => void;
  } = $props();

  // SSR-stable per-instance id for aria-controls wiring.
  const popoverId = $props.id();

  let open = $state(false);
  let wasOpen = false;
  let badgeBtnEl = $state<HTMLButtonElement | null>(null);
  let popEl = $state<HTMLDivElement | null>(null);

  const showBadge = $derived(running || runs.length > 0);

  // Badge label + color variant
  const badgeLabel = $derived(
    running
      ? m.docagent_status_running()
      : runs[0]?.outcome === "pr"
        ? m.docagent_status_pr()
        : runs[0]?.outcome === "observe"
          ? m.docagent_status_observe()
          : m.docagent_status_nochange(),
  );

  const badgeVariant = $derived(running ? "running" : runs[0]?.outcome === "pr" ? "pr" : "muted");

  // Position the popover below the badge whenever open + both elements exist.
  $effect(() => {
    if (!open || !badgeBtnEl || !popEl) return;
    try {
      popEl.showPopover();
    } catch {
      return;
    }
    return anchorPopover(badgeBtnEl, popEl, 6, "bottom");
  });

  // Dismiss on Esc + outside pointerdown.
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
        badgeBtnEl &&
        !badgeBtnEl.contains(e.target as Node)
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

  // Focus management: restore trigger on close.
  $effect(() => {
    if (typeof window === "undefined") return;
    if (open) {
      wasOpen = true;
    } else if (wasOpen) {
      badgeBtnEl?.focus();
    }
  });

  function prNumber(url: string): string | null {
    return url.match(/\/(\d+)(?:[/?#]|$)/)?.[1] ?? null;
  }

  function outcomeLabel(outcome: DocAgentRun["outcome"]): string {
    if (outcome === "pr") return m.docagent_status_pr();
    if (outcome === "observe") return m.docagent_status_observe();
    return m.docagent_status_nochange();
  }
</script>

<div class="doc-agent-control">
  <!-- Trigger button -->
  <button
    class="gbtn da-btn"
    type="button"
    disabled={disabled || running}
    onclick={ontrigger}
    title={m.docagent_button_title()}
    aria-label={m.docagent_button_title()}
    use:coachTarget={coach ? "doc-agent-trigger" : ""}
  >
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <rect
        x="1"
        y="1"
        width="10"
        height="10"
        rx="1"
        stroke="currentColor"
        stroke-width="1.2"
        fill="none"
      />
      <line x1="3" y1="4" x2="9" y2="4" stroke="currentColor" stroke-width="1.1" />
      <line x1="3" y1="6.5" x2="9" y2="6.5" stroke="currentColor" stroke-width="1.1" />
      <line x1="3" y1="9" x2="6.5" y2="9" stroke="currentColor" stroke-width="1.1" />
    </svg>
    {m.docagent_button_label()}
  </button>

  <!-- Status badge (only when running or runs exist) -->
  {#if showBadge}
    <button
      bind:this={badgeBtnEl}
      class={["status-badge", badgeVariant]}
      type="button"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={popoverId}
      onclick={() => (open = !open)}
    >
      {badgeLabel}
    </button>
  {/if}
</div>

<!-- History popover — non-modal anchored popover, no scrim (see CLAUDE.md) -->
<div
  id={popoverId}
  bind:this={popEl}
  class="da-popover"
  role="dialog"
  aria-label={m.docagent_history_heading()}
  popover="manual"
>
  <div class="pop-head">{m.docagent_history_heading()}</div>
  {#if runs.length === 0}
    <div class="pop-empty">{m.docagent_history_empty()}</div>
  {:else}
    <ul class="run-list">
      {#each runs as run (run.at)}
        <li class="run-row">
          <span class="run-time">{formatAgo(clock.current - run.at)}</span>
          <span class="run-outcome">{outcomeLabel(run.outcome)}</span>
          {#if run.url}
            <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external forge URL, not an app route -->
            <a class="run-link" href={run.url} target="_blank" rel="noopener">
              #{prNumber(run.url) ?? m.docagent_history_pr_link()}
            </a>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
  {#if !act}
    <div class="pop-note">{m.docagent_observe_note()}</div>
  {/if}
</div>

<style>
  .doc-agent-control {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }

  /* Trigger button — mirrors .ff-btn / .gbtn in BacklogTabBar */
  .gbtn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 2px 8px;
    cursor: pointer;
    transition:
      border-color 0.12s,
      color 0.12s;
  }
  .gbtn:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .gbtn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .da-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
  }

  /* Status badge — micro-badge recipe */
  .status-badge {
    display: inline-flex;
    align-items: center;
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 1px 6px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    background: transparent;
    color: var(--color-muted);
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
    transition:
      color 0.12s,
      border-color 0.12s;
  }
  .status-badge:hover {
    border-color: var(--color-line-bright);
    color: var(--color-ink);
  }
  .status-badge:focus-visible {
    outline: 2px solid var(--color-line-bright);
    outline-offset: 2px;
  }

  /* Running state — amber pulse (merge-pulse defined globally in app.css). No
     !important: the badge TEXT ("running") carries the state, so the pulse is
     decorative reinforcement and must yield to the app.css prefers-reduced-motion
     guard (matches the sibling .badge.merging in PrRow.svelte). */
  .status-badge.running {
    color: var(--color-amber);
    border-color: color-mix(in srgb, var(--color-amber) 45%, transparent);
    animation: merge-pulse 1.5s ease-in-out infinite;
  }

  /* PR opened state — green */
  .status-badge.pr {
    color: var(--color-green);
    border-color: color-mix(in srgb, var(--color-green) 45%, transparent);
  }

  /* History popover surface — mirrors .filter-popover from IssueFilterPopover */
  [popover].da-popover {
    position: fixed;
    inset: auto;
    margin: 0;
    min-width: 260px;
    max-width: min(340px, 90vw);
    padding: 0;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-meta);
    line-height: 1.5;
  }

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
  [popover].da-popover:popover-open {
    animation: popover-in 120ms ease-out;
  }

  .pop-head {
    padding: 7px 12px 6px;
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--color-muted);
    border-bottom: 1px solid var(--color-line);
  }

  .pop-empty {
    padding: 10px 12px;
    color: var(--color-faint);
    font-size: var(--fs-meta);
  }

  .run-list {
    list-style: none;
    margin: 0;
    padding: 4px 0;
  }

  .run-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 12px;
    font-size: var(--fs-meta);
  }

  .run-row:hover {
    background: var(--color-surface);
  }

  .run-time {
    color: var(--color-muted);
    flex-shrink: 0;
    min-width: 6ch;
  }

  .run-outcome {
    color: var(--color-ink);
    flex: 1;
    font-size: var(--fs-micro);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .run-link {
    color: var(--color-accent);
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    text-decoration: none;
    flex-shrink: 0;
  }
  .run-link:hover {
    text-decoration: underline;
  }

  .pop-note {
    padding: 6px 12px 8px;
    font-size: var(--fs-micro);
    color: var(--color-muted);
    border-top: 1px solid var(--color-line);
    line-height: 1.4;
  }
</style>
