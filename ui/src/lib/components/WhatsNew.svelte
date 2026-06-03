<script lang="ts">
  import { fly } from "svelte/transition";
  import { dialog } from "$lib/a11yDialog";
  import { m } from "$lib/paraglide/messages";
  import type { FeatureAnnouncement } from "$lib/feature-announcements";

  let {
    entries,
    ondismiss,
    onclose,
  }: {
    entries: FeatureAnnouncement[];
    ondismiss: () => void;
    onclose: () => void;
  } = $props();

  const reduceMotion =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const slide = { x: 440, duration: reduceMotion ? 0 : 220, opacity: 1 };

  function dismiss() {
    ondismiss();
    onclose();
  }
</script>

<div
  class="scrim"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose();
  }}
>
  <div
    class="drawer"
    role="dialog"
    aria-modal="true"
    aria-label={m.whatsnew_title()}
    use:dialog={{ onclose }}
    transition:fly={slide}
  >
    <header class="bar">
      <span class="title">{m.whatsnew_title()}</span>
      <button class="close" onclick={() => onclose()} aria-label={m.common_close()}>✕</button>
    </header>

    {#if entries.length === 0}
      <p class="empty">{m.whatsnew_empty()}</p>
    {:else}
      <ul class="list">
        {#each entries as entry (entry.id)}
          <li class="entry">
            <h3 class="entry-title">
              {(m as unknown as Record<string, () => string>)[entry.titleKey]()}
            </h3>
            <p class="entry-body">
              {(m as unknown as Record<string, () => string>)[entry.bodyKey]()}
            </p>
          </li>
        {/each}
      </ul>
    {/if}

    <footer class="foot">
      <button class="dismiss" onclick={dismiss}>{m.whatsnew_dismiss()}</button>
    </footer>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: var(--color-scrim);
    z-index: 50;
  }
  .drawer {
    position: fixed;
    top: 0;
    right: 0;
    width: min(440px, 100vw);
    height: 100dvh;
    background: var(--color-panel);
    border-left: 1px solid var(--color-line-bright);
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px;
    overflow-y: auto;
    z-index: 51;
  }
  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
  }
  .title {
    letter-spacing: 0.14em;
    font-size: 12px;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .close {
    background: none;
    border: none;
    color: var(--color-muted);
    cursor: pointer;
    font-size: 14px;
  }
  .empty {
    color: var(--color-muted);
    font-size: 13px;
    line-height: 1.5;
    flex: 1;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 16px;
    flex: 1;
    overflow-y: auto;
  }
  .entry {
    border: 1px solid var(--color-line);
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .entry-title {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--color-ink-bright);
    letter-spacing: 0.04em;
  }
  .entry-body {
    margin: 0;
    font-size: 12.5px;
    color: var(--color-muted);
    line-height: 1.5;
  }
  .foot {
    display: flex;
    justify-content: flex-end;
    flex-shrink: 0;
    padding-top: 4px;
    border-top: 1px solid var(--color-line);
  }
  .dismiss {
    background: transparent;
    border: 1px solid var(--color-amber);
    color: var(--color-amber);
    font-weight: 600;
    padding: 8px 16px;
    cursor: pointer;
    letter-spacing: 0.06em;
    box-shadow: inset 0 0 18px -10px var(--color-amber);
    font-size: 12px;
  }
  .dismiss:focus-visible {
    outline: 1px solid var(--color-amber);
    outline-offset: 2px;
  }
</style>
