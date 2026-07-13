<script lang="ts">
  import type { Issue } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { relativeAge } from "$lib/format";
  import { clock } from "$lib/now.svelte";

  // Small anchored, non-blocking preview of an issue — a "little more" than the row
  // shows: number · author · age, title, all labels, and the body (plain text,
  // scrollable). Per the design system's popover rule it gets NO scrim/blur — it
  // dismisses on outside-click, Esc or ANCESTOR scroll. Escape is intercepted in
  // capture phase + preventDefault so a11yDialog (NewTask / BacklogOverlay) doesn't
  // also close the host dialog.
  let {
    x,
    y,
    issue,
    opener,
    onclose,
  }: {
    x: number;
    y: number;
    issue: Issue;
    // the row that opened the popover — focus returns here on close
    opener?: HTMLElement;
    onclose: () => void;
  } = $props();

  let el = $state<HTMLDivElement>();

  let pos = $state<{ left: number; top: number } | null>(null);
  $effect(() => {
    const node = el;
    if (!node) return;
    const r = node.getBoundingClientRect();
    const margin = 8;
    const left = Math.min(x, window.innerWidth - r.width - margin);
    const top = Math.min(y, window.innerHeight - r.height - margin);
    pos = { left: Math.max(margin, left), top: Math.max(margin, top) };
    node.focus(); // take focus so Esc is caught here and returns to the opener on close
  });

  $effect(() => {
    function onKeydown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onclose();
    }
    function onPointer(e: Event) {
      if (el && !el.contains(e.target as Node)) onclose();
    }
    function onScroll(e: Event) {
      // Ignore scrolls that originate INSIDE the popover — its own body scrolls when
      // the issue body is long, and that must NOT dismiss it. Only ancestor/anchor
      // scroll (the list behind it moving) closes it.
      if (el?.contains(e.target as Node)) return;
      onclose();
    }
    window.addEventListener("keydown", onKeydown, { capture: true });
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKeydown, { capture: true });
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("scroll", onScroll, true);
      const target = opener;
      queueMicrotask(() => {
        if (target?.isConnected && document.activeElement === document.body) target.focus();
      });
    };
  });
</script>

<div
  bind:this={el}
  class="issue-details"
  role="dialog"
  tabindex="-1"
  aria-label={m.issuedetails_aria({ number: issue.number })}
  style="left:{pos?.left ?? x}px;top:{pos?.top ?? y}px"
>
  <div class="id-head">
    <span class="id-num">#{issue.number}</span>
    {#if issue.author}
      <span class="id-author">{m.issuerow_author_by({ login: issue.author })}</span>
    {/if}
    <span class="id-age">{relativeAge(issue.createdAt, clock.current)}</span>
  </div>
  <div class="id-title">{issue.title}</div>
  {#if issue.labels.length > 0}
    <div class="id-labels">
      {#each issue.labels as label (label)}
        <span class="id-chip">{label}</span>
      {/each}
    </div>
  {/if}
  <div class="id-body">
    {#if issue.body?.trim()}
      {issue.body}
    {:else}
      <span class="id-empty">{m.issuedetails_no_body()}</span>
    {/if}
  </div>
</div>

<style>
  .issue-details {
    position: fixed;
    z-index: 60;
    width: min(360px, calc(100vw - 16px));
    padding: 10px 12px;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    border-radius: 3px;
    /* established popover shadow (matches CardMenu/SteerMenu) — no token exists */
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-family: var(--font-mono);
  }
  .issue-details:focus {
    outline: none;
  }
  .id-head {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 8px;
    font-size: var(--fs-micro);
    color: var(--color-faint);
  }
  .id-num {
    color: var(--color-muted);
  }
  .id-author {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 20ch;
  }
  .id-title {
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
    line-height: 1.4;
    word-break: break-word;
  }
  .id-labels {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .id-chip {
    font-size: var(--fs-micro);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--color-muted);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    padding: 1px 5px;
  }
  .id-body {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 40vh;
    overflow-y: auto;
    border-top: 1px solid var(--color-line);
    padding-top: 6px;
  }
  .id-body::-webkit-scrollbar {
    width: 4px;
  }
  .id-body::-webkit-scrollbar-track {
    background: transparent;
  }
  .id-body::-webkit-scrollbar-thumb {
    background: var(--color-faint);
    border-radius: 2px;
  }
  .id-empty {
    color: var(--color-faint);
    font-style: italic;
  }
</style>
