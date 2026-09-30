import type { EpicChild, EpicChildState } from "$lib/types";

// Stage layout of an epic's dependency DAG (#2621) for the epic detail's flow graph. Pure: the
// component only turns the result into markup.

/** Horizontal step between two stage columns, gap included. */
export const FLOW_COL_WIDTH = 196;
/** Free space between two columns — where the edges run. */
export const FLOW_GAP_X = 36;
export const FLOW_NODE_HEIGHT = 66;
export const FLOW_GAP_Y = 10;

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
  const inEpic = new Set(sorted.map((c) => c.number));
  let outsideEdges = 0;
  const preds = new Map<number, number[]>();
  for (const c of sorted) {
    const ps: number[] = [];
    for (const b of c.blockedBy) {
      if (b === c.number) continue;
      if (!inEpic.has(b)) {
        outsideEdges++;
        continue;
      }
      if (!ps.includes(b)) ps.push(b);
    }
    preds.set(c.number, ps);
  }

  const stageOf = new Map<number, number>();
  const onStack = new Set<number>();
  const kept: { from: number; to: number }[] = [];
  function visit(n: number): number {
    const known = stageOf.get(n);
    if (known !== undefined) return known;
    onStack.add(n);
    let stage = 1;
    for (const p of preds.get(n) ?? []) {
      if (onStack.has(p)) continue; // closes a cycle
      stage = Math.max(stage, visit(p) + 1);
      kept.push({ from: p, to: n });
    }
    onStack.delete(n);
    stageOf.set(n, stage);
    return stage;
  }
  for (const c of sorted) visit(c.number);

  const stageCount = Math.max(0, ...stageOf.values());
  const rank = new Map(sorted.map((c, i) => [c.number, i]));
  const byNumber = new Map<number, FlowNode>();
  const stages: FlowStage[] = [];
  // Blockers always sit in an earlier stage, so their rows are known when this runs.
  const meanBlockerRow = (n: number) => {
    const rows = kept.filter((e) => e.to === n).map((e) => byNumber.get(e.from)!.row);
    return rows.length ? rows.reduce((s, r) => s + r, 0) / rows.length : 0;
  };
  for (let index = 1; index <= stageCount; index++) {
    const members = sorted
      .filter((c) => stageOf.get(c.number) === index)
      .map((c) => ({ c, key: meanBlockerRow(c.number) }))
      .sort((a, b) => a.key - b.key || rank.get(a.c.number)! - rank.get(b.c.number)!);
    const nodes = members.map(({ c }, row) => {
      const node: FlowNode = {
        child: c,
        stage: index,
        row,
        x: (index - 1) * colWidth,
        y: row * (nodeHeight + gapY),
      };
      byNumber.set(c.number, node);
      return node;
    });
    stages.push({ index, nodes, parallel: nodes.length >= 2 });
  }

  const edges = kept
    .map(({ from, to }) => {
      const a = byNumber.get(from)!;
      const b = byNumber.get(to)!;
      return {
        from,
        to,
        x1: a.x + nodeWidth,
        y1: a.y + nodeHeight / 2,
        x2: b.x,
        y2: b.y + nodeHeight / 2,
      };
    })
    .sort((a, b) => a.x1 - b.x1 || a.y1 - b.y1 || a.y2 - b.y2);

  const maxRows = Math.max(0, ...stages.map((s) => s.nodes.length));
  return {
    stages,
    nodes: stages.flatMap((s) => s.nodes),
    edges,
    nodeWidth,
    nodeHeight,
    width: stageCount ? stageCount * colWidth - gapX : 0,
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
