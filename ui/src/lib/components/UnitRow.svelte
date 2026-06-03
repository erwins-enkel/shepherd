<script module lang="ts">
  // Single-open invariant across every row: the close-fn of the currently open
  // row. Opening another row closes this one first.
  let openRow: (() => void) | null = $state(null);
</script>

<script lang="ts">
  import type { Session, GitState, SessionActivity } from "$lib/types";
  import { elapsed, STATUS_COLOR, statusLabel, hideStatusBadge } from "$lib/format";
  import StatusPip from "./StatusPip.svelte";
  import PrBadge from "./PrBadge.svelte";
  import CriticBadge from "./CriticBadge.svelte";
  import Heartbeat from "./Heartbeat.svelte";
  import Stepper from "./Stepper.svelte";
  import { reviews } from "$lib/reviews.svelte";
  import { toasts } from "$lib/toasts.svelte";
  import { projectIcons } from "$lib/projectIcons.svelte";
  import { m } from "$lib/paraglide/messages";
  import AutopilotBadge from "./AutopilotBadge.svelte";
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
    activity,
    ondecommission,
  }: {
    session: Session;
    selected: boolean;
    nowMs: number;
    onselect: (id: string) => void;
    git?: GitState;
    // live per-session signal (heartbeat + current tool summary); undefined until first event
    activity?: SessionActivity;
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

  const hideStatus = $derived(hideStatusBadge(session.status, reviews.isReviewing(session.id)));

  // live signals (heartbeat + current tool) only make sense while the agent works
  const live = $derived(session.status === "running");
  // verbatim tool summary — NOT translated; shown as a quiet line when present
  const summary = $derived(activity?.summary?.trim() || null);
  // stepper conveys "how close to finishing" across the active lifecycle (not archived)
  const showStepper = $derived(
    session.status === "running" || session.status === "blocked" || session.status === "done",
  );

  // Decommission is deferred behind an undo window: while it's open, the row is
  // doomed-but-still-present. Dim it so the operator sees it's on its way out.
  const decommissioning = $derived(toasts.pendingUndo(session.id));
</script>

{#snippet row()}
  <button
    class="unit"
    class:sel={selected}
    class:decommissioning
    style="--rule:{session.readyToMerge ? 'var(--color-green)' : STATUS_COLOR[session.status]}"
    onclick={() => onselect(session.id)}
    type="button"
  >
    <div class="pip-col">
      <StatusPip status={session.status} ready={session.readyToMerge} />
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
      {#if live}
        <div class="u-activity">
          <Heartbeat lastActivityTs={activity?.lastActivityTs ?? 0} {nowMs} />
          {#if summary}
            <span class="act-sep" aria-hidden="true">·</span>
            <span class="act-sum" title={summary}>{summary}</span>
          {/if}
        </div>
      {/if}
    </div>

    <div class="u-right">
      <PrBadge {git} />
      <CriticBadge sessionId={session.id} />
      <AutopilotBadge {session} />
      {#if session.readyToMerge}
        <span class="badge">{m.status_ready_to_merge()}</span>
      {:else if !hideStatus}
        <span class="badge">{statusLabel(session.status)}</span>
      {/if}
      <span class="elapsed">{elapsed(session.createdAt, nowMs)}</span>
    </div>

    <span class="meta">
      <span class="meta-text"
        ><span class="desig">{session.desig}</span> · {session.herdrSession || "—"}</span
      >
      {#if showStepper && !session.readyToMerge}
        <span class="meta-stepper">
          <Stepper sessionId={session.id} {git} readyToMerge={session.readyToMerge} />
        </span>
      {/if}
    </span>
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
    grid-template-columns: 16px 1fr auto;
    /* meta (desig · session) drops to a full-width footer row so it no longer
       fights the name for horizontal space — on a compact sidebar the right
       rail used to win and crush the name to an ellipsis stub */
    grid-template-areas:
      "pip main right"
      "pip meta meta";
    column-gap: 12px;
    row-gap: 3px;
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
    transition: opacity 0.18s ease;
  }

  /* deferred decommission: row is doomed but still listed during the undo
     window — fade it so it visibly recedes; restored instantly on UNDO */
  .unit.decommissioning {
    opacity: 0.4;
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
    font-size: var(--fs-micro);
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
    width: 1px;
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
    grid-area: pip;
    display: flex;
    align-items: flex-start;
    padding-top: 5px;
  }

  .u-main {
    grid-area: main;
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
    font-size: var(--fs-meta);
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
    font-size: var(--fs-micro);
    flex-shrink: 0;
  }
  .repo-glyph.emoji {
    font-size: var(--fs-base);
  }

  .u-sub {
    color: var(--color-muted);
    margin-top: 3px;
    font-size: var(--fs-base);
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

  /* Live activity sub-line: heartbeat + verbatim current-tool summary. Quiet,
     single-line, ellipsized — the priority signal for a working row without
     adding a colored badge. */
  .u-activity {
    display: flex;
    align-items: center;
    gap: 5px;
    margin-top: 3px;
    min-width: 0;
    font-size: 11px;
    line-height: 1.3;
    color: var(--color-muted);
    max-width: 34ch;
  }
  .act-sep {
    color: var(--color-faint);
    flex: none;
  }
  .act-sum {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .car {
    color: var(--color-amber);
    /* functional in-progress motion — exempt from the reduced-motion blanket (app.css) */
    animation: blink 1.1s steps(1) infinite !important;
  }

  .u-right {
    grid-area: right;
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
    font-size: var(--fs-micro);
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
    grid-area: meta;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }
  .meta-text {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  /* thin stage stepper on the quietest row — pushed to the right edge */
  .meta-stepper {
    margin-left: auto;
    flex: none;
    display: inline-flex;
    align-items: center;
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

  /* Touch devices at any width (landscape foldables, tablets) get the same
     44px row floor — the width-based rule above misses coarse pointers > 768px. */
  @media (pointer: coarse) {
    .unit {
      min-height: 44px;
    }
  }

  /* Compact sidebar (touch foldables, narrow picker): the meta footer already
     frees the name from the right rail; here we trade the 2nd prompt line for
     density so more agents stay visible without the card growing taller. */
  @container herd (max-width: 300px) {
    .unit {
      column-gap: 9px;
    }
    .u-sub {
      -webkit-line-clamp: 1;
      line-clamp: 1;
    }
    /* keep the heartbeat (tiny), drop the verbatim summary + separator and the
       stepper so a narrow sidebar row stays dense and doesn't balloon */
    .act-sum,
    .act-sep,
    .meta-stepper {
      display: none;
    }
  }
</style>
