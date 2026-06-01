<script module lang="ts">
  // Single-open invariant across every row: the close-fn of the currently open
  // row. Opening another row closes this one first.
  let openRow: (() => void) | null = $state(null);
</script>

<script lang="ts">
  import type { Session, GitState } from "$lib/types";
  import { elapsed, STATUS_COLOR, statusLabel } from "$lib/format";
  import StatusPip from "./StatusPip.svelte";
  import PrBadge from "./PrBadge.svelte";
  import CriticBadge from "./CriticBadge.svelte";
  import { projectIcons } from "$lib/projectIcons.svelte";
  import { m } from "$lib/paraglide/messages";
  import { onDestroy } from "svelte";
  import {
    REVEAL_PX,
    snapOffset,
    pressDecom,
    swipeGesture,
    type SwipeCallbacks,
    type DecomState,
  } from "./swipe";

  let {
    session,
    selected,
    nowMs,
    onselect,
    git,
    ondecommission,
  }: {
    session: Session;
    selected: boolean;
    nowMs: number;
    onselect: (id: string) => void;
    git?: GitState;
    // when provided, the row gains a left-swipe-to-decommission gesture (mobile)
    ondecommission?: (id: string) => void;
  } = $props();

  // repo the unit works in — the last path segment of its repoPath (e.g. "community-map")
  const repoName = $derived(session.repoPath.split("/").filter(Boolean).at(-1) ?? session.repoPath);
  const repoIcon = $derived(projectIcons.iconFor(session.repoPath));

  const swipe = $derived(!!ondecommission);

  // gesture state
  let offset = $state(0); // px the row is slid left (negative); 0 = closed
  let dragging = $state(false); // finger down + tracking x → suppress snap transition

  // arm/confirm state for the revealed action
  let decom = $state<DecomState>("idle");
  let armTimer: ReturnType<typeof setTimeout> | undefined;

  function disarm() {
    clearTimeout(armTimer);
    decom = "idle";
  }
  function close() {
    offset = 0;
    disarm();
    if (openRow === close) openRow = null;
  }
  function openReveal() {
    if (openRow && openRow !== close) openRow();
    offset = -REVEAL_PX;
    openRow = close;
  }

  const swipeCb: SwipeCallbacks = {
    current: () => offset,
    onOffset: (px) => (offset = px),
    onDragging: (b) => (dragging = b),
    onRelease: () => (snapOffset(offset) === -REVEAL_PX ? openReveal() : close()),
    requestClose: close,
  };

  function pressDecommission() {
    const { state, fire } = pressDecom(decom);
    decom = state;
    if (state === "armed") {
      clearTimeout(armTimer);
      armTimer = setTimeout(disarm, 3000);
    }
    if (fire) {
      clearTimeout(armTimer);
      ondecommission?.(session.id);
      close(); // row will drop from the store; close defensively
    }
  }

  onDestroy(() => {
    clearTimeout(armTimer);
    if (openRow === close) openRow = null;
  });
</script>

{#snippet row()}
  <button
    class="unit"
    class:sel={selected}
    style="--rule:{STATUS_COLOR[session.status]}"
    onclick={() => onselect(session.id)}
    type="button"
  >
    <div class="pip-col">
      <StatusPip status={session.status} />
    </div>

    <div class="u-main">
      <div class="u-top">
        <span class="name">{session.name}</span>
      </div>
      <div class="u-repo" title={session.repoPath}>
        <span class="repo-glyph" class:emoji={repoIcon} aria-hidden="true">{repoIcon ?? "▣"}</span
        >{repoName}
      </div>
      <div class="u-sub">
        {session.prompt}
        {#if session.status === "running"}
          <span class="car">▏</span>
        {/if}
      </div>
    </div>

    <div class="u-right">
      <PrBadge {git} />
      <CriticBadge sessionId={session.id} />
      <span class="badge">{statusLabel(session.status)}</span>
      <span class="elapsed">{elapsed(session.createdAt, nowMs)}</span>
      <span class="meta"
        ><span class="desig">{session.desig}</span> · {session.herdrSession || "—"}</span
      >
    </div>
  </button>
{/snippet}

{#if swipe}
  <div class="swipe-wrap" style="--reveal:{REVEAL_PX}px">
    <div class="reveal" aria-hidden={offset === 0}>
      <button
        class="decom"
        class:armed={decom === "armed"}
        type="button"
        tabindex={offset === 0 ? -1 : 0}
        onclick={pressDecommission}
        title={m.viewport_decommission_title()}
        aria-label={m.viewport_decommission_aria()}
      >
        {decom === "armed" ? m.viewport_confirm_decommission() : m.viewport_decommission()}
      </button>
    </div>
    <div
      class="slider"
      class:dragging
      style="transform:translateX({offset}px)"
      use:swipeGesture={swipeCb}
    >
      {@render row()}
    </div>
  </div>
{:else}
  {@render row()}
{/if}

<style>
  .unit {
    position: relative;
    display: grid;
    grid-template-columns: 14px 1fr auto;
    gap: 12px;
    align-items: start;
    padding: 11px 13px 11px 14px;
    border: 1px solid transparent;
    border-radius: 2px;
    cursor: pointer;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    width: 100%;
  }

  :global(.unit + .unit),
  :global(.swipe-wrap + .swipe-wrap) {
    margin-top: 2px;
  }

  /* swipe-to-decommission (mobile): the row slides left over a destructive
     action revealed behind it. */
  .swipe-wrap {
    position: relative;
    overflow: hidden;
    border-radius: 2px;
  }

  .reveal {
    position: absolute;
    inset: 0 0 0 auto;
    width: var(--reveal); /* set from REVEAL_PX (swipe.ts) — single source of truth */
    display: flex;
    align-items: stretch;
    justify-content: stretch;
    background: color-mix(in srgb, var(--color-red) 16%, var(--color-panel));
  }

  .reveal .decom {
    flex: 1;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--color-red);
    font-family: inherit;
    font-size: 10px;
    letter-spacing: 0.12em;
    line-height: 1.3;
    text-transform: uppercase;
    cursor: pointer;
    padding: 6px;
  }
  .reveal .decom.armed {
    background: color-mix(in srgb, var(--color-red) 26%, transparent);
    color: var(--color-ink-bright);
    font-weight: 600;
  }

  .slider {
    position: relative;
    background: var(--color-panel);
    /* vertical pans scroll the list natively; horizontal pans are ours */
    touch-action: pan-y;
    transition: transform 0.18s ease;
    will-change: transform;
  }
  .slider.dragging {
    transition: none;
  }

  .unit::before {
    content: "";
    position: absolute;
    left: 0;
    top: 8px;
    bottom: 8px;
    width: 2px;
    background: var(--rule, var(--color-faint));
  }

  .unit:hover {
    border-color: var(--color-line);
    background: var(--color-hover);
  }

  .unit.sel {
    border-color: var(--color-line-bright);
    background:
      radial-gradient(
        120% 140% at 0% 50%,
        color-mix(in srgb, var(--rule) 12%, transparent),
        transparent 70%
      ),
      var(--color-sel);
  }

  /* bracket corners on selected */
  .unit.sel::after {
    content: "";
    position: absolute;
    bottom: -1px;
    right: -1px;
    width: 9px;
    height: 9px;
    border: 1px solid var(--color-line-bright);
    border-left: 0;
    border-top: 0;
  }

  .pip-col {
    display: flex;
    align-items: flex-start;
    padding-top: 5px;
  }

  .u-main {
    min-width: 0;
  }

  .u-top {
    display: flex;
    align-items: baseline;
    gap: 0;
    min-width: 0;
  }

  .name {
    color: var(--color-ink-bright);
    font-weight: 500;
    letter-spacing: 0.04em;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .u-repo {
    display: flex;
    align-items: center;
    gap: 5px;
    margin-top: 3px;
    color: var(--color-ink);
    font-size: 11.5px;
    letter-spacing: 0.04em;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    max-width: 34ch;
  }
  .repo-glyph {
    /* Renders on every row regardless of status — amber here was the biggest
       remaining contributor to the "orange wall". Muted: it's a repo marker,
       not a state signal. (Only tints the `▣` fallback; emoji icons self-color.) */
    color: var(--color-muted);
    font-size: 10px;
    flex-shrink: 0;
  }
  .repo-glyph.emoji {
    font-size: 12px;
  }

  .u-sub {
    color: var(--color-muted);
    margin-top: 3px;
    font-size: 12px;
    line-height: 1.35;
    /* wrap to a 2nd line — fills the vertical space the right column
       (badge / elapsed / meta) already occupies, then ellipsis */
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    max-width: 34ch;
  }

  .car {
    color: var(--color-amber);
    animation: blink 1.1s steps(1) infinite;
  }

  .u-right {
    text-align: right;
    display: flex;
    flex-direction: column;
    gap: 4px;
    align-items: flex-end;
    flex-shrink: 0;
  }

  /* Quiet muted text, not a colored pill — the StatusPip (left) already encodes
     status by color + pulse, so an outlined `--rule`-tinted badge here just
     duplicated that hue (amber for running) and added to the orange wall. */
  .badge {
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-muted);
    white-space: nowrap;
  }

  .elapsed {
    color: var(--color-ink);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.08em;
  }

  .meta {
    color: var(--color-muted);
    font-size: 11.5px;
  }
  /* the task designation is metadata, not the human marker — demoted to the
     quietest spot, the bottom-right meta line, next to the herdr session */
  .meta .desig {
    color: var(--color-faint);
    letter-spacing: 0.1em;
  }

  @media (max-width: 768px) {
    .unit {
      min-height: 44px;
    }
  }
</style>
