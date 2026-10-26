import { afterEach, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  annotateHandoff,
  computeHandoff,
  parseRoles,
  normalizeLogin,
  readPendingRoles,
  ROLES_PR_BRANCH,
  saveRepoRoles,
  writeRepoRoles,
} from "../src/repo-roles";
import type { GitForge, GitState, OpenPrInput, PrStatus } from "../src/forge/types";
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

test("configured fork keeps explicit role semantics", () => {
  const r = computeHandoff(
    { reviewer: "scoop", merger: "scoop" },
    "kai",
    undefined,
    ["alice"],
    undefined,
    { isFork: true },
  );
  expect(r).toEqual({ handoff: "reviewer", handoffWho: "scoop", inferred: false });
});

// ── fork inference (unconfigured recognized fork) ────────────────────────────

test("unconfigured fork + pending foreign reviewer → inferred reviewer handoff", () => {
  const r = computeHandoff(unconfigured, "kai", undefined, ["Zed", "alice", "KAI"], undefined, {
    isFork: true,
  });
  expect(r).toEqual({ handoff: "reviewer", handoffWho: "alice", inferred: true });
});

test("unconfigured fork + approval and no pending reviewer → anonymous maintainer merge", () => {
  const r = computeHandoff(unconfigured, "kai", approved, [], undefined, { isFork: true });
  expect(r).toEqual({ handoff: "merger", handoffWho: null, inferred: true });
});

test("unconfigured fork + dismissed approval → anonymous maintainer review", () => {
  const r = computeHandoff(unconfigured, "kai", approved, [], undefined, {
    isFork: true,
    reviewerStates: {},
  });
  expect(r).toEqual({ handoff: "reviewer", handoffWho: null, inferred: true });
});

test("unconfigured fork + no approval or pending reviewer → anonymous maintainer review", () => {
  const r = computeHandoff(unconfigured, "kai", undefined, [], undefined, { isFork: true });
  expect(r).toEqual({ handoff: "reviewer", handoffWho: null, inferred: true });
});

test("unconfigured fork + active changes request → inferred self handoff", () => {
  const r = computeHandoff(
    unconfigured,
    "kai",
    approved,
    [],
    {
      reviewer: "alice",
      state: "changes_requested",
      latestAt: 2,
    },
    { isFork: true },
  );
  expect(r).toEqual({ handoff: "self", handoffWho: null, inferred: true });
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

// Fixture repos live in tmpdir(), never config.repoRoot: Shepherd lists every dir there as a repo,
// and a forgotten cleanup once left 448 of these behind in the operator's real root (#2683).
// annotateHandoff/readRepoRoles only need a git dir. afterEach drops every one, so no test can
// forget to.
const fixtureRepos: string[] = [];
afterEach(() => {
  for (const dir of fixtureRepos.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repoWithRoles(roles: { reviewer: string | null; merger: string | null }): string {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-roles-git-"));
  fixtureRepos.push(dir);
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
});

test("annotateHandoff preserves previous reviewerStates when a fallback payload has none", () => {
  const dir = repoWithRoles({ reviewer: "scoop", merger: "scoop" });
  const prev = gitState({
    number: 7,
    checks: "success",
    reviewerStates: { scoop: { state: "changes_requested", latestAt: 1 } },
    reviewBlock: { reviewer: "scoop", state: "changes_requested", latestAt: 1 },
  });
  const g = annotateHandoff(gitState({ number: 7, checks: "success" }), dir, "kai", prev);
  expect(g.reviewerStates).toEqual(prev.reviewerStates);
  expect(g.reviewBlock).toEqual(prev.reviewBlock);
});

test("annotateHandoff clears previous reviewBlock when a fresh empty replay arrives", () => {
  const dir = repoWithRoles({ reviewer: "scoop", merger: "scoop" });
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
});

test("annotateHandoff gives an unconfigured fork's active human changes request to self", () => {
  const dir = repoWithRoles(unconfigured);
  const g = annotateHandoff(
    gitState({
      number: 7,
      checks: "success",
      isFork: true,
      latestReview: approved,
      requestedReviewers: ["zed"],
      reviewerStates: {
        scoop: { state: "approved", latestAt: 1 },
        alice: { state: "changes_requested", latestAt: 2 },
      },
    }),
    dir,
    "kai",
  );
  expect(g.reviewBlock).toEqual({
    reviewer: "alice",
    state: "changes_requested",
    latestAt: 2,
  });
  expect(g.handoff).toBeUndefined();
  expect(g.handoffInferred).toBe(true);
});

test("annotateHandoff does not attach fork handoffs to drafts or non-green PRs", () => {
  const dir = repoWithRoles(unconfigured);
  for (const state of [
    gitState({ checks: "success", isDraft: true, isFork: true }),
    gitState({ checks: "pending", isFork: true }),
    gitState({ checks: "failure", isFork: true }),
    gitState({ state: "closed", checks: "success", isFork: true }),
  ]) {
    const g = annotateHandoff(state, dir, "kai");
    expect(g.handoff).toBeUndefined();
    expect(g.handoffWho).toBeUndefined();
    expect(g.handoffInferred).toBeUndefined();
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

// ── merge-gate stamp (#2299) ────────────────────────────────────────────────────────────────
//
// `handoff` is the herd's "waiting on" readout: open + CI-cleared only, and inferred from the
// PR's reviewers where no roles are configured. `mergeGate` is what the merge confirmation states
// and echoes back to the gate that validates it, so it must follow the GATE's rules instead.

test("mergeGate names the responsible merger even while CI has not cleared", () => {
  const dir = repoWithRoles({ reviewer: null, merger: "scoop" });
  // checks "pending" on a GitHub repo WITH workflows never clears, so no handoff is stamped…
  const g = annotateHandoff(gitState({ number: 7, checks: "pending" }), dir, "kai");
  expect(g.handoff).toBeUndefined();
  // …but the merge is still offered, so the confirmation must still name @scoop.
  expect(g.mergeGate).toEqual({ handoff: "merger", handoffWho: "scoop" });
});

test("mergeGate is stamped on a non-GitHub host, where checks never clear at all", () => {
  const dir = repoWithRoles({ reviewer: null, merger: "scoop" });
  const g = annotateHandoff(gitState({ kind: "gitea", number: 7 }), dir, "kai");
  expect(g.handoff).toBeUndefined();
  expect(g.mergeGate).toEqual({ handoff: "merger", handoffWho: "scoop" });
});

test("mergeGate is absent when the operator holds the roles themselves", () => {
  const dir = repoWithRoles({ reviewer: null, merger: "kai" });
  expect(annotateHandoff(gitState({ number: 7 }), dir, "kai").mergeGate).toBeUndefined();
});

test("mergeGate is absent on a repo that configures no roles, however the handoff is inferred", () => {
  const g = annotateHandoff(
    gitState({ number: 7, checks: "success", requestedReviewers: ["scoop"] }),
    "/no/such/repo",
    "kai",
  );
  expect(g.handoff).toBe("merger"); // inferred readout stays
  expect(g.handoffInferred).toBe(true);
  expect(g.mergeGate).toBeUndefined(); // …but nothing is taken over
});

test("mergeGate reports the reviewer's open changes where the readout says 'your turn'", () => {
  const dir = repoWithRoles({ reviewer: "scoop", merger: null });
  const g = annotateHandoff(
    gitState({
      number: 7,
      checks: "success",
      reviewerStates: { scoop: { state: "changes_requested", latestAt: 1 } },
    }),
    dir,
    "kai",
  );
  expect(g.handoff).toBeUndefined(); // configuredHandoff collapses a review block to self
  expect(g.mergeGate).toEqual({
    handoff: "reviewer",
    handoffWho: "scoop",
    reviewBlockBy: "scoop",
  });
});

test("mergeGate is cleared when the roles no longer name anyone", () => {
  // annotateHandoff re-annotates ALREADY-annotated states (the roles dialog's re-push, the
  // poller's prev). A responsibility the operator has since cleared must not survive, or every
  // merge entry point keeps offering to "take over" a merge that is now their own.
  const dir = repoWithRoles({ reviewer: null, merger: "scoop" });
  const annotated = annotateHandoff(gitState({ number: 7 }), dir, "kai");
  expect(annotated.mergeGate).toBeDefined();

  const cleared = annotateHandoff(annotated, "/no/such/repo", "kai");
  expect(cleared.mergeGate).toBeUndefined();
});

test("mergeGate is replaced, not merged, when the roles are reassigned", () => {
  const scoopRepo = repoWithRoles({ reviewer: null, merger: "scoop" });
  const danaRepo = repoWithRoles({ reviewer: null, merger: "dana" });
  const annotated = annotateHandoff(gitState({ number: 7 }), scoopRepo, "kai");

  const reassigned = annotateHandoff(annotated, danaRepo, "kai");
  expect(reassigned.mergeGate).toEqual({ handoff: "merger", handoffWho: "dana" });
});

// ── write path: off the event loop, without the checkout's local hooks ─────────────────────
//
// A bare "remote" plus a clone that points at it. Both live in tmpdir() and are dropped by the
// shared afterEach.

function writeHook(dir: string, name: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

function remoteWithClone(parent = tmpdir()): { remote: string; clone: string } {
  const root = mkdtempSync(join(parent, "shepherd-roles-remote-"));
  fixtureRepos.push(root);
  const remote = join(root, "remote.git");
  const clone = join(root, "clone");
  const g = (...args: string[]) => execFileSync("git", args, { stdio: "ignore" });
  g("init", "--bare", "-b", "main", remote);
  g("init", "-b", "main", clone);
  g("-C", clone, "config", "user.email", "test@example.com");
  g("-C", clone, "config", "user.name", "Test");
  g("-C", clone, "remote", "add", "origin", remote);
  g("-C", clone, "commit", "--allow-empty", "-m", "init");
  g("-C", clone, "push", "origin", "main");
  return { remote, clone };
}

const remoteRoles = (remote: string, ref = "main") =>
  parseRoles(
    execFileSync("git", ["-C", remote, "show", `${ref}:.shepherd/roles.json`], {
      encoding: "utf8",
    }),
  );

test("writeRepoRoles pushes past a failing local pre-push hook (it never runs it)", async () => {
  // The hang: the operator's checkout carried a CI-equivalent pre-push gate, and pushing the
  // roles commit ran it. A hook that refuses outright proves the server push skips local hooks.
  const { remote, clone } = remoteWithClone();
  const hooks = join(clone, ".test-hooks");
  writeHook(hooks, "pre-push", "exit 1");
  execFileSync("git", ["-C", clone, "config", "core.hooksPath", hooks], { stdio: "ignore" });

  await writeRepoRoles(clone, { reviewer: "kai", merger: null }, "main");

  expect(remoteRoles(remote)).toEqual({ reviewer: "kai", merger: null });
});

test("writeRepoRoles keeps the event loop turning during a slow push", async () => {
  const { remote, clone } = remoteWithClone();
  writeHook(join(remote, "hooks"), "pre-receive", "sleep 1");
  let fired = false;
  const timer = setTimeout(() => (fired = true), 50);
  try {
    await writeRepoRoles(clone, { reviewer: null, merger: "scoop" }, "main");
  } finally {
    clearTimeout(timer);
  }
  // A blocking push would hold the loop for the full second, so the 50 ms timer could only
  // run after the write had already resolved.
  expect(fired).toBe(true);
  expect(remoteRoles(remote)).toEqual({ reviewer: null, merger: "scoop" });
});

// ── PR fallback: a default branch that refuses direct pushes ───────────────────────────────

/** The remote refuses any update of `main` — what a protected branch / ruleset does. */
function protectMain(remote: string): void {
  writeHook(
    join(remote, "hooks"),
    "pre-receive",
    'while read old new ref; do [ "$ref" = refs/heads/main ] && { echo "main is protected" >&2; exit 1; }; done; exit 0',
  );
}

const SETTINGS_ON = { requiresPr: true, autoMergeAllowed: true, canAdminister: true };

function fakeRolesForge(over: Record<string, unknown> = {}) {
  const calls = {
    openPr: [] as OpenPrInput[],
    autoMerge: [] as [number, string][],
    closed: [] as number[],
    prStatus: 0,
  };
  let pr: PrStatus = { state: "none", checks: "none" } as PrStatus;
  const forge = {
    mergeMethod: "squash",
    defaultBranch: async () => "main",
    currentUser: async () => "kai",
    prStatus: async () => {
      calls.prStatus++;
      return pr;
    },
    openPr: async (o: OpenPrInput) => {
      calls.openPr.push(o);
      pr = { state: "open", number: 41, url: "https://host/pr/41", checks: "pending" } as PrStatus;
      return pr;
    },
    enableAutoMerge: async (n: number, method: string) => {
      calls.autoMerge.push([n, method]);
    },
    closePr: async (n: number) => {
      calls.closed.push(n);
      pr = { ...pr, state: "closed" };
    },
    ...over,
  } as unknown as GitForge;
  return { forge, calls, setPr: (p: Partial<PrStatus>) => (pr = { ...pr, ...p }) };
}

const hasRef = (repo: string, ref: string): boolean => {
  try {
    execFileSync("git", ["-C", repo, "rev-parse", "--verify", "--quiet", ref], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

test("saveRepoRoles routes a refused default branch through one PR with auto-merge armed", async () => {
  const { remote, clone } = remoteWithClone();
  protectMain(remote);
  const { forge, calls } = fakeRolesForge();
  const roles = { reviewer: "kai", merger: "scoop" };

  const saved = await saveRepoRoles(clone, roles, forge, { pending: null, settings: SETTINGS_ON });

  expect(saved).toEqual({
    kind: "pr",
    pending: { number: 41, url: "https://host/pr/41", roles, autoMerge: "enabled" },
  });
  expect(remoteRoles(remote, ROLES_PR_BRANCH)).toEqual(roles);
  expect(() => remoteRoles(remote, "main")).toThrow(); // main never took it
  expect(calls.openPr).toHaveLength(1);
  expect(calls.openPr[0]).toMatchObject({
    head: ROLES_PR_BRANCH,
    base: "main",
    title: "chore(shepherd): set repo roles",
  });
  expect(calls.autoMerge).toEqual([[41, "squash"]]);
});

test("saveRepoRoles reports auto-merge as disallowed instead of trying it where the repo forbids it", async () => {
  const { remote, clone } = remoteWithClone();
  protectMain(remote);
  const { forge, calls } = fakeRolesForge();
  const saved = await saveRepoRoles(clone, { reviewer: "kai", merger: null }, forge, {
    pending: null,
    settings: { ...SETTINGS_ON, autoMergeAllowed: false },
  });
  expect(saved.kind === "pr" && saved.pending.autoMerge).toBe("disallowed");
  expect(calls.autoMerge).toEqual([]);
});

test("saveRepoRoles updates the open roles PR on a second save instead of opening another", async () => {
  const { remote, clone } = remoteWithClone();
  protectMain(remote);
  const { forge, calls } = fakeRolesForge();
  const o = { pending: null, settings: SETTINGS_ON };
  await saveRepoRoles(clone, { reviewer: "kai", merger: null }, forge, o);
  await saveRepoRoles(clone, { reviewer: "dana", merger: null }, forge, o);

  expect(calls.openPr).toHaveLength(1);
  expect(remoteRoles(remote, ROLES_PR_BRANCH)).toEqual({ reviewer: "dana", merger: null });
});

test("saveRepoRoles throws without a PR when the push fails for any other reason", async () => {
  const { clone } = remoteWithClone();
  execFileSync("git", ["-C", clone, "remote", "set-url", "origin", join(clone, "no-such-remote")]);
  const { forge, calls } = fakeRolesForge();
  await expect(
    saveRepoRoles(clone, { reviewer: "kai", merger: null }, forge, {
      pending: null,
      settings: SETTINGS_ON,
    }),
  ).rejects.toThrow();
  expect(calls.openPr).toEqual([]);
});

test("saveRepoRoles never opens a roles PR from a fork", async () => {
  const { remote, clone } = remoteWithClone();
  protectMain(remote);
  const { forge, calls } = fakeRolesForge({ isFork: true });
  await expect(
    saveRepoRoles(clone, { reviewer: "kai", merger: null }, forge, {
      pending: null,
      settings: null,
    }),
  ).rejects.toThrow();
  expect(calls.openPr).toEqual([]);
});

test("readPendingRoles: no roles PR from this checkout costs no host call", async () => {
  const { clone } = remoteWithClone();
  const { forge, calls } = fakeRolesForge();
  expect(await readPendingRoles(clone, forge)).toBeNull();
  expect(calls.prStatus).toBe(0);
});

test("readPendingRoles reports the open PR's roles, then forgets it once merged", async () => {
  const { remote, clone } = remoteWithClone();
  protectMain(remote);
  const { forge, calls, setPr } = fakeRolesForge();
  const roles = { reviewer: "kai", merger: null };
  await saveRepoRoles(clone, roles, forge, { pending: null, settings: SETTINGS_ON });

  expect(await readPendingRoles(clone, forge)).toEqual({
    number: 41,
    url: "https://host/pr/41",
    roles,
  });

  setPr({ state: "merged" });
  expect(await readPendingRoles(clone, forge)).toBeNull();
  expect(hasRef(clone, `refs/remotes/origin/${ROLES_PR_BRANCH}`)).toBe(false);
  const before = calls.prStatus;
  expect(await readPendingRoles(clone, forge)).toBeNull();
  expect(calls.prStatus).toBe(before);
});

// ── routes ─────────────────────────────────────────────────────────────────────────────────

function rolesApp(forge: GitForge | null) {
  const deps: AppDeps = {
    store: { list: () => [] } as never,
    service: {} as never,
    events: { emit: () => {} } as never,
    usageLimits: { limits: () => ({}) } as never,
    resolveForge: () => forge,
  };
  const app = makeApp(deps);
  return (method: string, dir: string, body?: unknown, path = "/api/repo-roles") =>
    app.fetch(
      new Request(`http://x${path}?repo=${encodeURIComponent(dir)}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
}

test("PUT /api/repo-roles on a refused default branch answers 200 with the pending PR", async () => {
  const { remote, clone } = remoteWithClone(config.repoRoot);
  protectMain(remote);
  const { forge } = fakeRolesForge({ repoMergeSettings: async () => SETTINGS_ON });
  const call = rolesApp(forge);

  const res = await call("PUT", clone, { reviewer: "kai" });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.roles).toEqual({ reviewer: null, merger: null }); // committed: unchanged
  expect(body.pending).toMatchObject({ number: 41, roles: { reviewer: "kai", merger: null } });
  expect(body.mergeSettings).toEqual(SETTINGS_ON);

  // A reload finds the PR again.
  const read = await (await call("GET", clone)).json();
  expect(read.pending).toMatchObject({ number: 41, roles: { reviewer: "kai", merger: null } });
});

test("PUT /api/repo-roles: re-sending the pending value is a no-op", async () => {
  const { remote, clone } = remoteWithClone(config.repoRoot);
  protectMain(remote);
  const { forge, calls } = fakeRolesForge();
  const call = rolesApp(forge);
  await call("PUT", clone, { reviewer: "kai" });
  const res = await call("PUT", clone, { reviewer: "KAI" });
  expect(res.status).toBe(200);
  expect((await res.json()).pending).toMatchObject({ number: 41 });
  expect(calls.openPr).toHaveLength(1);
  expect(calls.autoMerge).toHaveLength(1);
});

test("PUT /api/repo-roles back to the committed value closes the pending PR", async () => {
  const { remote, clone } = remoteWithClone(config.repoRoot);
  protectMain(remote);
  const { forge, calls } = fakeRolesForge();
  const call = rolesApp(forge);
  await call("PUT", clone, { reviewer: "kai" });

  const res = await call("PUT", clone, { reviewer: null });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.pending).toBeUndefined();
  expect(calls.closed).toEqual([41]);
  expect(hasRef(remote, `refs/heads/${ROLES_PR_BRANCH}`)).toBe(false);
});

test("PUT /api/repo-roles back to the committed value keeps a PR it could not close", async () => {
  // An open roles PR with auto-merge armed would still land its value, so it must stay visible.
  const { remote, clone } = remoteWithClone(config.repoRoot);
  protectMain(remote);
  const { forge } = fakeRolesForge({
    closePr: async () => {
      throw new Error("HTTP 502");
    },
  });
  const call = rolesApp(forge);
  await call("PUT", clone, { reviewer: "kai" });

  const res = await call("PUT", clone, { reviewer: null });
  expect(res.status).toBe(502);
  const body = await res.json();
  expect(body.pushError).toBe("push rejected");
  expect(body.pending).toMatchObject({ number: 41, roles: { reviewer: "kai", merger: null } });
  expect((await (await call("GET", clone)).json()).pending).toMatchObject({ number: 41 });
});

test("POST /api/repo-roles/auto-merge: 409 without host support", async () => {
  const { clone } = remoteWithClone(config.repoRoot);
  const res = await rolesApp(fakeRolesForge().forge)(
    "POST",
    clone,
    undefined,
    "/api/repo-roles/auto-merge",
  );
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "unsupported" });
});

test("POST /api/repo-roles/auto-merge turns the setting on and arms the open roles PR", async () => {
  const { remote, clone } = remoteWithClone(config.repoRoot);
  protectMain(remote);
  let allowed = false;
  const { forge, calls } = fakeRolesForge({
    repoMergeSettings: async () => ({ ...SETTINGS_ON, autoMergeAllowed: allowed }),
    enableRepoAutoMerge: async () => {
      allowed = true;
    },
  });
  const call = rolesApp(forge);
  const put = await (await call("PUT", clone, { reviewer: "kai" })).json();
  expect(put.pending.autoMerge).toBe("disallowed");

  const res = await call("POST", clone, undefined, "/api/repo-roles/auto-merge");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.mergeSettings.autoMergeAllowed).toBe(true);
  expect(body.pending).toMatchObject({ number: 41, autoMerge: "enabled" });
  expect(calls.autoMerge).toEqual([[41, "squash"]]);
});

test("POST /api/repo-roles/auto-merge: a host that ignores the write reports it still off", async () => {
  const { clone } = remoteWithClone(config.repoRoot);
  const { forge } = fakeRolesForge({
    repoMergeSettings: async () => ({ ...SETTINGS_ON, autoMergeAllowed: false, planLimited: true }),
    enableRepoAutoMerge: async () => {},
  });
  const res = await rolesApp(forge)("POST", clone, undefined, "/api/repo-roles/auto-merge");
  expect(res.status).toBe(200);
  expect((await res.json()).mergeSettings).toMatchObject({
    autoMergeAllowed: false,
    planLimited: true,
  });
});

test("POST /api/repo-roles/auto-merge: 502 with a generic error when the host refuses", async () => {
  const { clone } = remoteWithClone(config.repoRoot);
  const { forge } = fakeRolesForge({
    enableRepoAutoMerge: async () => {
      throw new Error("HTTP 403 at secret-host");
    },
  });
  const res = await rolesApp(forge)("POST", clone, undefined, "/api/repo-roles/auto-merge");
  expect(res.status).toBe(502);
  const body = await res.json();
  expect(body).toEqual({ error: "auto_merge_enable_failed" });
});

test("annotateHandoff carries a merge-queue stamp across an on-demand read of the same head", () => {
  const fresh: GitState = {
    kind: "github",
    state: "open",
    number: 7,
    checks: "success",
    headSha: "h1",
    deployConfigured: false,
  };
  const prev: GitState = { ...fresh, inMergeQueue: true };
  expect(annotateHandoff(fresh, "/nonexistent", null, prev).inMergeQueue).toBe(true);
  expect(
    annotateHandoff({ ...fresh, headSha: "h2" }, "/nonexistent", null, prev).inMergeQueue,
  ).toBeUndefined();
  expect(
    annotateHandoff({ ...fresh, state: "merged" }, "/nonexistent", null, prev).inMergeQueue,
  ).toBeUndefined();
});
