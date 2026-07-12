import { test, expect, describe } from "bun:test";
import {
  computeEpicOthersFlags,
  deriveChildState,
  selectEpicCandidates,
  type EpicChild,
} from "../src/epic-core";
import type { LinkedPr } from "../src/forge/types";

function child(over: Partial<EpicChild> = {}): EpicChild {
  return {
    number: 1,
    title: "t",
    url: "u",
    order: 0,
    body: "",
    blockedBy: [],
    state: "blocked",
    sessionId: null,
    prNumber: null,
    issueClosed: false,
    integrationMerged: false,
    claimed: false,
    ...over,
  };
}

describe("deriveChildState", () => {
  test("closed → merged", () =>
    expect(deriveChildState(child({ issueClosed: true }), new Set())).toBe("merged"));
  test("session+PR → in-review", () =>
    expect(deriveChildState(child({ sessionId: "s", prNumber: 9 }), new Set())).toBe("in-review"));
  test("session no PR → running", () =>
    expect(deriveChildState(child({ sessionId: "s" }), new Set())).toBe("running"));
  test("blockers closed → ready", () =>
    expect(deriveChildState(child({ blockedBy: [2] }), new Set([2]))).toBe("ready"));
  test("blocker open → blocked", () =>
    expect(deriveChildState(child({ blockedBy: [2] }), new Set())).toBe("blocked"));
  test("claimed, no session, issue open → in-review (retired/in-flight, PR awaiting merge)", () =>
    expect(
      deriveChildState(
        child({ claimed: true, sessionId: null, issueClosed: false, blockedBy: [] }),
        new Set(),
      ),
    ).toBe("in-review"));
});

describe("selectEpicCandidates", () => {
  test("ready, unclaimed, unspawned, in order → Issue[]", () => {
    const kids = [
      child({ number: 320, order: 0, issueClosed: true }), // merged
      child({ number: 322, order: 1, blockedBy: [320] }), // ready (320 closed)
      child({ number: 326, order: 2 }), // ready root
      child({ number: 323, order: 3, blockedBy: [321] }), // blocked (321 open)
      child({ number: 321, order: 4, claimed: true }), // claimed → skip
      child({ number: 999, order: 5, sessionId: "s" }), // running → skip
    ];
    expect(selectEpicCandidates(kids).map((i) => i.number)).toEqual([322, 326]);
  });
  test("ties on order break by number ascending", () => {
    const kids = [child({ number: 30, order: 0 }), child({ number: 12, order: 0 })];
    expect(selectEpicCandidates(kids).map((i) => i.number)).toEqual([12, 30]);
  });
  test("returns Issue-shaped objects carrying the real body", () => {
    const [i] = selectEpicCandidates([
      child({ number: 5, title: "x", url: "ux", body: "full Notion body" }),
    ]);
    expect(i).toEqual({
      number: 5,
      title: "x",
      body: "full Notion body",
      url: "ux",
      labels: [],
      createdAt: 0,
      assignees: [],
    });
  });
});

describe("integrationMerged", () => {
  test("integration-merged child reads 'merged' even with the issue still open", () => {
    const c = child({ number: 320, issueClosed: false, integrationMerged: true });
    expect(deriveChildState(c, new Set())).toBe("merged");
  });

  test("a dependent unblocks once its blocker is integration-merged (issue still open)", () => {
    const blocker = child({ number: 320, integrationMerged: true });
    const dep = child({ number: 322, blockedBy: [320] });
    expect(selectEpicCandidates([blocker, dep]).map((c) => c.number)).toEqual([322]);
  });

  test("a dependent stays blocked while its blocker is neither integrated nor closed", () => {
    const blocker = child({ number: 320 });
    const dep = child({ number: 322, blockedBy: [320] });
    expect(deriveChildState(dep, new Set())).toBe("blocked");
    expect(selectEpicCandidates([blocker, dep]).map((c) => c.number)).toEqual([320]);
  });

  test("legacy issue-closed path still satisfies a dependency", () => {
    const blocker = child({ number: 320, issueClosed: true });
    const dep = child({ number: 322, blockedBy: [320] });
    expect(selectEpicCandidates([blocker, dep]).map((c) => c.number)).toEqual([322]);
  });
});

describe("computeEpicOthersFlags", () => {
  const linkedMap = (entries: [number, LinkedPr[]][]) => new Map<number, LinkedPr[]>(entries);

  test("counts children with a non-viewer open PR and collects distinct authors", () => {
    const flags = computeEpicOthersFlags({
      childNumbers: [10, 11, 12],
      linked: linkedMap([
        [10, [{ prNumber: 100, author: "scoop" }]],
        [11, [{ prNumber: 101, author: "scoop" }]],
        [12, []], // present but no PRs
      ]),
      assignees: [],
      author: "scoop",
      viewer: "kai",
    });
    expect(flags.inFlight).toBe(2);
    expect(flags.inFlightBy).toEqual(["scoop"]);
    expect(flags.authoredByOther).toBe("scoop");
  });

  test("excludes the viewer's own PRs from the count, not just the names", () => {
    const flags = computeEpicOthersFlags({
      childNumbers: [10, 11],
      linked: linkedMap([
        [10, [{ prNumber: 100, author: "kai" }]], // viewer's own → not counted
        [
          11,
          [
            { prNumber: 101, author: "kai" },
            { prNumber: 102, author: "scoop" },
          ],
        ],
      ]),
      assignees: [],
      author: null,
      viewer: "kai",
    });
    expect(flags.inFlight).toBe(1); // only #11 has a non-viewer PR
    expect(flags.inFlightBy).toEqual(["scoop"]);
  });

  test("an epic whose only in-flight PR is the viewer's shows no pill", () => {
    const flags = computeEpicOthersFlags({
      childNumbers: [10],
      linked: linkedMap([[10, [{ prNumber: 100, author: "kai" }]]]),
      assignees: [],
      author: "kai",
      viewer: "kai",
    });
    expect(flags.inFlight).toBe(0);
    expect(flags.inFlightBy).toEqual([]);
    expect(flags.authoredByOther).toBeNull();
  });

  test("surfaces assignees other than the viewer, sorted and deduped", () => {
    const flags = computeEpicOthersFlags({
      childNumbers: [],
      linked: linkedMap([]),
      assignees: ["scoop", "kai", "ada", "scoop"],
      author: "kai",
      viewer: "kai",
    });
    expect(flags.assignedOthers).toEqual(["ada", "scoop"]);
  });

  test("author flag alone fires for a fresh unassigned epic with no child PRs", () => {
    const flags = computeEpicOthersFlags({
      childNumbers: [10, 11],
      linked: linkedMap([]),
      assignees: [],
      author: "scoop",
      viewer: "kai",
    });
    expect(flags.inFlight).toBe(0);
    expect(flags.assignedOthers).toEqual([]);
    expect(flags.authoredByOther).toBe("scoop");
  });

  test("null viewer fails open — every non-empty author/assignee counts as other", () => {
    const flags = computeEpicOthersFlags({
      childNumbers: [10],
      linked: linkedMap([[10, [{ prNumber: 100, author: "scoop" }]]]),
      assignees: ["ada"],
      author: "scoop",
      viewer: null,
    });
    expect(flags.inFlight).toBe(1);
    expect(flags.inFlightBy).toEqual(["scoop"]);
    expect(flags.assignedOthers).toEqual(["ada"]);
    expect(flags.authoredByOther).toBe("scoop");
  });

  test("dedupes repeated child numbers so a child is counted once", () => {
    const flags = computeEpicOthersFlags({
      childNumbers: [10, 10], // markdown ∪ native can overlap
      linked: linkedMap([[10, [{ prNumber: 100, author: "scoop" }]]]),
      assignees: [],
      author: null,
      viewer: "kai",
    });
    expect(flags.inFlight).toBe(1);
  });
});
