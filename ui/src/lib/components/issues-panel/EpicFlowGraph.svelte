<script lang="ts">
  import type { Epic, EpicChild, Session } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import {
    firstParallelStage,
    flowTone,
    layoutEpicFlow,
    FLOW_COL_WIDTH,
    FLOW_GAP_X,
    type FlowStage,
    type FlowTone,
  } from "$lib/epic-flow";
  import { progress, stateLabel } from "../epic-panel";
  import GlossaryText from "../GlossaryText.svelte";

  // Flow graph of an epic's dependencies in the epic detail (#2621): one column per stage of
  // the blockedBy DAG, so a reader sees where the epic is a chain and from which stage more
  // agent slots pay off. Below COMPACT_BELOW (phone, narrow dialog) the stages stack as a list;
  // an epic without any dependency edges is a plain list with a hint.
  let {
    epic,
    onselect = undefined,
    sessionInfo = undefined,
  }: {
    epic: Epic;
    /** Select the clicked child in the issue list. */
    onselect?: (child: number) => void;
    /** A session from the store, by id; null when unknown. Drives the working pulse. */
    sessionInfo?: (id: string) => { session: Session } | null;
  } = $props();

  /** Narrower than this, the columns stack as a list. */
  const COMPACT_BELOW = 480;
  /** Up to this many stages the columns stretch to the width; beyond it the graph scrolls. */
  const FIT_STAGES = 4;
  /** Height of the stage-label row above the nodes. */
  const LABEL_HEIGHT = 22;

  let width = $state(0);

  const count = $derived(progress(epic.children));
  const stageCount = $derived(layoutEpicFlow(epic.children).stages.length);
  const colWidth = $derived(
    width > 0 && stageCount > 0 && stageCount <= FIT_STAGES
      ? Math.max(FLOW_COL_WIDTH, (width + FLOW_GAP_X) / stageCount)
      : FLOW_COL_WIDTH,
  );
  const layout = $derived(layoutEpicFlow(epic.children, { colWidth }));
  const noDeps = $derived(epic.noDependencyEdges === true);
  // Width 0 = not measured yet: keep the diagram rather than flash the list.
  const compact = $derived(width > 0 && width < COMPACT_BELOW);
  const hintStage = $derived(noDeps ? null : firstParallelStage(layout));
  const listed = $derived([...epic.children].sort((a, b) => a.order - b.order));

  const LEGEND: { tone: FlowTone; label: () => string }[] = [
    { tone: "ready", label: m.epicflow_legend_ready },
    { tone: "active", label: m.epicflow_legend_active },
    { tone: "waiting", label: m.epicflow_legend_waiting },
    { tone: "merged", label: m.epicflow_legend_merged },
  ];

  function stageLabel(s: FlowStage): string {
    if (s.parallel) return m.epicflow_stage_parallel({ stage: s.index });
    return s.index === 1 ? m.epicflow_stage_first() : String(s.index);
  }

  /** In flight and its agent mid-turn — not parked waiting for the operator or a review. */
  function working(c: EpicChild): boolean {
    if (flowTone(c.state) !== "active" || c.sessionId == null) return false;
    return sessionInfo?.(c.sessionId)?.session.status === "running";
  }

  function edgePath(e: { x1: number; y1: number; x2: number; y2: number }): string {
    const mid = (e.x1 + e.x2) / 2;
    return `M ${e.x1} ${e.y1} C ${mid} ${e.y1}, ${mid} ${e.y2}, ${e.x2} ${e.y2}`;
  }
</script>

{#snippet node(c: EpicChild)}
  <button
    class="node tone-{flowTone(c.state)}"
    class:working={working(c)}
    type="button"
    onclick={() => onselect?.(c.number)}
  >
    <span class="node-line">
      <span class="dot" aria-hidden="true"></span>
      <span class="num">#{c.number}</span>
      <span class="state">{stateLabel(c.state)}</span>
    </span>
    <span class="node-title">{c.title}</span>
  </button>
{/snippet}

{#if epic.children.length > 0}
  <section class="flow" aria-label={m.epicflow_title()}>
    <!-- Measured here: the head always renders and spans the content box (padding excluded). -->
    <div class="flow-head" bind:clientWidth={width}>
      <span class="caption">{m.epicflow_title()}</span>
      <span class="count">{m.epicflow_merged({ merged: count.merged, total: count.total })}</span>
      <ul class="legend" aria-label={m.epicflow_legend()}>
        {#each LEGEND as item (item.tone)}
          <li class="tone-{item.tone}">
            <span class="dot" aria-hidden="true"></span>{item.label()}
          </li>
        {/each}
      </ul>
    </div>

    {#if noDeps}
      <p class="hint">{m.epicflow_no_deps()}</p>
      <ul class="list">
        {#each listed as c (c.number)}
          <li>{@render node(c)}</li>
        {/each}
      </ul>
    {:else if compact}
      <ol class="stage-list">
        {#each layout.stages as s (s.index)}
          <li class="stage-item">
            <span class="stage-label">{stageLabel(s)}</span>
            <ul class="list">
              {#each s.nodes as n (n.child.number)}
                <li>{@render node(n.child)}</li>
              {/each}
            </ul>
          </li>
        {/each}
      </ol>
    {:else}
      <div class="scroll">
        <div
          class="canvas"
          style:width="{layout.width}px"
          style:height="{LABEL_HEIGHT + layout.height}px"
        >
          <svg
            class="edges"
            aria-hidden="true"
            width={layout.width}
            height={layout.height}
            style:top="{LABEL_HEIGHT}px"
          >
            {#each layout.edges as e (`${e.from}-${e.to}`)}
              <path d={edgePath(e)} />
            {/each}
          </svg>
          {#each layout.stages as s (s.index)}
            <div class="stage" role="group" aria-label={stageLabel(s)}>
              <span
                class="stage-label"
                aria-hidden="true"
                style:left="{(s.index - 1) * colWidth}px"
                style:width="{layout.nodeWidth}px">{stageLabel(s)}</span
              >
              {#each s.nodes as n (n.child.number)}
                <div
                  class="slot"
                  style:left="{n.x}px"
                  style:top="{LABEL_HEIGHT + n.y}px"
                  style:width="{layout.nodeWidth}px"
                  style:height="{layout.nodeHeight}px"
                >
                  {@render node(n.child)}
                </div>
              {/each}
            </div>
          {/each}
        </div>
      </div>
    {/if}

    {#if hintStage != null}
      <p class="hint"><GlossaryText text={m.epicflow_slots_hint({ stage: hintStage })} /></p>
    {/if}
  </section>
{/if}

<style>
  .flow {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
    padding: 8px 10px;
    background: var(--color-panel);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
  }

  .flow-head {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 6px 12px;
  }

  .caption {
    color: var(--color-faint);
    font-size: var(--fs-micro);
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .count {
    color: var(--color-muted);
    font-size: var(--fs-micro);
  }

  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 10px;
    margin: 0 0 0 auto;
    padding: 0;
    list-style: none;
    color: var(--color-faint);
    font-size: var(--fs-micro);
  }
  .legend li {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  /* ── status dot / ring ──────────────────────────────────────────────────
     Semantic accents (ui-design-system rule 4): green = ready to start, amber = in flight
     (running or in review), slate = merged; waiting is a hollow muted ring. */
  .dot {
    flex-shrink: 0;
    width: 7px;
    height: 7px;
    border: 1px solid transparent;
    border-radius: 50%;
  }
  .tone-ready .dot {
    background: var(--color-green);
  }
  .tone-active .dot {
    background: var(--status-running);
  }
  .tone-waiting .dot {
    border-color: var(--color-muted);
  }
  .tone-merged .dot {
    background: var(--status-done);
  }

  /* ── diagram ─────────────────────────────────────────────────────────── */
  .scroll {
    overflow-x: auto;
    overscroll-behavior-x: contain;
  }

  .canvas {
    position: relative;
  }

  .edges {
    position: absolute;
    left: 0;
    overflow: visible;
    pointer-events: none;
  }
  .edges path {
    fill: none;
    stroke: var(--color-line-bright);
    stroke-width: 1;
  }

  .stage-label {
    color: var(--color-faint);
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .canvas .stage-label {
    position: absolute;
    top: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .slot {
    position: absolute;
    display: flex;
  }

  /* ── node ────────────────────────────────────────────────────────────── */
  .node {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    overflow: hidden;
    padding: 5px 7px;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-left-width: 2px;
    border-radius: 2px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    text-align: left;
    cursor: pointer;
  }
  .node.tone-ready {
    border-left-color: var(--color-green);
  }
  .node.tone-active {
    border-left-color: var(--status-running);
  }
  .node.tone-merged {
    color: var(--color-muted);
  }
  /* Agent at work: the left edge glows and the dot breathes, slow enough to stay in the
     background. The glow is decoration (reduced motion leaves it standing at its resting
     opacity); the dot is functional status motion like the other working dots (app.css). */
  .node.working {
    position: relative;
    isolation: isolate;
  }
  .node.working::before {
    content: "";
    position: absolute;
    inset: 0;
    z-index: -1;
    background: linear-gradient(
      90deg,
      color-mix(in srgb, var(--status-running) 22%, transparent),
      transparent 55%
    );
    opacity: 0.6;
    pointer-events: none;
    animation: dot-pulse 3.2s ease-in-out infinite;
  }
  .node.working .dot {
    animation: dot-pulse 3.2s ease-in-out infinite !important;
  }
  .node:hover {
    border-color: var(--color-amber);
  }
  .node:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }

  .node-line {
    display: flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
  }
  .num {
    color: var(--color-ink-bright);
  }
  .state {
    overflow: hidden;
    color: var(--color-faint);
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-overflow: ellipsis;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .node-title {
    display: -webkit-box;
    overflow: hidden;
    line-clamp: 2;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow-wrap: anywhere;
  }

  /* ── list modes (no dependencies, narrow width) ──────────────────────── */
  .list,
  .stage-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .list li {
    display: flex;
  }
  .stage-list {
    gap: 10px;
  }
  .stage-item {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .hint {
    margin: 0;
    color: var(--color-muted);
    font-size: var(--fs-micro);
  }
</style>
