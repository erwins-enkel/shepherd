import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { annotateHandoff, computeHandoff, parseRoles, normalizeLogin } from "../src/repo-roles";
import type { GitForge, GitState, PrStatus } from "../src/forge/types";
import { makeApp, type AppDeps } from "../src/server";
import { config } from "../src/config";

const approved: PrStatus["latestReview"] = { state: "approved", author: "scoop", submittedAt: 1 };

const gitState = (over: Partial<GitState> = {}): GitState =>
  ({ kind: "github", state: "open", checks: "none", deployConfigured: false, ...over }) as GitState;

test("annotateHandoff stamps noCi=true for a GitHub repo with no workflows", () => {
  const g = annotateHandoff(gitState(), "/no/such/repo", "kai");
  expect(g.noCi).toBe(true);
});

test("annotateHandoff stamps noCi=false for a non-GitHub forge", () => {
  const g = annotateHandoff(gitState({ kind: "gitea" }), "/no/such/repo", "kai");
  expect(g.noCi).toBe(false);
});

test("merger = self → self (today's 'your turn')", () => {
  const r = computeHandoff({ reviewer: null, merger: "kai" }, "kai", undefined);
  expect(r.handoff).toBe("self");
  expect(r.handoffWho).toBeNull();
});

test("merger = someone else → waiting on the merger", () => {
  const r = computeHandoff({ reviewer: null, merger: "scoop" }, "kai", undefined);
  expect(r.handoff).toBe("merger");
  expect(r.handoffWho).toBe("scoop");
});

test("foreign reviewer with no approval → waiting on the reviewer", () => {
  const r = computeHandoff({ reviewer: "scoop", merger: "scoop" }, "kai", undefined);
  expect(r.handoff).toBe("reviewer");
  expect(r.handoffWho).toBe("scoop");
});

test("foreign reviewer requested changes → self handoff, not passive waiting", () => {
  const r = computeHandoff({ reviewer: "scoop", merger: "scoop" }, "kai", undefined, [], {
    reviewer: "scoop",
    state: "changes_requested",
    latestAt: 1,
  });
  expect(r.handoff).toBe("self");
  expect(r.handoffWho).toBeNull();
});

test("foreign reviewer once approved falls through to the merger", () => {
  const r = computeHandoff({ reviewer: "scoop", merger: "scoop" }, "kai", approved);
  expect(r.handoff).toBe("merger");
  expect(r.handoffWho).toBe("scoop");
});

test("any human approve satisfies the reviewer step (human-in-the-loop)", () => {
  // approval by someone other than the configured reviewer still counts
  const byOther: PrStatus["latestReview"] = { state: "approved", author: "alice", submittedAt: 2 };
  const r = computeHandoff({ reviewer: "scoop", merger: "kai" }, "kai", byOther);
  expect(r.handoff).toBe("self");
});

test("login comparison is case-insensitive — own login in any casing is still self", () => {
  // GitHub logins are case-insensitive; a free-text "Kai" must match operator "kai".
  expect(computeHandoff({ reviewer: null, merger: "Kai" }, "kai", undefined).handoff).toBe("self");
  expect(computeHandoff({ reviewer: "KAI", merger: null }, "kai", undefined).handoff).toBe("self");
});

test("no roles → self", () => {
  expect(computeHandoff({ reviewer: null, merger: null }, "kai", undefined).handoff).toBe("self");
});

test("unknown me is defensive: a configured role still counts as 'other'", () => {
  const r = computeHandoff({ reviewer: null, merger: "scoop" }, null, undefined);
  expect(r.handoff).toBe("merger");
});

// ── inference path (no roles.json → infer a merger from the PR) ──────────────

const unconfigured = { reviewer: null, merger: null };

test("unconfigured + foreign pending requested reviewer → infer merger (#539 repro)", () => {
  // green PR, not yet approved, one foreign reviewer requested → "waiting on scoop",
  // NOT "your turn".
  const r = computeHandoff(unconfigured, "kai", undefined, ["scoop"]);
  expect(r.handoff).toBe("merger");
  expect(r.handoffWho).toBe("scoop");
  expect(r.inferred).toBe(true);
});

test("unconfigured + foreign approval, no pending request → infer merger = approver", () => {
  const r = computeHandoff(unconfigured, "kai", approved, []);
  expect(r.handoff).toBe("merger");
  expect(r.handoffWho).toBe("scoop"); // `approved` is authored by scoop
  expect(r.inferred).toBe(true);
});

test("unconfigured + multiple foreign requested reviewers → case-insensitively lowest", () => {
  const r = computeHandoff(unconfigured, "kai", undefined, ["Zed", "alice", "Bob"]);
  expect(r.handoff).toBe("merger");
  expect(r.handoffWho).toBe("alice"); // lowest folded, original casing returned
  expect(r.inferred).toBe(true);
});

test("unconfigured + requested reviewer == me (case-folded) → ignored → self", () => {
  const r = computeHandoff(unconfigured, "kai", undefined, ["KAI"]);
  expect(r.handoff).toBe("self");
  expect(r.handoffWho).toBeNull();
  expect(r.inferred).toBe(false);
});

test("unconfigured + no requested reviewer + no foreign approval → self", () => {
  expect(computeHandoff(unconfigured, "kai", undefined, []).handoff).toBe("self");
  expect(computeHandoff(unconfigured, "kai", undefined).handoff).toBe("self"); // default []
});

test("configured roles present → inference inert, inferred:false", () => {
  // requestedReviewers are present but ignored because roles are explicitly set.
  const r = computeHandoff({ reviewer: null, merger: "scoop" }, "kai", undefined, ["alice"]);
  expect(r.handoff).toBe("merger");
  expect(r.handoffWho).toBe("scoop"); // configured merger, not the requested reviewer
  expect(r.inferred).toBe(false);
});

test("parseRoles: valid, partial, empty, and garbage", () => {
  expect(parseRoles('{"reviewer":"scoop","merger":"scoop"}')).toEqual({
    reviewer: "scoop",
    merger: "scoop",
  });
  expect(parseRoles('{"merger":"@scoop"}')).toEqual({ reviewer: null, merger: "scoop" });
  expect(parseRoles("{}")).toEqual({ reviewer: null, merger: null });
  expect(() => parseRoles("not json")).toThrow();
});

test("normalizeLogin trims, drops a leading @, empties to null", () => {
  expect(normalizeLogin("  @scoop ")).toBe("scoop");
  expect(normalizeLogin("")).toBeNull();
  expect(normalizeLogin(42)).toBeNull();
});

function repoWithRoles(roles: { reviewer: string | null; merger: string | null }): string {
  const dir = mkdtempSync(join(config.repoRoot, "shepherd-roles-git-"));
  execFileSync("git", ["-C", dir, "init", "-b", "main"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"], {
    stdio: "ignore",
  });
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"], { stdio: "ignore" });
  mkdirSync(join(dir, ".shepherd"));
  writeFileSync(join(dir, ".shepherd", "roles.json"), `${JSON.stringify(roles)}\n`);
  execFileSync("git", ["-C", dir, "add", ".shepherd/roles.json"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "commit", "-m", "roles"], { stdio: "ignore" });
  return dir;
}

test("annotateHandoff stamps reviewBlock only for the configured reviewer", () => {
  const dir = repoWithRoles({ reviewer: "scoop", merger: "scoop" });
  try {
    const g = annotateHandoff(
      gitState({
        checks: "success",
        reviewerStates: {
          scoop: { state: "changes_requested", latestAt: 1 },
          alice: { state: "changes_requested", latestAt: 2 },
        },
      }),
      dir,
      "kai",
    );
    expect(g.reviewBlock).toEqual({ reviewer: "scoop", state: "changes_requested", latestAt: 1 });
    expect(g.handoff).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("annotateHandoff preserves previous reviewerStates when a fallback payload has none", () => {
  const dir = repoWithRoles({ reviewer: "scoop", merger: "scoop" });
  try {
    const prev = gitState({
      number: 7,
      checks: "success",
      reviewerStates: { scoop: { state: "changes_requested", latestAt: 1 } },
      reviewBlock: { reviewer: "scoop", state: "changes_requested", latestAt: 1 },
    });
    const g = annotateHandoff(gitState({ number: 7, checks: "success" }), dir, "kai", prev);
    expect(g.reviewerStates).toEqual(prev.reviewerStates);
    expect(g.reviewBlock).toEqual(prev.reviewBlock);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("annotateHandoff clears previous reviewBlock when a fresh empty replay arrives", () => {
  const dir = repoWithRoles({ reviewer: "scoop", merger: "scoop" });
  try {
    const prev = gitState({
      number: 7,
      checks: "success",
      reviewerStates: { scoop: { state: "changes_requested", latestAt: 1 } },
      reviewBlock: { reviewer: "scoop", state: "changes_requested", latestAt: 1 },
    });
    const g = annotateHandoff(
      gitState({ number: 7, checks: "success", reviewerStates: {} }),
      dir,
      "kai",
      prev,
    );
    expect(g.reviewBlock).toBeUndefined();
    expect(g.handoff).toBe("reviewer");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PUT /api/repo-roles: push failure → 502 generic pushError, raw error not leaked (CodeQL #14)", async () => {
  const dir = mkdtempSync(join(config.repoRoot, "shepherd-roles-test-"));
  try {
    const forge = {
      currentUser: async () => "me",
      // The push fails with a message that carries a sensitive-looking internal detail.
      defaultBranch: async () => {
        throw new Error("remote rejected: protected branch at git@secret-host:22");
      },
    } as unknown as GitForge;
    const deps: AppDeps = {
      store: {} as never,
      service: {} as never,
      events: { emit: () => {} } as never,
      usageLimits: { limits: () => ({}) } as never,
      resolveForge: () => forge,
    };
    const app = makeApp(deps);
    const res = await app.fetch(
      new Request(`http://x/api/repo-roles?repo=${encodeURIComponent(dir)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reviewer: "alice" }),
      }),
    );
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.pushError).toBe("push rejected");
    // Raw error/stack text must never reach the client.
    expect(JSON.stringify(body)).not.toContain("secret-host");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
