import { test, expect, describe } from "bun:test";
import { computeNext, selectCandidates, PRIORITY_LABEL, ACTIVE_LABEL } from "../src/drain-core";
import type { DrainRepoState, AutoSessionView } from "../src/drain-core";
import type { Issue, GitState } from "../src/forge/types";

const AUTO_LABEL = "shepherd:auto";

function issue(number: number, labels: string[] = [AUTO_LABEL]): Issue {
  return {
    number,
    title: `t${number}`,
    body: "b",
    url: `u${number}`,
    labels,
    createdAt: 0,
    assignees: [],
  };
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
    isDraft: false,
    humanApproved: false,
    findings: [],
    fullAuto: false,
    ...over,
  };
}

function state(over: Partial<DrainRepoState> = {}): DrainRepoState {
  return {
    enabled: true,
    criticEnabled: false,
    draftMode: false,
    signoffAuthority: "human",
    maxAuto: 2,
    usageCeilingPct: 80,
    usagePct: 0,
    creditSpent: 0,
    creditSpendCeiling: 0,
    autoSessions: [],
    mappedIssueNumbers: new Set<number>(),
    candidates: [],
    spawnAgentProvider: "claude",
    epicAttended: false,
    epicApprovedNext: false,
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

  test("epic provider settings are carried only when present", () => {
    const i = issue(5);
    const d = computeNext(
      state({
        candidates: [i],
        epicIntegrationBranch: "epic/327-parent",
        epicProviderSettings: { agentProvider: "codex", model: "gpt-5.5", effort: "high" },
      }),
    );
    expect(d).toEqual({
      kind: "spawn",
      issue: i,
      integrationBranch: "epic/327-parent",
      epicProviderSettings: { agentProvider: "codex", model: "gpt-5.5", effort: "high" },
    });
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

  test("explicit Codex epic spawn bypasses Claude usage ceiling", () => {
    const i = issue(2);
    const d = computeNext(
      state({
        usagePct: 100,
        usageCeilingPct: 80,
        candidates: [i],
        spawnAgentProvider: "codex",
        epicProviderSettings: { agentProvider: "codex", model: "gpt-5.5", effort: "high" },
      }),
    );
    expect(d).toEqual({
      kind: "spawn",
      issue: i,
      epicProviderSettings: { agentProvider: "codex", model: "gpt-5.5", effort: "high" },
    });
  });

  test("explicit Claude epic still honors usage ceiling", () => {
    const d = computeNext(
      state({
        usagePct: 100,
        usageCeilingPct: 80,
        candidates: [issue(2)],
        spawnAgentProvider: "claude",
        epicProviderSettings: { agentProvider: "claude", model: "sonnet", effort: "high" },
      }),
    );
    expect(d).toEqual({ kind: "hold", reason: { code: "usage", detail: "100" } });
  });

  test("usage just under ceiling → spawn", () => {
    const d = computeNext(state({ usagePct: 79, usageCeilingPct: 80, candidates: [issue(2)] }));
    expect(d.kind).toBe("spawn");
  });

  test("inherited Codex spawn bypasses Claude usage ceiling", () => {
    const i = issue(2);
    const d = computeNext(
      state({
        usagePct: 100,
        usageCeilingPct: 80,
        candidates: [i],
        spawnAgentProvider: "codex",
        epicProviderSettings: null,
      }),
    );
    expect(d).toEqual({ kind: "spawn", issue: i });
  });

  test("extra-credit spend over ceiling → hold credits with spend detail", () => {
    const d = computeNext(
      state({ creditSpent: 0.29, creditSpendCeiling: 0, candidates: [issue(2)] }),
    );
    expect(d).toEqual({ kind: "hold", reason: { code: "credits", detail: "0.29" } });
  });

  test("explicit Codex epic spawn bypasses Claude extra-credit guard", () => {
    const i = issue(2);
    const d = computeNext(
      state({
        creditSpent: 0.29,
        creditSpendCeiling: 0,
        candidates: [i],
        spawnAgentProvider: "codex",
        epicProviderSettings: { agentProvider: "codex", model: "gpt-5.5", effort: "high" },
      }),
    );
    expect(d.kind).toBe("spawn");
  });

  test("extra-credit spend equal to ceiling → no credits hold (uses > not >=)", () => {
    const d = computeNext(state({ creditSpent: 5, creditSpendCeiling: 5, candidates: [issue(2)] }));
    expect(d.kind).toBe("spawn");
  });

  test("extra-credit spend 0 (stale/absent) → no credits hold", () => {
    const d = computeNext(state({ creditSpent: 0, creditSpendCeiling: 0, candidates: [issue(2)] }));
    expect(d.kind).toBe("spawn");
  });

  test("credits guard sits AFTER the usage gate (usage wins when both fire)", () => {
    const d = computeNext(
      state({
        usagePct: 92,
        usageCeilingPct: 80,
        creditSpent: 1,
        creditSpendCeiling: 0,
        candidates: [issue(2)],
      }),
    );
    expect(d).toEqual({ kind: "hold", reason: { code: "usage", detail: "92" } });
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

  // A verdict for an OLDER head (rework pushed, PR open at a newer head, CI/re-review pending) is
  // stale — not trouble. It must NOT pause the drain; suppression advances computeNext past the
  // trouble gate so the fleet resumes draining (throughput change, intended).
  const STALE_GIT: GitState = {
    kind: "github",
    state: "open",
    number: 7,
    checks: "pending", // CI running on the new head
    headSha: "newsha",
    mergeable: null,
    deployConfigured: false,
  };

  test("stale changes_requested (rework pushed, CI on newer head) → NOT trouble; drain spawns", () => {
    const i2 = issue(2);
    const d = computeNext(
      state({
        maxAuto: 2,
        autoSessions: [
          autoSession({
            desig: "TASK-09",
            reviewDecision: "changes_requested",
            reviewHeadSha: "oldsha",
            git: STALE_GIT,
          }),
        ],
        candidates: [i2],
      }),
    );
    expect(d).toEqual({ kind: "spawn", issue: i2 });
  });

  test("stale error verdict → NOT trouble; drain spawns", () => {
    const i2 = issue(2);
    const d = computeNext(
      state({
        maxAuto: 2,
        autoSessions: [
          autoSession({
            desig: "TASK-09",
            reviewDecision: "error",
            reviewHeadSha: "oldsha",
            git: STALE_GIT,
          }),
        ],
        candidates: [i2],
      }),
    );
    expect(d).toEqual({ kind: "spawn", issue: i2 });
  });

  test("stale changes_requested at cap (maxAuto=1) → holds as cap, not changes_requested", () => {
    const d = computeNext(
      state({
        maxAuto: 1,
        autoSessions: [
          autoSession({
            desig: "TASK-09",
            reviewDecision: "changes_requested",
            reviewHeadSha: "oldsha",
            git: STALE_GIT,
          }),
        ],
        candidates: [issue(2)],
      }),
    );
    expect(d).toEqual({ kind: "hold", reason: { code: "cap", detail: "1" } });
  });

  test("changes_requested at the CURRENT head → still holds (not stale)", () => {
    const liveGit: GitState = { ...STALE_GIT, headSha: "samesha" };
    const d = computeNext(
      state({
        autoSessions: [
          autoSession({
            desig: "TASK-09",
            reviewDecision: "changes_requested",
            reviewHeadSha: "samesha",
            git: liveGit,
          }),
        ],
        candidates: [issue(2)],
      }),
    );
    expect(d).toEqual({ kind: "hold", reason: { code: "changes_requested", detail: "TASK-09" } });
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

  test("retire: open+green+mergeable, no blocking review → retire", () => {
    const d = computeNext(
      state({
        maxAuto: 2,
        autoSessions: [autoSession({ id: "sX", git: MERGEABLE, reviewDecision: null })],
      }),
    );
    expect(d).toEqual({ kind: "retire", sessionId: "sX", prNumber: 7 });
  });

  test("retire: no-CI repo (noCi + checks:none + mergeable) → retire", () => {
    const noCiGit: GitState = { ...MERGEABLE, checks: "none", noCi: true };
    const d = computeNext(
      state({
        autoSessions: [autoSession({ id: "sX", git: noCiGit, reviewDecision: null })],
      }),
    );
    expect(d).toEqual({ kind: "retire", sessionId: "sX", prNumber: 7 });
  });

  test("retire: checks:none WITHOUT noCi → does NOT retire (CI repo pre-green)", () => {
    const preGreen: GitState = { ...MERGEABLE, checks: "none" };
    const d = computeNext(
      state({
        autoSessions: [autoSession({ id: "sX", git: preGreen, reviewDecision: null })],
        candidates: [],
      }),
    );
    expect(d.kind).not.toBe("retire");
  });

  test("retire: commented review still retires", () => {
    const d = computeNext(
      state({
        autoSessions: [autoSession({ id: "sX", git: MERGEABLE, reviewDecision: "commented" })],
      }),
    );
    expect(d.kind).toBe("retire");
  });

  test("retire takes priority over spawning a fresh item", () => {
    const d = computeNext(
      state({
        maxAuto: 3,
        autoSessions: [autoSession({ id: "sX", git: MERGEABLE })],
        candidates: [issue(2)],
      }),
    );
    expect(d.kind).toBe("retire");
  });

  test("retire still allowed while a different session is in trouble", () => {
    const d = computeNext(
      state({
        autoSessions: [
          autoSession({ id: "blk", desig: "TASK-04", status: "blocked" }),
          autoSession({ id: "ok", issueNumber: 2, git: MERGEABLE }),
        ],
      }),
    );
    expect(d).toEqual({ kind: "retire", sessionId: "ok", prNumber: 7 });
  });

  test("no retire when that session's critic requested changes", () => {
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

  test("no retire when critic verdict is error", () => {
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

  test("no retire when mergeable is false/null", () => {
    const notYet: GitState = { ...MERGEABLE, mergeable: null };
    const d = computeNext(state({ autoSessions: [autoSession({ id: "sX", git: notYet })] }));
    expect(d.kind).not.toBe("retire");
  });

  test("no retire when checks are not success", () => {
    const pending: GitState = { ...MERGEABLE, checks: "pending" };
    const d = computeNext(state({ autoSessions: [autoSession({ id: "sX", git: pending })] }));
    expect(d.kind).not.toBe("retire");
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

  test("critic on + commented verdict for current head → retire", () => {
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
    expect(d).toEqual({ kind: "retire", sessionId: "sX", prNumber: 7 });
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

  test("critic off + no verdict → still retire (CI-green sole gate)", () => {
    const d = computeNext(
      state({
        criticEnabled: false,
        autoSessions: [autoSession({ id: "sX", git: MERGEABLE, reviewDecision: null })],
      }),
    );
    expect(d).toEqual({ kind: "retire", sessionId: "sX", prNumber: 7 });
  });

  test("full-auto session is left for the merge train; non-full-auto retires", () => {
    const readyGit = { state: "open", checks: "success", mergeable: true, number: 5, headSha: "h" };
    // A ready full-auto session must NOT be retired (the merge train lands it).
    const fa = autoSession({ status: "idle", git: readyGit as any, fullAuto: true });
    expect(computeNext(state({ autoSessions: [fa] })).kind).toBe("hold");
    // The SAME ready PR, but not effectively full-auto (e.g. autopilot off, or per-session
    // automerge override=false) MUST still retire — otherwise it sits un-retired-and-un-merged
    // holding a maxAuto slot and deadlocks the drain.
    const notFa = autoSession({ status: "idle", git: readyGit as any, fullAuto: false });
    expect(computeNext(state({ autoSessions: [notFa] }))).toEqual({
      kind: "retire",
      sessionId: "s1",
      prNumber: 5,
    });
  });
});

// MERGEABLE.headSha === "abc"; a critic-clean view matches reviewHeadSha to it.
describe("computeNext — draftMode sign-off gate", () => {
  test("born-ready race: draft repo, human authority, isDraft FALSE but unsigned → no retire", () => {
    const d = computeNext(
      state({
        draftMode: true,
        signoffAuthority: "human",
        autoSessions: [
          autoSession({
            id: "sX",
            git: { ...MERGEABLE, isDraft: false }, // born ready (briefly flipped to ready)
            humanApproved: false,
          }),
        ],
      }),
    );
    expect(d.kind).not.toBe("retire");
  });

  test("born-ready race AT CAP → hold awaiting_signoff (not cap)", () => {
    const d = computeNext(
      state({
        draftMode: true,
        signoffAuthority: "human",
        maxAuto: 1,
        autoSessions: [
          autoSession({
            id: "sX",
            desig: "TASK-42",
            git: { ...MERGEABLE, isDraft: false },
            humanApproved: false,
          }),
        ],
        candidates: [issue(2)],
      }),
    );
    expect(d).toEqual({ kind: "hold", reason: { code: "awaiting_signoff", detail: "TASK-42" } });
  });

  test("draft repo + humanApproved → retire", () => {
    const d = computeNext(
      state({
        draftMode: true,
        signoffAuthority: "human",
        autoSessions: [autoSession({ id: "sX", git: MERGEABLE, humanApproved: true })],
      }),
    );
    expect(d).toEqual({ kind: "retire", sessionId: "sX", prNumber: 7 });
  });

  test("human authority + only a clean critic verdict → NO retire (authority mismatch)", () => {
    const d = computeNext(
      state({
        draftMode: true,
        signoffAuthority: "human",
        autoSessions: [
          autoSession({
            id: "sX",
            git: MERGEABLE,
            humanApproved: false,
            reviewDecision: "commented",
            reviewHeadSha: MERGEABLE.headSha,
            findings: [],
          }),
        ],
      }),
    );
    expect(d.kind).not.toBe("retire");
  });

  test("critic authority + same clean critic view → retire", () => {
    const d = computeNext(
      state({
        draftMode: true,
        signoffAuthority: "critic",
        autoSessions: [
          autoSession({
            id: "sX",
            git: MERGEABLE,
            humanApproved: false,
            reviewDecision: "commented",
            reviewHeadSha: MERGEABLE.headSha,
            findings: [],
          }),
        ],
      }),
    );
    expect(d).toEqual({ kind: "retire", sessionId: "sX", prNumber: 7 });
  });

  test("critic authority + commented WITH findings → NO retire (advisory, not sign-off)", () => {
    const d = computeNext(
      state({
        draftMode: true,
        signoffAuthority: "critic",
        autoSessions: [
          autoSession({
            id: "sX",
            git: MERGEABLE,
            reviewDecision: "commented",
            reviewHeadSha: MERGEABLE.headSha,
            findings: ["nit: rename x"],
          }),
        ],
      }),
    );
    expect(d.kind).not.toBe("retire");
  });

  test("cap with all sessions signed → still cap (not awaiting_signoff)", () => {
    const d = computeNext(
      state({
        draftMode: true,
        signoffAuthority: "human",
        maxAuto: 1,
        autoSessions: [autoSession({ id: "sX", git: MERGEABLE, humanApproved: true })],
        candidates: [issue(2)],
      }),
    );
    // The signed session is retired first (priority over cap), so it never reaches the cap gate.
    expect(d.kind).toBe("retire");
  });

  test("cap, one unsigned + one signed (signed retires first)", () => {
    const d = computeNext(
      state({
        draftMode: true,
        signoffAuthority: "human",
        maxAuto: 2,
        autoSessions: [
          autoSession({ id: "unsigned", desig: "TASK-01", git: MERGEABLE, humanApproved: false }),
          autoSession({
            id: "signed",
            issueNumber: 2,
            desig: "TASK-02",
            git: MERGEABLE,
            humanApproved: true,
          }),
        ],
      }),
    );
    // The signed one is retireable → retire wins over the cap/awaiting_signoff relabel.
    expect(d).toEqual({ kind: "retire", sessionId: "signed", prNumber: 7 });
  });

  test("cap, only an unsigned retireable session → awaiting_signoff", () => {
    const d = computeNext(
      state({
        draftMode: true,
        signoffAuthority: "human",
        maxAuto: 1,
        autoSessions: [
          autoSession({ id: "unsigned", desig: "TASK-01", git: MERGEABLE, humanApproved: false }),
        ],
      }),
    );
    expect(d).toEqual({ kind: "hold", reason: { code: "awaiting_signoff", detail: "TASK-01" } });
  });

  test("non-draftMode regression: humanApproved irrelevant, critic-off green retires", () => {
    const d = computeNext(
      state({
        draftMode: false,
        autoSessions: [autoSession({ id: "sX", git: MERGEABLE, humanApproved: false })],
      }),
    );
    expect(d).toEqual({ kind: "retire", sessionId: "sX", prNumber: 7 });
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

  test("claimed (active-labeled) issues are excluded — another instance has them", () => {
    const out = selectCandidates(
      [issue(1), issue(2, [AUTO_LABEL, ACTIVE_LABEL]), issue(3)],
      AUTO_LABEL,
    );
    expect(out.map((i) => i.number)).toEqual([1, 3]);
  });

  test("a claimed priority issue is skipped, ceding it to the claiming instance", () => {
    const out = selectCandidates(
      [issue(5), issue(2, [AUTO_LABEL, PRIORITY_LABEL, ACTIVE_LABEL])],
      AUTO_LABEL,
    );
    expect(out.map((i) => i.number)).toEqual([5]);
  });
});

describe("epic attended gate", () => {
  test("attended + not approved → awaiting_approval(detail=next#)", () => {
    const d = computeNext(
      state({ candidates: [issue(322)], epicAttended: true, epicApprovedNext: false }),
    );
    expect(d).toEqual({ kind: "hold", reason: { code: "awaiting_approval", detail: "322" } });
  });
  test("attended + approved → spawn", () => {
    const d = computeNext(
      state({ candidates: [issue(322)], epicAttended: true, epicApprovedNext: true }),
    );
    expect(d).toEqual({ kind: "spawn", issue: expect.objectContaining({ number: 322 }) });
  });
  test("label mode (epicAttended false) unaffected → spawn", () => {
    expect(computeNext(state({ candidates: [issue(322)] })).kind).toBe("spawn");
  });
});

// ── #1757: epic_base_unavailable hold ───────────────────────────────────────────────────────────

describe("computeNext: epic_base_unavailable (#1757)", () => {
  test("epic run + a fresh epic-base failure → hold, naming the branch", () => {
    const d = computeNext(
      state({
        candidates: [issue(1)],
        epicIntegrationBranch: "epic/9-thing",
        epicBaseUnavailable: "epic/9-thing",
      }),
    );
    expect(d).toEqual({
      kind: "hold",
      reason: { code: "epic_base_unavailable", detail: "epic/9-thing" },
    });
  });

  test("NOT in epic mode → never fires (label-drain must be unaffected)", () => {
    // Gated on an active epic run: a label-mode drain has no integration branch, so even a stray
    // marker must not pause it. (It also cannot be set there — only an epic spawn can produce it.)
    const d = computeNext(state({ candidates: [issue(1)], epicBaseUnavailable: "epic/9-thing" }));
    expect(d.kind).toBe("spawn");
  });

  test("no fresh failure → spawns normally", () => {
    const d = computeNext(
      state({
        candidates: [issue(1)],
        epicIntegrationBranch: "epic/9-thing",
        epicBaseUnavailable: null,
      }),
    );
    expect(d.kind).toBe("spawn");
  });

  test("a retireable PR still retires while the epic base is unavailable", () => {
    // The hold sits AFTER the retire gate: work already in flight must still land. Only NEW spawns
    // pause (every sibling would fail to base identically).
    const d = computeNext(
      state({
        autoSessions: [autoSession({ id: "ok", issueNumber: 2, git: MERGEABLE })],
        candidates: [issue(1)],
        epicIntegrationBranch: "epic/9-thing",
        epicBaseUnavailable: "epic/9-thing",
      }),
    );
    expect(d.kind).toBe("retire");
  });
});
