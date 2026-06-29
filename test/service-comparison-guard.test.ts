import { expect, test } from "bun:test";
import { SessionService } from "../src/service";
import type { Session } from "../src/types";

// Minimal member row for the startComparison guard (only the fields it inspects).
function member(over: Partial<Session>): Session {
  return {
    id: "x",
    repoPath: "/r",
    baseBranch: "main",
    status: "idle",
    experimentRole: "variant",
    ...over,
  } as unknown as Session;
}

// SessionService whose store only answers variantsForExperiment — the guard short-circuits
// before any spawn, so the other deps are never touched.
function svcWithMembers(members: Session[]) {
  return new SessionService({
    store: { variantsForExperiment: () => members } as never,
    namer: (async () => "x") as never,
    worktree: {} as never,
    herdr: {} as never,
    events: { emit: () => {} } as never,
  });
}

test("startComparison rejects when an ACTIVE comparison already exists (no orphan spawn)", async () => {
  const svc = svcWithMembers([
    member({ id: "a", experimentRole: "variant" }),
    member({ id: "b", experimentRole: "variant" }),
    member({ id: "c", experimentRole: "comparison", status: "idle" }),
  ]);
  await expect(svc.startComparison("exp-1", { model: null })).rejects.toThrow(
    /already has a comparison/,
  );
});

test("startComparison ignores an ARCHIVED comparison (a fresh one is allowed)", async () => {
  // 2 variants + an archived comparison → the guard passes; the spawn then fails on the empty
  // worktree stub, which is fine — we only assert it got PAST the duplicate-comparison guard.
  const svc = svcWithMembers([
    member({ id: "a", experimentRole: "variant" }),
    member({ id: "b", experimentRole: "variant" }),
    member({ id: "c", experimentRole: "comparison", status: "archived" }),
  ]);
  await expect(svc.startComparison("exp-1", { model: null })).rejects.not.toThrow(
    /already has a comparison/,
  );
});

test("startComparison still requires at least two variants", async () => {
  const svc = svcWithMembers([member({ id: "a", experimentRole: "variant" })]);
  await expect(svc.startComparison("exp-1", { model: null })).rejects.toThrow(
    /at least 2 variants/,
  );
});
