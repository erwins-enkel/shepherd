import { describe, it, expect } from "vitest";
import type { EpicChild } from "$lib/types";
import {
  firstParallelStage,
  flowTone,
  layoutEpicFlow,
  FLOW_COL_WIDTH,
  FLOW_GAP_X,
  FLOW_NODE_HEIGHT,
} from "./epic-flow";

function child(
  number: number,
  blockedBy: number[] = [],
  state: EpicChild["state"] = "blocked",
  order = number,
): EpicChild {
  return {
    number,
    title: `c${number}`,
    url: "u",
    order,
    body: "",
    blockedBy,
    state,
    sessionId: null,
    prNumber: null,
    issueClosed: false,
    claimed: false,
  };
}

const stageNumbers = (children: EpicChild[]) =>
  layoutEpicFlow(children).stages.map((s) => s.nodes.map((n) => n.child.number));

// The issue's acceptance example (#2621).
const EXAMPLE = [
  child(152, [], "merged"),
  child(153, [152], "running"),
  child(154, [153]),
  child(155, [153]),
  child(156, [155]),
  child(157, [153]),
  child(158, [153]),
];

describe("layoutEpicFlow", () => {
  it("a chain gets one stage per child and nothing parallel", () => {
    const layout = layoutEpicFlow([child(1, [], "ready"), child(2, [1]), child(3, [2])]);
    expect(layout.stages.map((s) => s.nodes.map((n) => n.child.number))).toEqual([[1], [2], [3]]);
    expect(layout.stages.some((s) => s.parallel)).toBe(false);
    expect(layout.edges.map((e) => [e.from, e.to])).toEqual([
      [1, 2],
      [2, 3],
    ]);
    expect(firstParallelStage(layout)).toBeNull();
  });

  it("the issue example branches into four stages, the third one parallel", () => {
    const layout = layoutEpicFlow(EXAMPLE);
    expect(stageNumbers(EXAMPLE)).toEqual([[152], [153], [154, 155, 157, 158], [156]]);
    expect(layout.stages.map((s) => s.parallel)).toEqual([false, false, true, false]);
    expect(layout.edges).toHaveLength(6);
    expect(firstParallelStage(layout)).toBe(3);
  });

  it("a stage waits for its LATEST blocker (longest path)", () => {
    const children = [child(1), child(2, [1]), child(3, [1, 2])];
    expect(stageNumbers(children)).toEqual([[1], [2], [3]]);
  });

  it("terminates on cycles, stages every child and drops the closing edge", () => {
    const two = layoutEpicFlow([child(1, [2]), child(2, [1])]);
    expect(two.nodes).toHaveLength(2);
    expect(two.edges.map((e) => [e.from, e.to])).toEqual([[2, 1]]);
    for (const e of two.edges) {
      const from = two.nodes.find((n) => n.child.number === e.from)!;
      const to = two.nodes.find((n) => n.child.number === e.to)!;
      expect(from.stage).toBeLessThan(to.stage);
    }

    const three = layoutEpicFlow([child(1, [3]), child(2, [1]), child(3, [2]), child(4, [3])]);
    expect(three.nodes.map((n) => n.child.number).sort()).toEqual([1, 2, 3, 4]);
    // 1 → 3 → 2 closes on 2 → 1: stages [2] [3] [1, 4].
    expect(three.edges).toHaveLength(3);
    expect(three.stages.map((s) => s.nodes.map((n) => n.child.number))).toEqual([[2], [3], [1, 4]]);
  });

  it("without edges puts every child into one parallel stage", () => {
    const layout = layoutEpicFlow([child(1, [], "ready"), child(2, [], "ready"), child(3)]);
    expect(layout.stages).toHaveLength(1);
    expect(layout.stages[0].parallel).toBe(true);
    expect(layout.edges).toEqual([]);
    expect(firstParallelStage(layout)).toBe(1);
  });

  it("ignores self references and blockers outside the epic, counting the latter", () => {
    const layout = layoutEpicFlow([child(1, [1, 99]), child(2, [1, 1, 98])]);
    expect(layout.stages.map((s) => s.nodes.map((n) => n.child.number))).toEqual([[1], [2]]);
    expect(layout.edges).toHaveLength(1);
    expect(layout.outsideEdges).toBe(2);
  });

  it("an empty epic yields an empty layout", () => {
    const layout = layoutEpicFlow([]);
    expect(layout).toMatchObject({ stages: [], nodes: [], edges: [], width: 0, height: 0 });
  });

  it("walks children in epic order, not in array order", () => {
    const children = [child(2, [], "ready", 2), child(1, [], "ready", 1)];
    expect(stageNumbers(children)).toEqual([[1, 2]]);
  });

  it("sorts a stage by the rows of its blockers", () => {
    // 3 depends on the lower root (2), 4 on the upper one (1): 4 goes on top.
    const children = [child(1), child(2), child(3, [2]), child(4, [1])];
    expect(stageNumbers(children)).toEqual([
      [1, 2],
      [4, 3],
    ]);
  });

  it("places stages in columns and edges between node borders", () => {
    const layout = layoutEpicFlow(EXAMPLE);
    const at = (n: number) => layout.nodes.find((x) => x.child.number === n)!;
    expect(at(152).x).toBe(0);
    expect(at(153).x).toBe(FLOW_COL_WIDTH);
    expect(at(154).x).toBe(at(158).x);
    expect(at(155).y).toBeGreaterThan(at(154).y);
    const e = layout.edges.find((x) => x.from === 152)!;
    expect(e).toMatchObject({
      x1: FLOW_COL_WIDTH - FLOW_GAP_X,
      y1: FLOW_NODE_HEIGHT / 2,
      x2: FLOW_COL_WIDTH,
    });
    expect(layout.width).toBe(4 * FLOW_COL_WIDTH - FLOW_GAP_X);
  });

  it("honours a custom column width", () => {
    const layout = layoutEpicFlow(EXAMPLE, { colWidth: 300 });
    expect(layout.nodes.find((n) => n.child.number === 156)!.x).toBe(900);
    expect(layout.nodeWidth).toBe(300 - FLOW_GAP_X);
  });
});

describe("firstParallelStage", () => {
  it("skips a fan-out whose children are all merged", () => {
    const children = [
      child(1, [], "merged"),
      child(2, [1], "merged"),
      child(3, [1], "merged"),
      child(4, [2, 3], "ready"),
    ];
    expect(firstParallelStage(layoutEpicFlow(children))).toBeNull();
  });

  it("counts a fan-out with one merged and two open children", () => {
    const children = [
      child(1, [], "merged"),
      child(2, [1], "merged"),
      child(3, [1], "ready"),
      child(4, [1], "ready"),
    ];
    expect(firstParallelStage(layoutEpicFlow(children))).toBe(2);
  });
});

describe("flowTone", () => {
  it("maps the five child states onto the four legend groups", () => {
    expect(flowTone("ready")).toBe("ready");
    expect(flowTone("running")).toBe("active");
    expect(flowTone("in-review")).toBe("active");
    expect(flowTone("blocked")).toBe("waiting");
    expect(flowTone("merged")).toBe("merged");
  });
});
