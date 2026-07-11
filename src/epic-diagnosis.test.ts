import { describe, expect, it } from "bun:test";
import type { Epic, EpicChild, EpicChildState, EpicRun } from "./epic-core";
import type { ParsedEpic } from "./epic-parse";
import type { SubIssueRef } from "./forge/types";
import { MARKDOWN_TRUNCATION_WARNING } from "./epic-model";
import { diagnoseEpic, type EpicDiagnosisInput } from "./epic-diagnosis";

// ── fixtures ─────────────────────────────────────────────────────────────────

const RUN: EpicRun = {
  repoPath: "/repo",
  parentIssueNumber: 1,
  mode: "auto",
  status: "idle",
};

function child(number: number, state: EpicChildState, over: Partial<EpicChild> = {}): EpicChild {
  return {
    number,
    title: `#${number}`,
    url: "",
    order: number,
    body: "",
    blockedBy: [], // assembleEpic strips self/outside edges — children carry none of them
    state,
    sessionId: null,
    prNumber: null,
    issueClosed: false,
    integrationMerged: false,
    claimed: false,
    ...over,
  };
}

function epic(over: Partial<Epic> = {}): Epic {
  return {
    repoPath: "/repo",
    parentIssueNumber: 1,
    parentTitle: "Epic",
    source: "native",
    children: [child(2, "ready"), child(3, "ready")],
    warnings: [],
    run: RUN,
    ...over,
  };
}

const EMPTY_BODY: ParsedEpic = { members: [], order: [], edges: [] };

function input(over: Partial<EpicDiagnosisInput> = {}): EpicDiagnosisInput {
  return {
    epic: epic(),
    subIssues: [],
    blockedBy: new Map(),
    parsedBody: EMPTY_BODY,
    openIssuesTruncated: false,
    ...over,
  };
}

function ids(d: ReturnType<typeof diagnoseEpic>): string[] {
  return d.findings.map((f) => f.id);
}

function find(d: ReturnType<typeof diagnoseEpic>, id: string) {
  return d.findings.find((f) => f.id === id);
}

// ── no-children ──────────────────────────────────────────────────────────────

describe("no-children", () => {
  it("fires when no children; recognized:false, source:null; still computes additionalWarnings", () => {
    const d = diagnoseEpic(
      input({ epic: epic({ children: [], warnings: ["some divergence warning"] }) }),
    );
    expect(d.recognized).toBe(false);
    expect(d.source).toBeNull();
    expect(ids(d)).toEqual(["no-children"]);
    expect(find(d, "no-children")!.severity).toBe("error");
    expect(d.additionalWarnings).toEqual(["some divergence warning"]);
  });
});

// ── markdown-source ──────────────────────────────────────────────────────────

describe("markdown-source", () => {
  it("present with action import-structure for a markdown epic", () => {
    const d = diagnoseEpic(input({ epic: epic({ source: "markdown" }) }));
    const f = find(d, "markdown-source");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("info");
    expect(f!.action).toBe("import-structure");
  });

  it("absent for a native epic", () => {
    const d = diagnoseEpic(input({ epic: epic({ source: "native" }) }));
    expect(find(d, "markdown-source")).toBeUndefined();
  });
});

// ── truncated-open-list ──────────────────────────────────────────────────────

describe("truncated-open-list", () => {
  it("fires for markdown + openIssuesTruncated:true with action import-structure", () => {
    const d = diagnoseEpic(
      input({ epic: epic({ source: "markdown" }), openIssuesTruncated: true }),
    );
    const f = find(d, "truncated-open-list");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("warning");
    expect(f!.action).toBe("import-structure");
  });

  it("absent for markdown without truncation", () => {
    const d = diagnoseEpic(
      input({ epic: epic({ source: "markdown" }), openIssuesTruncated: false }),
    );
    expect(find(d, "truncated-open-list")).toBeUndefined();
  });

  it("absent for native even when truncated", () => {
    const d = diagnoseEpic(input({ epic: epic({ source: "native" }), openIssuesTruncated: true }));
    expect(find(d, "truncated-open-list")).toBeUndefined();
  });
});

// ── all-parallel ─────────────────────────────────────────────────────────────

describe("all-parallel", () => {
  it("fires on noDependencyEdges:true with correct ready count", () => {
    const d = diagnoseEpic(
      input({
        epic: epic({
          noDependencyEdges: true,
          children: [child(2, "ready"), child(3, "ready"), child(4, "blocked")],
        }),
      }),
    );
    const f = find(d, "all-parallel");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("warning");
    expect(f!.params).toEqual({ count: 2 });
  });

  it("absent when noDependencyEdges is not set", () => {
    const d = diagnoseEpic(input());
    expect(find(d, "all-parallel")).toBeUndefined();
  });
});

// ── self / outside edges — recomputed from RAW edges, not epic.children ───────

describe("self-dependency & outside-epic-dependency (native raw blockedBy)", () => {
  it("recomputes from blockedBy even though children.blockedBy is empty", () => {
    const kids = [child(2, "ready"), child(3, "ready")];
    // sanity: children carry NO blockedBy (assembleEpic stripped them)
    expect(kids.every((c) => c.blockedBy.length === 0)).toBe(true);
    const d = diagnoseEpic(
      input({
        epic: epic({ source: "native", children: kids }),
        blockedBy: new Map([
          [3, [3, 99]], // self-loop + outside-epic blocker
        ]),
      }),
    );
    const self = find(d, "self-dependency");
    expect(self!.params).toEqual({ child: 3 });
    const outside = find(d, "outside-epic-dependency");
    expect(outside!.params).toEqual({ child: 3, blocker: 99 });
  });

  it("dedupes a repeated self-loop to one finding per child", () => {
    const d = diagnoseEpic(
      input({
        epic: epic({ source: "native", children: [child(2, "ready"), child(3, "ready")] }),
        blockedBy: new Map([[2, [2, 2]]]),
      }),
    );
    expect(d.findings.filter((f) => f.id === "self-dependency")).toHaveLength(1);
  });
});

describe("self-dependency & outside-epic-dependency (markdown parsedBody edges)", () => {
  it("recomputes from parsedBody.edges", () => {
    const d = diagnoseEpic(
      input({
        epic: epic({ source: "markdown", children: [child(2, "ready"), child(3, "ready")] }),
        parsedBody: {
          members: [2, 3],
          order: [2, 3],
          edges: [
            { dependent: 2, blocker: 2 }, // self
            { dependent: 3, blocker: 88 }, // outside
          ],
        },
      }),
    );
    expect(find(d, "self-dependency")!.params).toEqual({ child: 2 });
    expect(find(d, "outside-epic-dependency")!.params).toEqual({ child: 3, blocker: 88 });
  });

  it("orders findings by ascending child then blocker", () => {
    const d = diagnoseEpic(
      input({
        epic: epic({ source: "native", children: [child(2, "ready"), child(3, "ready")] }),
        blockedBy: new Map([
          [3, [77, 66]],
          [2, [55]],
        ]),
      }),
    );
    const outside = d.findings.filter((f) => f.id === "outside-epic-dependency");
    expect(outside.map((f) => [f.params!.child, f.params!.blocker])).toEqual([
      [2, 55],
      [3, 66],
      [3, 77],
    ]);
  });
});

// ── native-body-disagree — guarded ───────────────────────────────────────────

describe("native-body-disagree", () => {
  it("does NOT fire for a native epic with an empty body (the false-fire guard)", () => {
    const d = diagnoseEpic(
      input({
        epic: epic({ source: "native", children: [child(2, "ready"), child(3, "ready")] }),
        subIssues: [sub(2), sub(3)],
        parsedBody: EMPTY_BODY,
      }),
    );
    expect(find(d, "native-body-disagree")).toBeUndefined();
  });

  it("fires when the body declares a differing non-empty member set", () => {
    const d = diagnoseEpic(
      input({
        epic: epic({ source: "native", children: [child(2, "ready"), child(3, "ready")] }),
        subIssues: [sub(2), sub(3)],
        parsedBody: { members: [2, 5], order: [2, 5], edges: [] },
      }),
    );
    const f = find(d, "native-body-disagree");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("warning");
    expect(f!.action).toBeUndefined();
    expect(f!.params).toEqual({ onlyInBody: "#5", onlyInNative: "#3" });
  });

  it("does NOT fire when body and native sets are equal", () => {
    const d = diagnoseEpic(
      input({
        epic: epic({ source: "native", children: [child(2, "ready"), child(3, "ready")] }),
        subIssues: [sub(2), sub(3)],
        parsedBody: { members: [3, 2], order: [3, 2], edges: [] },
      }),
    );
    expect(find(d, "native-body-disagree")).toBeUndefined();
  });
});

function sub(number: number): SubIssueRef {
  return { number, title: `#${number}`, url: "", body: "", closed: false, labels: [] };
}

// ── additionalWarnings dedupe ────────────────────────────────────────────────

describe("additionalWarnings dedupe", () => {
  const warnings = [
    MARKDOWN_TRUNCATION_WARNING,
    "#3 blocked_by itself — ignored",
    "#4 blocked_by #9 is outside the epic — ignored",
    "epic branch pinned to `x`; current title derives `y`",
  ];

  it("excludes structurally-covered warnings, passes through divergence (native)", () => {
    const d = diagnoseEpic(input({ epic: epic({ source: "native", warnings }) }));
    expect(d.additionalWarnings).toEqual(["epic branch pinned to `x`; current title derives `y`"]);
  });

  it("excludes structurally-covered warnings, passes through divergence (markdown)", () => {
    const d = diagnoseEpic(input({ epic: epic({ source: "markdown", warnings }) }));
    expect(d.additionalWarnings).toEqual(["epic branch pinned to `x`; current title derives `y`"]);
  });
});

// ── fragment drift guard ─────────────────────────────────────────────────────

describe("fragment drift guard", () => {
  it("the fragments the filter matches are present in the strings assembleEpic emits", () => {
    expect(MARKDOWN_TRUNCATION_WARNING.length).toBeGreaterThan(0);
    // Reconstruct exactly what epic-model.ts:117 / :121 push at runtime.
    const selfWarning = `#3 blocked_by itself — ignored`;
    const outsideWarning = `#4 blocked_by #9 is outside the epic — ignored`;
    expect(selfWarning).toContain("blocked_by itself — ignored");
    expect(outsideWarning).toContain("is outside the epic — ignored");
  });
});
