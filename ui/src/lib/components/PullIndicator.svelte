<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import type { PullStage } from "#lib/pull-gesture.js";

  // A phone pull-down hint (#lib/actions/pullToCommand): the herd list's, or New Task's with
  // repo labels. aria-hidden: the gesture is a shortcut — what it opens stays reachable without it.
  let {
    stage,
    distance,
    pullLabel = m.mobile_pull_search(),
    releaseLabel = m.mobile_release_search(),
  }: { stage: PullStage; distance: number; pullLabel?: string; releaseLabel?: string } = $props();

  const label = $derived(
    stage === "reload" ? m.mobile_release_reload() : stage === "search" ? releaseLabel : pullLabel,
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
