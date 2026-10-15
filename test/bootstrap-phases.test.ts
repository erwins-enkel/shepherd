import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  advanceAfterEpicApproved,
  bootstrapNextStep,
  buildRepoBootstrapView,
  reconcileBootstrapPhases,
} from "../src/bootstrap-phases";
import type { RepoBootstrap } from "../src/bootstrap";
import { SessionStore } from "../src/store";

const active = (phase: number): RepoBootstrap => ({ state: "active", phase, overrideAt: null });

const base = {
  name: "b",
  prompt: "p",
  repoPath: "/r",
  baseBranch: "main",
  branch: "b",
  worktreePath: "/w",
  isolated: true,
  herdrSession: "default",
};

let agent = 0;
const create = (s: SessionStore, extra: Record<string, unknown> = {}) =>
  s.create({ ...base, herdrAgentId: `a${++agent}`, ...extra });

const db = (s: SessionStore) => (s as unknown as { db: Database }).db;

function approveEpic(s: SessionStore, repoPath = "/r") {
  const e = create(s, { repoPath, epicAuthoring: true });
  s.replaceEpicDraft(e.id, {
    parent: { title: "t", body: "b", acceptanceCriteria: [], nonGoals: [] },
    children: [],
  });
  s.setEpicDraftApproved(e.id, 9, "u");
  return e;
}

describe("bootstrapNextStep", () => {
  test("off and done propose nothing", () => {
    expect(bootstrapNextStep({ state: "off", phase: 1, overrideAt: null }, [])).toBeNull();
    expect(bootstrapNextStep({ state: "done", phase: 5, overrideAt: null }, [])).toBeNull();
  });

  test("each phase proposes its step", () => {
    expect(bootstrapNextStep(active(1), [])).toEqual({
      kind: "bootstrap",
      phase: 1,
      sessionId: null,
    });
    expect(bootstrapNextStep(active(2), [])?.kind).toBe("bootstrap");
    expect(bootstrapNextStep(active(3), [])?.kind).toBe("bootstrap");
    expect(bootstrapNextStep(active(4), [])?.kind).toBe("epic");
    expect(bootstrapNextStep(active(5), [])?.kind).toBe("readiness");
  });

  test("a live session already on the step is named, others are not", () => {
    const live = [
      { id: "p1", bootstrapPhase: 1 as const, epicAuthoring: false },
      { id: "ep", bootstrapPhase: null, epicAuthoring: true },
    ];
    expect(bootstrapNextStep(active(1), live)?.sessionId).toBe("p1");
    expect(bootstrapNextStep(active(3), live)?.sessionId).toBeNull();
    expect(bootstrapNextStep(active(4), live)?.sessionId).toBe("ep");
    expect(bootstrapNextStep(active(5), live)?.sessionId).toBeNull();
  });
});

describe("buildRepoBootstrapView", () => {
  test("carries the next step from the repo's live sessions", async () => {
    const s = new SessionStore(":memory:");
    s.setRepoBootstrap("/r", { state: "active", phase: 3 });
    const p3 = create(s, { bootstrapPhase: 3 });
    create(s, { repoPath: "/other", bootstrapPhase: 3 });
    const v = await buildRepoBootstrapView(s, "/r", ["ci"]);
    expect(v.missing).toEqual(["P3", "P4", "ci"]);
    expect(v.next).toEqual({ kind: "bootstrap", phase: 3, sessionId: p3.id });
    s.archive(p3.id, "operator");
    expect((await buildRepoBootstrapView(s, "/r", [])).next?.sessionId).toBeNull();
  });
});

describe("advanceAfterEpicApproved", () => {
  test("moves only an active P4 repo to P5", () => {
    const s = new SessionStore(":memory:");
    expect(advanceAfterEpicApproved(s, "/r")).toBe(false);
    s.setRepoBootstrap("/r", { state: "active", phase: 3 });
    expect(advanceAfterEpicApproved(s, "/r")).toBe(false);
    expect(s.getRepoBootstrap("/r").phase).toBe(3);
    s.setRepoBootstrap("/r", { state: "active", phase: 4 });
    expect(advanceAfterEpicApproved(s, "/r")).toBe(true);
    expect(s.getRepoBootstrap("/r")).toMatchObject({ state: "active", phase: 5 });
  });
});

describe("reconcileBootstrapPhases", () => {
  test("merged P1 → 3, merged P3 → 4, approved epic → 5", () => {
    const s = new SessionStore(":memory:");
    s.setRepoBootstrap("/r", { state: "active", phase: 1 });
    s.archive(create(s, { bootstrapPhase: 1 }).id, "merged");
    expect(reconcileBootstrapPhases(s)).toEqual([{ repoPath: "/r", from: 1, to: 3 }]);
    expect(reconcileBootstrapPhases(s)).toEqual([]);
    s.archive(create(s, { bootstrapPhase: 3 }).id, "merged");
    expect(reconcileBootstrapPhases(s)).toEqual([{ repoPath: "/r", from: 3, to: 4 }]);
    approveEpic(s);
    expect(reconcileBootstrapPhases(s)).toEqual([{ repoPath: "/r", from: 4, to: 5 }]);
    expect(s.getRepoBootstrap("/r").phase).toBe(5);
  });

  test("chains every missed advance in one pass", () => {
    const s = new SessionStore(":memory:");
    s.setRepoBootstrap("/r", { state: "active", phase: 1 });
    s.archive(create(s, { bootstrapPhase: 1 }).id, "merged");
    s.archive(create(s, { bootstrapPhase: 3 }).id, "merged");
    approveEpic(s);
    expect(reconcileBootstrapPhases(s)).toEqual([{ repoPath: "/r", from: 1, to: 5 }]);
  });

  test("ignores facts older than the phase start, unmerged sessions, other repos", () => {
    const s = new SessionStore(":memory:");
    s.archive(create(s, { bootstrapPhase: 1 }).id, "merged"); // an older run
    s.archive(create(s, { bootstrapPhase: 1 }).id, "operator");
    create(s, { bootstrapPhase: 1 });
    s.archive(create(s, { repoPath: "/x", bootstrapPhase: 1 }).id, "merged");
    db(s).run(`UPDATE sessions SET archivedAt = 1`);
    s.setRepoBootstrap("/r", { state: "active", phase: 1 });
    expect(reconcileBootstrapPhases(s)).toEqual([]);
  });

  test("never moves backwards; off/done repos are untouched", () => {
    const s = new SessionStore(":memory:");
    s.setRepoBootstrap("/r", { state: "active", phase: 4 });
    s.archive(create(s, { bootstrapPhase: 1 }).id, "merged");
    expect(reconcileBootstrapPhases(s)).toEqual([]);
    expect(s.getRepoBootstrap("/r").phase).toBe(4);
    s.setRepoBootstrap("/d", { state: "done", phase: 5 });
    expect(reconcileBootstrapPhases(s)).toEqual([]);
  });

  test("restart: an advance lost before the crash heals on the next boot", () => {
    const dir = mkdtempSync(join(tmpdir(), "bs-phases-"));
    try {
      const file = join(dir, "s.db");
      const before = new SessionStore(file);
      before.setRepoBootstrap("/r", { state: "active", phase: 3 });
      // The P3 PR merged and the session archived — then the process died before the phase write.
      before.archive(create(before, { bootstrapPhase: 3 }).id, "merged");
      db(before).close();
      const after = new SessionStore(file);
      expect(after.getRepoBootstrap("/r").phase).toBe(3);
      expect(reconcileBootstrapPhases(after)).toEqual([{ repoPath: "/r", from: 3, to: 4 }]);
      expect(after.getRepoBootstrap("/r")).toMatchObject({ state: "active", phase: 4 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
