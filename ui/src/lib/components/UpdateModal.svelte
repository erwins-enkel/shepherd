<script lang="ts">
  import type { UpdateStatus, DeployState, MachineUpdate } from "#lib/types.js";
  import { dialog } from "#lib/a11yDialog.js";
  import { m } from "#lib/paraglide/messages.js";
  import SvgFlockOverlay from "#lib/components/SvgFlockOverlay.svelte";
  import { LocalUpdate } from "#lib/components/update/local-update.svelte.js";
  import UpdateSolo from "#lib/components/update/UpdateSolo.svelte";
  import UpdateFleet from "#lib/components/update/UpdateFleet.svelte";

  let {
    update,
    machines = [],
    updating = false,
    deploy = null,
    onconfirm,
    onclose,
  }: {
    /** This Shepherd's own update; null before the first check. */
    update: UpdateStatus | null;
    /** Connected machines. With any, the window lists every machine instead of one commit list. */
    machines?: MachineUpdate[];
    updating?: boolean;
    /** set once a launched deploy reports failure → show the captured reason */
    deploy?: DeployState | null;
    onconfirm?: () => void;
    onclose?: () => void;
  } = $props();

  const NO_UPDATE: UpdateStatus = {
    behind: 0,
    current: null,
    latest: null,
    commits: [],
    checkedAt: 0,
  };
  const local = new LocalUpdate(() => ({
    update: update ?? NO_UPDATE,
    updating,
    deploy,
    onconfirm,
  }));

  const fleet = $derived(machines.length > 0);
  // set by the fleet layout while another machine's update runs
  let fleetBlocking = $state(false);
  const blocking = $derived(local.busy || (fleet && fleetBlocking));
</script>

<div
  class="overlay"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget && !blocking) onclose?.();
  }}
>
  {#if local.busy}
    <SvgFlockOverlay placement="backdrop" />
  {/if}
  <div
    class="card bracket"
    class:fleet
    role="dialog"
    aria-modal="true"
    aria-label={m.updatemodal_available()}
    use:dialog={{ onclose: () => !blocking && onclose?.() }}
  >
    {#if local.busy}
      <SvgFlockOverlay placement="sheet" />
    {/if}
    <div class="card-content">
      <div class="chead">
        <span class="micro">{m.updatemodal_available()}</span>
        {#if !blocking}
          <button type="button" class="x" onclick={() => onclose?.()} aria-label={m.common_close()}
            >✕</button
          >
        {/if}
      </div>

      {#if fleet}
        <UpdateFleet {local} {machines} {onclose} bind:blocking={fleetBlocking} />
      {:else}
        <UpdateSolo {local} {onclose} />
      {/if}
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: var(--color-scrim);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 30;
    padding: 16px;
  }
  .card {
    position: relative;
    box-sizing: border-box;
    z-index: 1;
    width: min(520px, 100%);
    max-height: 80dvh;
    display: flex;
    flex-direction: column;
    gap: 0;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    padding: 18px 18px 16px;
    overflow-x: clip;
    box-shadow: inset 0 0 30px -16px var(--color-amber);
  }
  .card.fleet {
    width: min(640px, 100%);
  }
  .card-content {
    position: relative;
    z-index: 1;
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .bracket::before,
  .bracket::after {
    content: "";
    position: absolute;
    width: 9px;
    height: 9px;
    border: 1px solid var(--color-line-bright);
  }
  .bracket::before {
    top: 0;
    left: 0;
    border-right: 0;
    border-bottom: 0;
  }
  .bracket::after {
    bottom: 0;
    right: 0;
    border-left: 0;
    border-top: 0;
  }
  .chead {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .x {
    background: transparent;
    border: 0;
    color: var(--color-muted);
    cursor: pointer;
    font-size: var(--fs-base);
  }

  /* ── the window's shared vocabulary, for every part rendered inside the card ── */
  .card :global(.micro) {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  /* no font-size: they read at the body size, and at a machine row's smaller state size there */
  .card :global(.status) {
    color: var(--color-amber);
  }
  .card :global(.err) {
    color: var(--color-red);
  }
  .card :global(.muted) {
    color: var(--color-muted);
  }
  .card :global(.amber) {
    color: var(--color-amber);
  }
  .card :global(.loghead) {
    color: var(--color-muted);
  }
  .card :global(.log) {
    flex: 1 1 96px;
    margin: 0;
    min-height: 96px;
    max-height: 200px;
    overflow: auto;
    padding: 8px 10px;
    border: 1px solid var(--color-line);
    background: var(--color-inset);
    color: var(--color-ink-bright);
    font-size: var(--fs-meta);
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
  }
  /* state marks in a machine row: a check, or a spinner while it updates */
  .card :global(.mark) {
    width: 13px;
    height: 13px;
    flex: none;
    fill: none;
    stroke: var(--color-muted);
    stroke-width: 2.4;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .card :global(.spin) {
    width: 11px;
    height: 11px;
    flex: none;
    border: 2px solid var(--color-amber);
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .card :global(.spin) {
      animation: none;
    }
  }
  .card :global(.actions),
  .card :global(.row-actions) {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
  }
  .card :global(.later) {
    background: transparent;
    border: 1px solid var(--color-line-bright);
    color: var(--color-muted);
    font: inherit;
    padding: 8px 14px;
    cursor: pointer;
    letter-spacing: 0.06em;
  }
  .card :global(.run) {
    background: transparent;
    border: 1px solid var(--color-amber);
    color: var(--color-amber);
    font: inherit;
    font-weight: 600;
    padding: 8px 16px;
    cursor: pointer;
    letter-spacing: 0.06em;
    box-shadow: inset 0 0 18px -10px var(--color-amber);
  }
  /* destructive variant: same recipe, danger hue (traffic-light semantics) */
  .card :global(.run.danger) {
    border-color: var(--color-red);
    color: var(--color-red);
    box-shadow: inset 0 0 18px -10px var(--color-red);
  }
  .card :global(.run:disabled) {
    opacity: 0.6;
    cursor: not-allowed;
    color: var(--color-faint);
    border-color: var(--color-line);
    box-shadow: none;
  }
  /* the compact size inside a machine's row */
  .card :global(.later.small),
  .card :global(.run.small) {
    padding: 6px 12px;
    font-size: var(--fs-meta);
  }
  @media (pointer: coarse) {
    .card :global(.later.small),
    .card :global(.run.small) {
      min-height: 44px;
    }
  }

  /* phones: rise as a full-height sheet (same pattern as NewTask) so the
     list gets the whole screen and scrolls internally while the
     actions stay pinned and thumb-reachable above the home indicator */
  @media (max-width: 768px) {
    .overlay {
      align-items: stretch;
      justify-content: stretch;
      padding: 0;
    }
    .card {
      width: 100%;
      max-height: none;
      height: 100dvh;
      border: 0;
      /* safe-area top: standalone-PWA status bar / Dynamic Island */
      padding: calc(16px + env(safe-area-inset-top)) 16px calc(14px + env(safe-area-inset-bottom));
      /* fallback when even fully-shrunk content exceeds the viewport
         (landscape phones): scroll the card rather than clip the actions */
      overflow-y: auto;
      animation: sheet-up 0.18s ease-out;
    }
    .card.fleet {
      width: 100%;
    }
    .card-content {
      min-height: 100%;
    }
    .bracket::before,
    .bracket::after {
      display: none;
    }
    .x {
      min-width: 44px;
      min-height: 44px;
      margin: -14px -14px -10px 0; /* keep the glyph optically in the corner */
    }
    .card :global(.actions) {
      margin-top: auto; /* pin to the bottom even when the list is short */
    }
    .card :global(.actions .later),
    .card :global(.actions .run) {
      min-height: 44px;
      flex: 1; /* two thumb-width targets instead of two slivers at the edge */
    }
    /* "Update all (3)" needs the wider half of the row */
    .card.fleet :global(.actions .run) {
      flex: 2;
    }
  }
  @keyframes sheet-up {
    from {
      transform: translateY(12px);
      opacity: 0.6;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }
</style>
