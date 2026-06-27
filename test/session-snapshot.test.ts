import { test, expect } from "bun:test";
import { buildSnapshot } from "../src/session-snapshot";
import type { Session } from "../src/types";
import type { GitState } from "../src/forge/types";

// ── fixtures ──────────────────────────────────────────────────────────────────

function makeSession(id: string, repoPath: string): Session {
  return { id, repoPath } as unknown as Session;
}

function makeAcc(session: Session | null) {
  return { getSession: () => session };
}

const GIT_STATE: GitState = {
  kind: "github",
  state: "open",
  checks: "success",
  deployConfigured: false,
};

// ── buildSnapshot: status payload ─────────────────────────────────────────────

test("buildSnapshot with status payload returns kind=status with snapshot", () => {
  const session = makeSession("sess-1", "/repos/alpha");
  const acc = makeAcc(session);
  const result = buildSnapshot(acc, "sess-1", { kind: "status", status: "idle" });
  if (!result) throw new Error("expected non-null result");
  expect(result.kind).toBe("status");
  if (result.kind !== "status") throw new Error("unreachable");
  expect(result.status).toBe("idle");
  expect(result.snapshot.id).toBe("sess-1");
  expect(result.snapshot.repoPath).toBe("/repos/alpha");
  expect(result.snapshot.session).toBe(session);
});

// ── buildSnapshot: git payload ────────────────────────────────────────────────

test("buildSnapshot with git payload returns kind=git with snapshot", () => {
  const session = makeSession("sess-2", "/repos/beta");
  const acc = makeAcc(session);
  const result = buildSnapshot(acc, "sess-2", { kind: "git", git: GIT_STATE });
  if (!result) throw new Error("expected non-null result");
  expect(result.kind).toBe("git");
  if (result.kind !== "git") throw new Error("unreachable");
  expect(result.git).toBe(GIT_STATE);
  expect(result.snapshot.id).toBe("sess-2");
  expect(result.snapshot.repoPath).toBe("/repos/beta");
  expect(result.snapshot.session).toBe(session);
});

// ── buildSnapshot: null when session unknown ──────────────────────────────────

test("buildSnapshot returns null when getSession returns null", () => {
  const acc = makeAcc(null);
  const result = buildSnapshot(acc, "missing", { kind: "status", status: "running" });
  expect(result).toBeNull();
});

// ── buildSnapshot: repoPath comes from session, not id ───────────────────────

test("snapshot repoPath is sourced from session row, not echoed from id", () => {
  // id and repoPath are intentionally different so echoing id would be detected
  const session = makeSession("task-99", "/home/user/projects/my-project");
  const acc = makeAcc(session);
  const result = buildSnapshot(acc, "task-99", { kind: "status", status: "done" });
  if (!result) throw new Error("expected non-null result");
  expect(result.snapshot.repoPath).toBe("/home/user/projects/my-project");
  expect(result.snapshot.repoPath).not.toBe("task-99");
});
