// #2735: an auto epic child whose PR is retire-ready while the repo drain is not acting holds as
// epic-run-stopped — nothing integrates it until the run starts.
import { describe, expect, it } from "bun:test";
import { HoldReasonService } from "../src/hold-service";
import { renderHold } from "../src/hold";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import type { GitState } from "../src/forge/types";

type Run = { status: "idle" | "running" | "paused"; parentIssueNumber: number } | null;

const readyGit = (over: Partial<GitState> = {}): GitState =>
  ({
    kind: "github",
    state: "open",
    checks: "success",
    mergeable: true,
    number: 68,
    headSha: "h1",
    deployConfigured: false,
    ...over,
  }) as GitState;

function harness(opts: { auto?: boolean; epic?: boolean; run?: Run; autoDrain?: boolean } = {}) {
  const store = new SessionStore(":memory:");
  const events = new EventHub();
  const epic = opts.epic ?? true;
  const s = store.create({
    name: "child",
    prompt: "x",
    repoPath: "/repo",
    baseBranch: epic ? "epic/67-x" : "main",
    branch: "shepherd/child",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_child",
    auto: opts.auto ?? true,
  });
  const state = { run: opts.run ?? null, autoDrain: opts.autoDrain ?? false, git: readyGit() };
  const svc = new HoldReasonService({
    store,
    events,
    gitSnapshot: () => ({ [s.id]: state.git }),
    reviewSnapshot: () => ({}),
    gateSnapshot: () => ({}),
    recapSnapshot: () => ({}),
    epicRetire: {
      getRepoConfig: () => ({
        autoDrainEnabled: state.autoDrain,
        criticEnabled: false,
        draftMode: false,
        signoffAuthority: "human",
      }),
      getEpicRun: () => state.run,
      getEpicIntegrationBranch: () => "epic/67-x",
    },
    onChange: () => {},
  });
  return { id: s.id, events, svc, state };
}

describe("HoldReasonService — epic-run-stopped", () => {
  it("holds a ready auto child while nothing leads and label-drain is off", () => {
    const { id, svc } = harness();
    expect(svc.snapshot()[id]).toEqual({ code: "epic-run-stopped", params: { epic: 67, pr: 68 } });
  });

  it("names a paused leader", () => {
    const { id, svc } = harness({ run: { status: "paused", parentIssueNumber: 80 } });
    expect(svc.snapshot()[id]?.params).toEqual({ epic: 67, pr: 68, leadEpic: 80 });
  });

  it("clears on epic:update once the run is running", () => {
    const { id, events, svc, state } = harness({
      run: { status: "paused", parentIssueNumber: 67 },
    });
    expect(svc.snapshot()[id]?.code).toBe("epic-run-stopped");
    state.run = { status: "running", parentIssueNumber: 67 };
    events.emit("epic:update", { repoPath: "/repo", parentIssueNumber: 67 });
    expect(svc.snapshot()[id]).toBeUndefined();
  });

  it("clears when the PR stops being retire-ready", () => {
    const { id, events, svc, state } = harness();
    state.git = readyGit({ checks: "pending" });
    events.emit("session:git", { id });
    expect(svc.snapshot()[id]).toBeUndefined();
  });

  it("never holds while the drain acts, nor for manual or non-epic sessions", () => {
    const none = (o: Parameters<typeof harness>[0]) => {
      const h = harness(o);
      return h.svc.snapshot()[h.id];
    };
    expect(none({ autoDrain: true })).toBeUndefined();
    expect(none({ run: { status: "running", parentIssueNumber: 80 } })).toBeUndefined();
    expect(none({ auto: false })).toBeUndefined();
    expect(none({ epic: false })).toBeUndefined();
  });
});

describe("epic-run-stopped copy", () => {
  it("names the epic and PR, and the paused leader when one leads, in EN + DE", () => {
    const own = { code: "epic-run-stopped" as const, params: { epic: 67, pr: 68 } };
    expect(renderHold(own, "en")).toBe(
      "Waiting on epic run #67 — PR #68 is ready, but the run is stopped.",
    );
    expect(renderHold(own, "de")).toBe(
      "Wartet auf Epic-Lauf #67 — PR #68 ist bereit, aber der Lauf ist gestoppt.",
    );
    const led = { code: "epic-run-stopped" as const, params: { epic: 67, pr: 68, leadEpic: 80 } };
    expect(renderHold(led, "en")).toContain("epic #80 is paused");
    expect(renderHold(led, "de")).toContain("Epic #80 ist pausiert");
  });
});
