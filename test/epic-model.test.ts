import { test, expect, describe } from "bun:test";
import { assembleEpic, type AssembleInput } from "../src/epic-model";

const BASE: AssembleInput = {
  repoPath: "/repo",
  run: { repoPath: "/repo", parentIssueNumber: 327, mode: "auto", status: "running" },
  parent: { number: 327, title: "EFI cluster", body: "" },
  // native per-child state: 320 closed; 322 open + body, UNCLAIMED — NO listIssues needed.
  // 322 stays unclaimed so its ready/blocked state proves native closed-detection of its blocker.
  subIssues: [
    { number: 320, title: "EFI", url: "u320", body: "b320", closed: true, labels: [] },
    {
      number: 322,
      title: "effort",
      url: "u322",
      body: "effort body",
      closed: false,
      labels: [],
    },
  ],
  blockedBy: new Map([[322, [320]]]),
  openIssues: [], // markdown-only input; ignored on the native path
  openIssuesTruncated: false,
  sessions: [],
  integrated: new Set<number>(),
  persistedBranch: "epic/327-efi-cluster", // matches derive(327,"EFI cluster") → no (a) warning
};

describe("assembleEpic", () => {
  test("native: order/state/body from sub-issue payload (no listIssues)", () => {
    const e = assembleEpic(BASE);
    expect(e.source).toBe("native");
    expect(e.children.map((c) => c.number)).toEqual([320, 322]);
    expect(e.children.find((c) => c.number === 320)!.state).toBe("merged"); // closed via native state
    // 322 open, unclaimed, blocker 320 closed (native) → ready
    expect(e.children.find((c) => c.number === 322)!.state).toBe("ready");
    expect(e.children.find((c) => c.number === 322)!.claimed).toBe(false);
    expect(e.children.find((c) => c.number === 322)!.body).toBe("effort body");
  });
  test("native gating is correct even when openIssues is empty/over-cap", () => {
    // 320 NOT in openIssues at all — old code would misread it; native state keeps it closed.
    // 322 (unclaimed) is "ready" ONLY because 320 was detected closed from native state, not openIssues.
    expect(assembleEpic(BASE).children.find((c) => c.number === 322)!.state).toBe("ready");
  });
  test("claimed child with no live session surfaces as in-review (retired/in-flight, PR awaiting merge)", () => {
    const e = assembleEpic({
      ...BASE,
      subIssues: [
        { number: 320, title: "EFI", url: "u320", body: "", closed: true, labels: [] },
        {
          number: 324,
          title: "wts",
          url: "u324",
          body: "",
          closed: false,
          labels: ["shepherd:active"],
        },
      ],
      blockedBy: new Map(),
    });
    const c = e.children.find((x) => x.number === 324)!;
    expect(c.claimed).toBe(true);
    expect(c.sessionId).toBeNull();
    expect(c.state).toBe("in-review");
  });
  test("markdown fallback derives state from openIssues + warns on truncation", () => {
    const e = assembleEpic({
      ...BASE,
      subIssues: [],
      blockedBy: new Map(),
      parent: { number: 1, title: "p", body: "```epic-dag\n#2\n#3 <- #2\n```" },
      persistedBranch: "epic/1-p", // matches derive(1,"p") → isolate the truncation warning
      openIssues: [
        { number: 2, body: "", labels: [] },
        { number: 3, body: "", labels: [] },
      ],
      openIssuesTruncated: true,
    });
    expect(e.source).toBe("markdown");
    expect(e.children.find((c) => c.number === 3)!.state).toBe("blocked"); // #2 open → not closed
    expect(e.warnings.some((w) => w.includes("truncated"))).toBe(true);
  });
  test("non-member + self edges dropped + warned", () => {
    const e = assembleEpic({ ...BASE, blockedBy: new Map([[322, [999, 322]]]) });
    expect(e.children.find((c) => c.number === 322)!.blockedBy).toEqual([]);
    expect(e.warnings.filter((w) => w.includes("blocked_by")).length).toBe(2);
  });
});

function input(over: Partial<AssembleInput>): AssembleInput {
  return {
    repoPath: "/r",
    run: { repoPath: "/r", parentIssueNumber: 327, mode: "auto", status: "running" },
    parent: { number: 327, title: "Epic", body: "" },
    subIssues: [
      { number: 320, title: "root", url: "u320", body: "", closed: false, labels: [] },
      { number: 322, title: "dep", url: "u322", body: "", closed: false, labels: [] },
    ],
    blockedBy: new Map([[322, [320]]]),
    openIssues: [],
    openIssuesTruncated: false,
    sessions: [],
    integrated: new Set<number>(),
    persistedBranch: "epic/327-epic", // matches derive(327,"Epic") → no (a) warning
    ...over,
  };
}

test("a child in the integrated set is integrationMerged and reads 'merged'", () => {
  const epic = assembleEpic(input({ integrated: new Set([320]) }));
  const c320 = epic.children.find((c) => c.number === 320)!;
  expect(c320.integrationMerged).toBe(true);
  expect(c320.state).toBe("merged");
});

test("integration-merging the blocker unblocks the dependent (issues still open)", () => {
  const epic = assembleEpic(input({ integrated: new Set([320]) }));
  expect(epic.children.find((c) => c.number === 322)!.state).toBe("ready");
});

test("empty integrated set leaves the dependent blocked", () => {
  const epic = assembleEpic(input({ integrated: new Set() }));
  expect(epic.children.find((c) => c.number === 322)!.state).toBe("blocked");
});

// ── #645 divergence warnings ──────────────────────────────────────────────
describe("epic-branch divergence warnings (#645)", () => {
  // (a) title drift
  test("(a) pinned branch ≠ freshly-derived canonical → title-drift warning", () => {
    const e = assembleEpic(
      input({ parent: { number: 327, title: "Renamed thing", body: "" } }),
      // persistedBranch stays epic/327-epic from input(); live title now derives differently
    );
    expect(
      e.warnings.some(
        (w) =>
          w.includes("epic/327-epic") &&
          w.includes("epic/327-renamed-thing") &&
          w.includes("title edited"),
      ),
    ).toBe(true);
  });
  test("(a) aligned pinned/derived name → NO title-drift warning", () => {
    const e = assembleEpic(input({})); // title "Epic" derives epic/327-epic = pinned
    expect(e.warnings.some((w) => w.includes("title edited"))).toBe(false);
  });

  // (b) integrated-child drift
  test("(b) child merged into a non-pinned base → drift warning", () => {
    const e = assembleEpic(input({ integratedBases: new Map([[320, "epic/efi-valuemap-327"]]) }));
    expect(
      e.warnings.some(
        (w) =>
          w.includes("child #320") &&
          w.includes("epic/efi-valuemap-327") &&
          w.includes("epic/327-epic"),
      ),
    ).toBe(true);
  });
  test("(b) child merged into the pinned base → NO warning", () => {
    const e = assembleEpic(input({ integratedBases: new Map([[320, "epic/327-epic"]]) }));
    expect(e.warnings.some((w) => w.includes("child #320"))).toBe(false);
  });
  test("(b) null mergedBase (legacy row) → NO warning", () => {
    // a Map without the entry, or absent map entirely
    const e1 = assembleEpic(input({ integratedBases: new Map() }));
    const e2 = assembleEpic(input({})); // integratedBases undefined
    expect(e1.warnings.some((w) => w.includes("child #"))).toBe(false);
    expect(e2.warnings.some((w) => w.includes("child #"))).toBe(false);
  });

  // (c) host-branch drift
  test("(c) divergent host branch → drift warning per branch", () => {
    const e = assembleEpic(input({ divergentBranches: ["epic/efi-valuemap-327", "epic/327-old"] }));
    const c = e.warnings.filter((w) => w.includes("divergent epic branch"));
    expect(c).toHaveLength(2);
    expect(c.some((w) => w.includes("epic/efi-valuemap-327") && w.includes("epic #327"))).toBe(
      true,
    );
  });
  test("(c) no divergent branches → NO warning", () => {
    const e = assembleEpic(input({ divergentBranches: [] }));
    expect(e.warnings.some((w) => w.includes("divergent epic branch"))).toBe(false);
  });
});
