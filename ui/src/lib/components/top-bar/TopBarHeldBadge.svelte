<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import { formatResetIn } from "$lib/format";
  import type { Gauge } from "../usage-gauges";
  import type { HeldTask } from "$lib/types";

  let {
    heldCount,
    mobile,
    compactBadges,
    hotter,
    nowMs,
    heldPopFlipUp,
    heldItems,
    heldLoading,
    heldPopOpen = $bindable(),
    heldBadgeBtn = $bindable(null),
    heldPopEl = $bindable(null),
    toggleHeldPop,
    doSpawnHeld,
    doDiscardHeld,
  }: {
    heldCount: number;
    mobile: boolean;
    compactBadges: boolean;
    hotter: Gauge | null;
    nowMs: number;
    heldPopFlipUp: boolean;
    heldItems: HeldTask[];
    heldLoading: boolean;
    heldPopOpen: boolean;
    heldBadgeBtn: HTMLButtonElement | null;
    heldPopEl: HTMLDivElement | null;
    toggleHeldPop: () => void;
    doSpawnHeld: (id: string) => void;
    doDiscardHeld: (id: string) => void;
  } = $props();
</script>

{#if (heldCount ?? 0) > 0}
  <!-- Held-tasks badge: non-modal anchored popover (design-system exemption). -->
  <div class="held-wrap">
    <button
      bind:this={heldBadgeBtn}
      class="held-badge"
      class:compact={mobile || compactBadges}
      type="button"
      aria-haspopup="dialog"
      aria-expanded={heldPopOpen}
      aria-label={m.topbar_held_badge({ count: heldCount ?? 0 })}
      onclick={toggleHeldPop}
    >
      {#if mobile || compactBadges}
        <span class="held-n">{heldCount}</span>
      {:else}
        <span>{m.topbar_held_badge({ count: heldCount ?? 0 })}</span>
        {#if hotter?.w.resetAt}
          <span class="held-reset"
            >{m.topbar_held_resets({ time: formatResetIn(hotter.w.resetAt, nowMs) })}</span
          >
        {/if}
      {/if}
    </button>
    {#if heldPopOpen}
      <div
        bind:this={heldPopEl}
        class={["held-pop", { "flip-up": heldPopFlipUp }]}
        role="dialog"
        aria-label={m.topbar_held_title()}
        tabindex="-1"
      >
        <div class="held-pop-head">{m.topbar_held_title()}</div>
        {#if heldLoading}
          <div class="held-pop-empty">{m.common_loading()}</div>
        {:else if heldItems.length === 0}
          <div class="held-pop-empty">{m.topbar_held_empty()}</div>
        {:else}
          {#each heldItems as task (task.id)}
            <div class="held-row">
              <div class="held-row-info">
                <span class="held-row-prompt">{task.input.prompt}</span>
                <span class="held-row-repo">{task.repoPath.split("/").at(-1) ?? task.repoPath}</span
                >
              </div>
              <div class="held-row-actions">
                <button
                  type="button"
                  class="held-action held-spawn"
                  onclick={() => doSpawnHeld(task.id)}>{m.topbar_held_spawn_now()}</button
                >
                <button
                  type="button"
                  class="held-action held-discard"
                  onclick={() => doDiscardHeld(task.id)}>{m.topbar_held_discard()}</button
                >
              </div>
            </div>
          {/each}
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  /* ── Held-tasks badge + popover ──────────────────────────────────────────── */
  .held-wrap {
    position: relative;
  }
  .held-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    background: transparent;
    border: 1px solid var(--color-amber);
    border-radius: 2px;
    color: var(--color-amber);
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.06em;
    padding: 3px 8px;
    cursor: pointer;
    white-space: nowrap;
  }
  .held-badge:hover {
    background: color-mix(in srgb, var(--color-amber) 10%, transparent);
  }
  .held-badge .held-n {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .held-badge .held-reset {
    color: color-mix(in srgb, var(--color-amber) 70%, transparent);
    font-size: var(--fs-micro);
  }
  /* Anchored popover — mirrors .auto-pop from AutomationPanel */
  .held-pop {
    position: absolute;
    top: 100%;
    right: 0;
    z-index: 20;
    margin-top: 4px;
    width: 300px;
    max-width: 90vw;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
    color: var(--color-ink);
    max-height: 85vh;
    overflow-y: auto;
  }
  .held-pop.flip-up {
    top: auto;
    bottom: 100%;
    margin-top: 0;
    margin-bottom: 4px;
  }
  @media (pointer: coarse) {
    /* Touch: keep the popover ANCHORED (not fixed-centered) so it stays a small
       non-blocking popover exempt from the modal scrim rule (CLAUDE.md). The
       flip-up + height-clamp $effect already handles overflow on coarse-pointer
       devices. Widen slightly for thumb reach. */
    .held-pop {
      width: min(360px, 92vw);
    }
    .held-badge {
      min-height: 44px;
      min-width: 44px;
    }
  }
  .held-pop-head {
    font-size: var(--fs-micro);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-muted);
    padding: 10px 12px 6px;
  }
  .held-pop-empty {
    font-size: var(--fs-meta);
    color: var(--color-faint);
    padding: 6px 12px 10px;
  }
  .held-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
    padding: 6px 12px;
    border-top: 1px solid var(--color-line);
  }
  .held-row-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }
  .held-row-prompt {
    font-size: var(--fs-meta);
    color: var(--color-ink-bright);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 22ch;
  }
  .held-row-repo {
    font-size: var(--fs-micro);
    color: var(--color-muted);
    letter-spacing: 0.04em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .held-row-actions {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex-shrink: 0;
  }
  .held-action {
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    font: inherit;
    font-size: var(--fs-micro);
    letter-spacing: 0.06em;
    padding: 2px 8px;
    cursor: pointer;
    white-space: nowrap;
    color: var(--color-ink);
  }
  .held-action:hover {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .held-spawn {
    color: var(--color-amber);
    border-color: var(--color-amber);
  }
  .held-spawn:hover {
    background: color-mix(in srgb, var(--color-amber) 10%, transparent);
  }
</style>
