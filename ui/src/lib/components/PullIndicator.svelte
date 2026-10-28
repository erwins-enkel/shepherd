<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import type { PullStage } from "#lib/pull-gesture.js";

  // The phone herd list's pull-down hint (#lib/actions/pullToCommand). aria-hidden: the
  // gesture is a shortcut — the command bar and reload stay reachable without it.
  let { stage, distance }: { stage: PullStage; distance: number } = $props();

  const label = $derived(
    stage === "reload"
      ? m.mobile_release_reload()
      : stage === "search"
        ? m.mobile_release_search()
        : m.mobile_pull_search(),
  );
</script>

{#if distance > 0}
  <div
    class="pull"
    class:ready={stage !== "idle"}
    style:transform="translate(-50%, {distance}px)"
    aria-hidden="true"
  >
    <svg
      class="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      {#if stage === "reload"}
        <path d="M20 12a8 8 0 1 1-2.34-5.66" />
        <path d="M20 4v5h-5" />
      {:else}
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.6-3.6" />
      {/if}
    </svg>
    <span>{label}</span>
  </div>
{/if}

<style>
  .pull {
    position: fixed;
    top: calc(env(safe-area-inset-top) - 44px);
    left: 50%;
    z-index: 50;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: 36px;
    padding: 0 14px;
    background: var(--color-panel);
    border: 1px solid var(--color-line);
    border-radius: 18px;
    box-shadow: var(--shadow-popover);
    color: var(--color-muted);
    font-size: var(--fs-base);
    white-space: nowrap;
    pointer-events: none;
  }
  .pull.ready {
    border-color: var(--color-line-bright);
    color: var(--color-ink);
  }
  .icon {
    width: var(--fs-lg);
    height: var(--fs-lg);
    display: block;
    flex-shrink: 0;
  }
</style>
