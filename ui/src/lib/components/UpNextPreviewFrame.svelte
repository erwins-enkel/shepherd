<script lang="ts">
  import type { Snippet } from "svelte";
  import { m } from "#lib/paraglide/messages.js";
  import { upNextUi } from "#lib/up-next-ui.svelte.js";
  import { swipeBack } from "./swipe-back";

  // The shell both Up Next previews (issue, PR) read in: the bar — position, ‹ › through the
  // rows of the preview's kind, × on desktop or ← Back on the phone — the scrolling body, the
  // empty state, Esc to close and, on the phone, a rightward swipe back to the list. It also
  // owns the action row's shared recipe (.unp-actions, .gbtn, the split ▾, the batch tick) for
  // the markup the previews render into it.
  let {
    label,
    prevLabel,
    nextLabel,
    order,
    current,
    onback = undefined,
    onescape = () => false,
    children,
  }: {
    /** The section's accessible name. */
    label: string;
    prevLabel: string;
    nextLabel: string;
    /** The keys ‹ › step through, in on-screen order. */
    order: string[];
    /** The open row's key; null shows the empty state. */
    current: string | null;
    /** Phone: the preview replaced the list; Back (and a swipe) returns to it. */
    onback?: () => void;
    /** Esc reached the preview: true when the preview used it itself (closed a menu). */
    onescape?: () => boolean;
    children: Snippet;
  } = $props();

  const index = $derived(current ? order.indexOf(current) : -1);
  const total = $derived(order.length);

  function step(by: number) {
    if (index < 0 || total < 2) return;
    upNextUi.previewKey = order[(index + by + total) % total]!;
  }
  function close() {
    if (onback) onback();
    else upNextUi.previewKey = null;
  }
  let dragX = $state(0); // rubber-banded display offset (px, ≥ 0)
  const backSwipe = swipeBack({ onback: () => onback?.(), onoffset: (px) => (dragX = px) });

  function onkeydown(e: KeyboardEvent) {
    if (e.key !== "Escape" || e.defaultPrevented || onescape()) return;
    e.preventDefault();
    close();
  }
</script>

<!-- Esc closes the preview while focus is inside it (the handler only listens). -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section
  class="unp"
  class:swiping={dragX > 0}
  aria-label={label}
  {onkeydown}
  {@attach onback ? backSwipe : undefined}
  style:transform={dragX > 0 ? `translateX(${dragX}px)` : undefined}
>
  <div class="unp-bar">
    {#if onback}
      <button type="button" class="unp-back" onclick={onback}>← {m.issuedetail_back()}</button>
    {:else}
      <span class="unp-label">{m.upnext_preview_title()}</span>
    {/if}
    {#if index >= 0}
      <span class="unp-pos">{m.upnext_preview_position({ index: index + 1, total })}</span>
    {/if}
    <span class="unp-spacer"></span>
    {#if current}
      <button
        type="button"
        class="icon-btn unp-icon"
        disabled={total < 2}
        title={prevLabel}
        aria-label={prevLabel}
        onclick={() => step(-1)}>‹</button
      >
      <button
        type="button"
        class="icon-btn unp-icon"
        disabled={total < 2}
        title={nextLabel}
        aria-label={nextLabel}
        onclick={() => step(1)}>›</button
      >
      {#if !onback}
        <button
          type="button"
          class="icon-btn unp-icon"
          title={m.common_close()}
          aria-label={m.common_close()}
          onclick={close}>×</button
        >
      {/if}
    {/if}
  </div>

  {#if current}
    <div class="unp-body">{@render children()}</div>
  {:else}
    <p class="unp-empty">{m.upnext_preview_empty()}</p>
  {/if}
</section>

<style>
  .unp {
    border: 1px solid var(--color-line);
    background: var(--color-panel);
    display: flex;
    flex-direction: column;
    /* .unp-body scrolls; the bar with ‹ › × stays put. */
    overflow: hidden;
    min-height: 0;
    min-width: 0;
    flex: 1;
    transition: transform 0.18s ease-out;
  }
  /* Mid swipe-back: follows the finger 1:1, lifted off the shell behind it. */
  .unp.swiping {
    transition: none;
    box-shadow: var(--shadow-popover);
  }

  .unp-bar {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    border-bottom: 1px solid var(--color-line);
  }
  .unp-label {
    font-size: var(--fs-meta);
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-ink-bright);
  }
  .unp-pos {
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .unp-spacer {
    flex: 1;
  }
  .unp-back {
    padding: 4px 2px;
    background: none;
    border: 0;
    font-family: inherit;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    cursor: pointer;
  }
  .unp-back:hover {
    color: var(--color-ink);
  }
  /* Global .icon-btn recipe (app.css), with the text glyphs ‹ › × sized up. */
  .unp-icon {
    font: inherit;
    font-size: var(--fs-lg);
    line-height: 1;
    color: var(--color-muted);
  }

  .unp-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 20px 24px 32px;
  }
  .unp-body > :global(*) {
    max-width: 80ch;
  }
  /* The action row is a toolbar, not prose: it takes the pane's full width so more steers
     fit inline before the ▾ takes over. */
  .unp-body > :global(.unp-actions) {
    max-width: none;
  }

  .unp-body :global(.unp-actions) {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    padding-block: 10px;
    border-block: 1px solid var(--color-line);
  }
  .unp-body :global(.unp-start) {
    flex: none;
    display: inline-flex;
  }
  .unp-body :global(.gbtn.split) {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
  }
  .unp-body :global(.gbtn.primary.unp-more) {
    padding-inline: 8px;
    border-left-color: var(--color-line-bright);
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
  }
  .unp-body :global(.gbtn.primary.unp-more.open) {
    background: var(--color-amber);
    color: var(--color-bg);
  }
  .unp-body :global(.unp-pick) {
    flex: none;
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--fs-meta);
    color: var(--color-ink);
    cursor: pointer;
  }
  .unp-body :global(.unp-pick input) {
    margin: 0;
    accent-color: var(--color-amber);
    cursor: pointer;
  }

  /* Canonical .gbtn recipe (/design-system), shared by both previews' markup. */
  .unp-body :global(.gbtn) {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 12px;
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    font-weight: 700;
    letter-spacing: 0.08em;
    cursor: pointer;
  }
  .unp-body :global(.gbtn.primary) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .unp-body :global(.gbtn.primary:hover:not(:disabled):not([aria-disabled="true"])) {
    background: var(--color-amber);
    color: var(--color-bg);
  }
  .unp-body :global(.gbtn:focus-visible) {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .unp-body :global(.gbtn:disabled) {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .unp-empty {
    flex: 1;
    margin: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    text-align: center;
    color: var(--color-faint);
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }

  @media (max-width: 768px), (pointer: coarse) {
    .unp-icon,
    .unp-body :global(.unp-more) {
      min-width: var(--mobile-actionbar-hit);
    }
    .unp-icon {
      width: var(--mobile-actionbar-hit);
      height: var(--mobile-actionbar-hit);
    }
    .unp-back,
    .unp-body :global(.gbtn),
    .unp-body :global(.unp-pick) {
      min-height: var(--mobile-actionbar-hit);
    }
    .unp-body {
      padding: 14px;
    }
    /* A preview whose actions stack on the phone, full width, the primary first. */
    .unp-body :global(.unp-actions.stack-on-phone) {
      flex-direction: column;
      align-items: stretch;
    }
  }
</style>
