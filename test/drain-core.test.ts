import { test, expect, describe } from "bun:test";
import { computeNext, selectCandidates, PRIORITY_LABEL } from "../src/drain-core";
import type { DrainRepoState, AutoSessionView } from "../src/drain-core";
import type { Issue, GitState } from "../src/forge/types";

const AUTO_LABEL = "shepherd:auto";

function issue(number: number, labels: string[] = [AUTO_LABEL]): Issue {
  return { number, title: `t${number}`, body: "b", url: `u${number}`, labels, createdAt: 0 };
}

const MERGEABLE: GitState = {
  kind: "github",
  state: "open",
  number: 7,
  checks: "success",
  headSha: "abc",
  mergeable: true,
  deployConfigured: false,
};

function autoSession(over: Partial<AutoSessionView> = {}): AutoSessionView {
  return {
    id: "s1",
    desig: "TASK-01",
    issueNumber: 1,
    status: "running",
    git: null,
    reviewDecision: null,
    reviewHeadSha: null,
    ...over,
  };
}

function state(over: Partial<DrainRepoState> = {}): DrainRepoState {
  return {
    enabled: true,
    criticEnabled: false,
    maxAuto: 2,
    usageCeilingPct: 80,
    usagePct: 0,
    autoSessions: [],
    mappedIssueNumbers: new Set<number>(),
    candidates: [],
    ...over,
  };
}

describe("computeNext", () => {
  test("disabled → hold disabled", () => {
    const d = computeNext(state({ enabled: false, candidates: [issue(1)] }));
    expect(d).toEqual({ kind: "hold", reason: { code: "disabled" } });
  });

  test("empty queue, slot free → hold empty", () => {
    const d = computeNext(state({ candidates: [] }));
    expect(d).toEqual({ kind: "hold", reason: { code: "empty" } });
  });

  test("one candidate, slot free → spawn it", () => {
    const i = issue(5);
    const d = computeNext(state({ candidates: [i] }));
    expect(d).toEqual({ kind: "spawn", issue: i });
  });

  test("cap hit → hold cap", () => {
    const d = computeNext(
      state({
        maxAuto: 1,
        autoSessions: [autoSession()],
        candidates: [issue(2)],
      }),
    );
    expect(d.kind).toBe("hold");
    expect((d as any).reason.code).toBe("cap");
  });

  test("usage at/over ceiling → hold usage with pct detail", () => {
    const d = computeNext(state({ usagePct: 92, usageCeilingPct: 80, candidates: [issue(2)] }));
    expect(d).toEqual({ kind: "hold", reason: { code: "usage", detail: "92" } });
  });

  test("usage just under ceiling → spawn", () => {
    const d = computeNext(state({ usagePct: 79, usageCeilingPct: 80, candidates: [issue(2)] }));
    expect(d.kind).toBe("spawn");
  });

  test("blocked auto session → hold blocked with desig", () => {
    const d = computeNext(
      state({
        autoSessions: [autoSession({ desig: "TASK-04", status: "blocked" })],
        candidates: [issue(2)],
      }),
    );
    expect(d).toEqual({ kind: "hold", reason: { code: "blocked", detail: "TASK-04" } });
  });

  test("critic changes_requested → hold changes_requested with desig", () => {
    const d = computeNext(
      state({
        autoSessions: [autoSession({ desig: "TASK-09", reviewDecision: "changes_requested" })],
        candidates: [issue(2)],
      }),
    );
    expect(d).toEqual({
      kind: "hold",
      reason: { code: "changes_requested", detail: "TASK-09" },
    });
  });

  test("critic error → hold error (don't advance on uncertainty)", () => {
    const d = computeNext(
      state({
        autoSessions: [autoSession({ desig: "TASK-09", reviewDecision: "error" })],
        candidates: [issue(2)],
      }),
    );
    expect(d).toEqual({ kind: "hold", reason: { code: "error", detail: "TASK-09" } });
  });

  test("dedupe: skips candidates already mapped to a session", () => {
    const i3 = issue(3);
    const d = computeNext(
      state({
        candidates: [issue(1), issue(2), i3],
        mappedIssueNumbers: new Set([1, 2]),
      }),
    );
    expect(d).toEqual({ kind: "spawn", issue: i3 });
  });

  test("dedupe: all candidates mapped → hold empty", () => {
    const d = computeNext(
      state({ candidates: [issue(1), issue(2)], mappedIssueNumbers: new Set([1, 2]) }),
    );
    expect(d).toEqual({ kind: "hold", reason: { code: "empty" } });
  });

  test("merge: open+green+mergeable, no blocking review → merge", () => {
    const d = computeNext(
      state({
        maxAuto: 2,
        autoSessions: [autoSession({ id: "sX", git: MERGEABLE, reviewDecision: null })],
      }),
    );
    expect(d).toEqual({ kind: "merge", sessionId: "sX", prNumber: 7 });
  });

  test("merge: commented review still merges", () => {
    const d = computeNext(
      state({
        autoSessions: [autoSession({ id: "sX", git: MERGEABLE, reviewDecision: "commented" })],
      }),
    );
    expect(d.kind).toBe("merge");
  });

  test("merge takes priority over spawning a fresh item", () => {
    const d = computeNext(
      state({
        maxAuto: 3,
        autoSessions: [autoSession({ id: "sX", git: MERGEABLE })],
        candidates: [issue(2)],
      }),
    );
    expect(d.kind).toBe("merge");
  });

  test("merge still allowed while a different session is in trouble", () => {
    const d = computeNext(
      state({
        autoSessions: [
          autoSession({ id: "blk", desig: "TASK-04", status: "blocked" }),
          autoSession({ id: "ok", issueNumber: 2, git: MERGEABLE }),
        ],
      }),
    );
    expect(d).toEqual({ kind: "merge", sessionId: "ok", prNumber: 7 });
  });

  test("no merge when that session's critic requested changes", () => {
    const d = computeNext(
      state({
        autoSessions: [
          autoSession({
            id: "sX",
            desig: "TASK-04",
            git: MERGEABLE,
            reviewDecision: "changes_requested",
          }),
        ],
      }),
    );
    expect(d.kind).toBe("hold");
    expect((d as any).reason.code).toBe("changes_requested");
  });

  test("no merge when critic verdict is error", () => {
    const d = computeNext(
      state({
        autoSessions: [
          autoSession({ id: "sX", desig: "TASK-04", git: MERGEABLE, reviewDecision: "error" }),
        ],
      }),
    );
    expect(d.kind).toBe("hold");
    expect((d as any).reason.code).toBe("error");
  });

  test("no merge when mergeable is false/null", () => {
    const notYet: GitState = { ...MERGEABLE, mergeable: null };
    const d = computeNext(state({ autoSessions: [autoSession({ id: "sX", git: notYet })] }));
    expect(d.kind).not.toBe("merge");
  });

  test("no merge when checks are not success", () => {
    const pending: GitState = { ...MERGEABLE, checks: "pending" };
    const d = computeNext(state({ autoSessions: [autoSession({ id: "sX", git: pending })] }));
    expect(d.kind).not.toBe("merge");
  });

  test("critic on + no verdict yet → hold (don't merge unreviewed)", () => {
    const d = computeNext(
      state({
        criticEnabled: true,
        autoSessions: [autoSession({ id: "sX", git: MERGEABLE, reviewDecision: null })],
      }),
    );
    expect(d.kind).toBe("hold");
  });

  test("critic on + commented verdict for current head → merge", () => {
    const d = computeNext(
      state({
        criticEnabled: true,
        autoSessions: [
          autoSession({
            id: "sX",
            git: MERGEABLE,
            reviewDecision: "commented",
            reviewHeadSha: MERGEABLE.headSha,
          }),
        ],
      }),
    );
    expect(d).toEqual({ kind: "merge", sessionId: "sX", prNumber: 7 });
  });

  test("critic on + verdict for an older head → hold (re-review pending)", () => {
    const d = computeNext(
      state({
        criticEnabled: true,
        autoSessions: [
          autoSession({
            id: "sX",
            git: MERGEABLE,
            reviewDecision: "commented",
            reviewHeadSha: "stale-sha",
          }),
        ],
      }),
    );
    expect(d.kind).toBe("hold");
  });

  test("critic off + no verdict → still merge (CI-green sole gate)", () => {
    const d = computeNext(
      state({
        criticEnabled: false,
        autoSessions: [autoSession({ id: "sX", git: MERGEABLE, reviewDecision: null })],
      }),
    );
    expect(d).toEqual({ kind: "merge", sessionId: "sX", prNumber: 7 });
  });
});

describe("selectCandidates", () => {
  test("filters to the auto label", () => {
    const out = selectCandidates([issue(1, ["other"]), issue(2, [AUTO_LABEL])], AUTO_LABEL);
    expect(out.map((i) => i.number)).toEqual([2]);
  });

  test("orders by issue number ascending", () => {
    const out = selectCandidates([issue(5), issue(2), issue(9)], AUTO_LABEL);
    expect(out.map((i) => i.number)).toEqual([2, 5, 9]);
  });

  test("priority-labeled issues jump the line, then by number", () => {
    const out = selectCandidates(
      [
        issue(2),
        issue(7, [AUTO_LABEL, PRIORITY_LABEL]),
        issue(4, [AUTO_LABEL, PRIORITY_LABEL]),
        issue(1),
      ],
      AUTO_LABEL,
    );
    expect(out.map((i) => i.number)).toEqual([4, 7, 1, 2]);
  });

  test("a priority label without the auto label is ignored", () => {
    const out = selectCandidates([issue(3, [PRIORITY_LABEL])], AUTO_LABEL);
    expect(out).toEqual([]);
  });
});
