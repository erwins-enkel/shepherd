import type { EpicChild, EpicChildState } from "$lib/types";

// Stage layout of an epic's dependency DAG (#2621) for the epic detail's flow graph. Pure: the
// component only turns the result into markup.

/** Horizontal step between two stage columns, gap included. */
export const FLOW_COL_WIDTH = 196;
/** Free space between two columns — where the edges run. */
export const FLOW_GAP_X = 36;
export const FLOW_NODE_HEIGHT = 66;
const FLOW_GAP_Y = 10;

export interface FlowNode {
  child: EpicChild;
  /** 1-based stage (column). */
  stage: number;
  /** 0-based row within the stage. */
  row: number;
  /** Top-left corner in px. */
  x: number;
  y: number;
}

export interface FlowStage {
  /** 1-based. */
  index: number;
  nodes: FlowNode[];
  /** Two or more nodes — they can run side by side. */
  parallel: boolean;
}

/** A drawn dependency: `from` must merge before `to` can start. Coordinates run from the
 *  predecessor's right edge to the dependent's left edge, both at mid-height. */
export interface FlowEdge {
  from: number;
  to: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface EpicFlowLayout {
  stages: FlowStage[];
  nodes: FlowNode[];
  edges: FlowEdge[];
  nodeWidth: number;
  nodeHeight: number;
  width: number;
  height: number;
  /** `blockedBy` references to issues outside the epic — ignored for the layout. */
  outsideEdges: number;
}

export interface FlowOptions {
  colWidth?: number;
  gapX?: number;
  nodeHeight?: number;
  gapY?: number;
}

type Link = { from: number; to: number };

/** Each child's blockers inside the epic (deduplicated, self-references dropped), plus how many
 *  `blockedBy` references point outside it. */
function inEpicBlockers(sorted: readonly EpicChild[]): {
  preds: Map<number, number[]>;
  outsideEdges: number;
} {
  const inEpic = new Set(sorted.map((c) => c.number));
  const preds = new Map<number, number[]>();
  let outsideEdges = 0;
  for (const c of sorted) {
    const own = c.blockedBy.filter((b) => b !== c.number);
    outsideEdges += own.filter((b) => !inEpic.has(b)).length;
    preds.set(c.number, [...new Set(own.filter((b) => inEpic.has(b)))]);
  }
  return { preds, outsideEdges };
}

/** Longest-path stage per child via a memoized DFS in `order`. An edge whose blocker is still
 *  on the DFS stack closes a cycle: it is skipped for staging and not returned in `kept`. */
function stagesByLongestPath(
  sorted: readonly EpicChild[],
  preds: ReadonlyMap<number, number[]>,
): { stageOf: Map<number, number>; kept: Link[] } {
  const stageOf = new Map<number, number>();
  const onStack = new Set<number>();
  const kept: Link[] = [];
  function visit(n: number): number {
    const known = stageOf.get(n);
    if (known !== undefined) return known;
    onStack.add(n);
    let stage = 1;
    for (const p of preds.get(n) ?? []) {
      if (onStack.has(p)) continue;
      stage = Math.max(stage, visit(p) + 1);
      kept.push({ from: p, to: n });
    }
    onStack.delete(n);
    stageOf.set(n, stage);
    return stage;
  }
  for (const c of sorted) visit(c.number);
  return { stageOf, kept };
}

/** Rows within each stage: by the mean row of the node's blockers (always in an earlier stage,
 *  so already placed), then by epic order. */
function orderStages(
  sorted: readonly EpicChild[],
  stageOf: ReadonlyMap<number, number>,
  kept: readonly Link[],
): EpicChild[][] {
  const rowOf = new Map<number, number>();
  const meanBlockerRow = (n: number) => {
    const rows = kept.filter((e) => e.to === n).map((e) => rowOf.get(e.from) ?? 0);
    return rows.length ? rows.reduce((s, r) => s + r, 0) / rows.length : 0;
  };
  const stageCount = Math.max(0, ...stageOf.values());
  const stages: EpicChild[][] = [];
  for (let index = 1; index <= stageCount; index++) {
    const members = sorted
      .map((c, rank) => ({ c, rank, key: meanBlockerRow(c.number) }))
      .filter(({ c }) => stageOf.get(c.number) === index)
      .sort((a, b) => a.key - b.key || a.rank - b.rank)
      .map(({ c }) => c);
    members.forEach((c, row) => rowOf.set(c.number, row));
    stages.push(members);
  }
  return stages;
}

/**
 * Split an epic's children into stages by the longest path over `blockedBy`: a child with no
 * blocker inside the epic sits in stage 1, every other one right after its latest blocker.
 * Blockers outside the epic and self-references are ignored. On a cycle, the edge that closes it
 * (its blocker is still being resolved) is dropped, so every child gets a finite stage and no
 * dropped edge is drawn. Children are walked in epic `order`, which keeps the result stable.
 * Within a stage, nodes sort by the mean row of their blockers, then by `order`.
 */
export function layoutEpicFlow(
  children: readonly EpicChild[],
  opts: FlowOptions = {},
): EpicFlowLayout {
  const colWidth = opts.colWidth ?? FLOW_COL_WIDTH;
  const gapX = opts.gapX ?? FLOW_GAP_X;
  const nodeHeight = opts.nodeHeight ?? FLOW_NODE_HEIGHT;
  const gapY = opts.gapY ?? FLOW_GAP_Y;
  const nodeWidth = colWidth - gapX;

  const sorted = [...children].sort((a, b) => a.order - b.order || a.number - b.number);
  const { preds, outsideEdges } = inEpicBlockers(sorted);
  const { stageOf, kept } = stagesByLongestPath(sorted, preds);

  const byNumber = new Map<number, FlowNode>();
  const stages: FlowStage[] = orderStages(sorted, stageOf, kept).map((members, i) => {
    const nodes = members.map((child, row) => {
      const node = { child, stage: i + 1, row, x: i * colWidth, y: row * (nodeHeight + gapY) };
      byNumber.set(child.number, node);
      return node;
    });
    return { index: i + 1, nodes, parallel: nodes.length >= 2 };
  });

  const edges = kept
    .map(({ from, to }) => {
      const a = byNumber.get(from)!;
      const b = byNumber.get(to)!;
      const mid = nodeHeight / 2;
      return { from, to, x1: a.x + nodeWidth, y1: a.y + mid, x2: b.x, y2: b.y + mid };
    })
    .sort((a, b) => a.x1 - b.x1 || a.y1 - b.y1 || a.y2 - b.y2);

  const maxRows = Math.max(0, ...stages.map((s) => s.nodes.length));
  return {
    stages,
    nodes: stages.flatMap((s) => s.nodes),
    edges,
    nodeWidth,
    nodeHeight,
    width: stages.length ? stages.length * colWidth - gapX : 0,
    height: maxRows ? maxRows * (nodeHeight + gapY) - gapY : 0,
    outsideEdges,
  };
}

/** First stage with at least two unmerged children — where more agent slots start to pay off.
 *  Null when the epic never fans out (or its parallel stretch is already merged). */
export function firstParallelStage(layout: EpicFlowLayout): number | null {
  const stage = layout.stages.find(
    (s) => s.nodes.filter((n) => n.child.state !== "merged").length >= 2,
  );
  return stage?.index ?? null;
}

/** The flow graph's four legend groups; an open PR still counts as work in flight. */
export type FlowTone = "ready" | "active" | "waiting" | "merged";

const TONES: Record<EpicChildState, FlowTone> = {
  ready: "ready",
  running: "active",
  "in-review": "active",
  blocked: "waiting",
  merged: "merged",
};

export function flowTone(state: EpicChildState): FlowTone {
  return TONES[state];
}
