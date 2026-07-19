// test/task5-completion-barrier.test.ts — #807 lightweight completion barrier + local merge cleanup.
// Real git temp repos + real SessionStore + real LocalForge, driven through the actual
// makeApp HTTP routes (forgeMerge / forgeOpenPr) and the merge-train decision core.
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { makeApp } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { LocalForge, MergeConflictError, BaseCheckoutBusyError } from "../src/forge/local";
import { computeMerge, type MergeRepoState, type MergeSessionView } from "../src/automerge-core";

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const git = (repo: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: repo, env: ENV, stdio: "pipe" }).toString().trim();

/** A repo on `main` with one commit + a feature branch with `n` commits, base detached
 *  (checked out nowhere) so squashMergeLocal takes the bare update-ref path. */
function mkRepoWithBranch(branch: string, n = 2): { repo: string; baseTip: string } {
  const repo = mkdtempSync(join(tmpdir(), "shepherd-t5-"));
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "1\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  const baseTip = git(repo, "rev-parse", "main");
  git(repo, "checkout", "-q", "-b", branch);
  for (let i = 0; i < n; i++) {
    writeFileSync(join(repo, `f${i}.txt`), `feature ${i}\n`);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", `feat ${i}`);
  }
  git(repo, "checkout", "-q", "--detach"); // base checked out nowhere
  return { repo, baseTip };
}

/** Build an app over a real store + a single resolved forge, tracking settle side effects. */
function appOver(
  store: SessionStore,
  forge: any,
): {
  app: ReturnType<typeof makeApp>;
  archived: string[];
  dropped: string[];
} {
  const archived: string[] = [];
  const dropped: string[] = [];
  const app = makeApp({
    store,
    service: { archive: async (id: string) => (archived.push(id), 1) } as any,
    events: new EventHub(),
    usageLimits: { limits: () => ({}) } as any,
    resolveForge: () => forge,
    prCache: {
      snapshot: () => ({}),
      get: () => undefined,
      set: () => {},
      drop: (id: string) => dropped.push(id),
    } as any,
    drain: { retainClaim: () => {} } as any,
  });
  return { app, archived, dropped };
}

function mkSession(store: SessionStore, repo: string, branch: string) {
  return store.create({
    name: "feat",
    prompt: "p",
    repoPath: repo,
    baseBranch: "main",
    branch,
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "t",
    auto: false,
    issueNumber: null,
  });
}

// ── forgeMerge: lightweight (local) merge tears the session down ─────────────

test("forgeMerge on a local session merges then settles (archive + drop pr cache)", async () => {
  const { repo, baseTip } = mkRepoWithBranch("feature/local", 2);
  try {
    const store = new SessionStore(":memory:");
    const forge = new LocalForge(repo, store);
    const { app, archived, dropped } = appOver(store, forge);

    const s = mkSession(store, repo, "feature/local");
    await forge.openPr({ head: "feature/local", base: "main", title: "t", body: "b" });

    const res = await app.fetch(
      new Request(`http://x/api/sessions/${s.id}/git/merge`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string };
    expect(body.state).toBe("merged");

    // base ref advanced by the squash commit
    expect(git(repo, "rev-parse", "refs/heads/main^")).toBe(baseTip);
    expect(git(repo, "rev-parse", "refs/heads/main")).not.toBe(baseTip);
    // session settled: archived + pr cache dropped
    expect(archived).toEqual([s.id]);
    expect(dropped).toEqual([s.id]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── forgeMerge: a forge (github-shaped) session must NOT settle ──────────────

test("forgeMerge on a non-local (forge) session does NOT settle", async () => {
  const repo = mkdtempSync(join(tmpdir(), "shepherd-t5-forge-"));
  try {
    const store = new SessionStore(":memory:");
    const archived: string[] = [];
    const dropped: string[] = [];
    let merged = false;
    const fakeForge = {
      kind: "github" as const,
      mergeMethod: "squash" as const,
      prStatus: async () => ({
        state: merged ? "merged" : "open",
        number: 5,
        checks: "success" as const,
        deployConfigured: false,
      }),
      merge: async () => {
        merged = true;
      },
      currentUser: async () => null,
    };
    const app = makeApp({
      store,
      service: { archive: async (id: string) => (archived.push(id), 1) } as any,
      events: new EventHub(),
      usageLimits: { limits: () => ({}) } as any,
      resolveForge: () => fakeForge as any,
      prCache: {
        snapshot: () => ({}),
        get: () => undefined,
        set: () => {},
        drop: (id: string) => dropped.push(id),
      } as any,
      drain: { retainClaim: () => {} } as any,
    });
    const s = mkSession(store, repo, "feature/gh");
    const res = await app.fetch(
      new Request(`http://x/api/sessions/${s.id}/git/merge`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(200);
    // forge path is unchanged: NO settle (no archive, no drop on this branch)
    expect(archived).toEqual([]);
    expect(dropped).toEqual([]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── forgeOpenPr: empty diff → clean 409, not a 500 ──────────────────────────

test("forgeOpenPr returns 409 when a local branch has no commits to merge", async () => {
  const repo = mkdtempSync(join(tmpdir(), "shepherd-t5-empty-"));
  try {
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "1\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    git(repo, "branch", "feature/empty"); // branch at main's tip, no commits ahead

    const store = new SessionStore(":memory:");
    const forge = new LocalForge(repo, store);
    const app = makeApp({
      store,
      service: {} as any,
      events: new EventHub(),
      usageLimits: { limits: () => ({}) } as any,
      resolveForge: () => forge,
      prCache: { snapshot: () => ({}), get: () => undefined, set: () => {}, drop: () => {} } as any,
    });
    const s = mkSession(store, repo, "feature/empty");
    const res = await app.fetch(
      new Request(`http://x/api/sessions/${s.id}/git/pr`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toEqual({ error: "no commits to merge" });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── headline integration: register pseudo-PR, merge, base advanced + settled ─

test("headline: openPr then merge advances base AND archives the session", async () => {
  const { repo, baseTip } = mkRepoWithBranch("feature/headline", 3);
  try {
    const store = new SessionStore(":memory:");
    const forge = new LocalForge(repo, store);
    const { app, archived, dropped } = appOver(store, forge);
    const s = mkSession(store, repo, "feature/headline");

    // register the pseudo-PR (the server-side completion barrier)
    const opened = await forge.openPr({
      head: "feature/headline",
      base: "main",
      title: "t",
      body: "b",
    });
    expect(opened.state).toBe("open");

    const res = await app.fetch(
      new Request(`http://x/api/sessions/${s.id}/git/merge`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(200);

    // exactly one squash commit on base, the pr row is merged, session settled
    expect(git(repo, "rev-parse", "refs/heads/main^")).toBe(baseTip);
    expect(store.getLocalPrByNumber(opened.number!)!.state).toBe("merged");
    expect(archived).toEqual([s.id]);
    expect(dropped).toEqual([s.id]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── merge train fires for a LocalForge-shaped view (readyToMerge true) ───────

test("computeMerge → merge for a LocalForge-shaped ready view (proves auto-merge fires locally)", () => {
  // LocalForge.prStatus shape for an open PR: checks success, mergeable true, a number.
  const view: MergeSessionView = {
    id: "s1",
    desig: "TASK-01",
    state: "open",
    checks: "success",
    noCi: false,
    mergeable: true,
    number: 1,
    headSha: "h1",
    behind: false,
    reviewDecision: null,
    reviewHeadSha: null,
    isDraft: false,
    humanApproved: false,
    findings: [],
    rebaseCount: 0,
    rebaseSteeredHead: null,
    rebaseSteeredAt: null,
    busy: false,
    mergeBlocked: false,
    manualSteps: [],
    manualStepsAckedAt: null,
  };
  const state: MergeRepoState = {
    enabled: true,
    criticEnabled: false, // standalone critic self-disables in lightweight mode
    draftMode: false,
    signoffAuthority: "human",
    now: 0,
    rebaseCap: 5,
    sessions: [view],
  };
  expect(computeMerge(state)).toEqual({
    kind: "merge",
    sessionId: "s1",
    prNumber: 1,
    headSha: "h1",
  });
});

// ── forgeMerge: local merge errors → 409, session stays "open" ───────────────

test("forgeMerge on a local session returns 409 (not 500) when MergeConflictError thrown, pr row stays open", async () => {
  const { repo } = mkRepoWithBranch("feature/conflict", 1);
  try {
    const store = new SessionStore(":memory:");
    // Stub LocalForge: openPr succeeds, merge throws MergeConflictError
    const stubForge = {
      kind: "local" as const,
      mergeMethod: "squash" as const,
      prStatus: async () => ({
        state: "open" as const,
        number: 1,
        checks: "success" as const,
        deployConfigured: false,
      }),
      merge: async () => {
        throw new MergeConflictError("feature/conflict", "main");
      },
      openPr: async () => ({
        state: "open" as const,
        number: 1,
        checks: "success" as const,
        deployConfigured: false,
      }),
      currentUser: async () => null,
    };
    const app = makeApp({
      store,
      service: { archive: async () => 1 } as any,
      events: new EventHub(),
      usageLimits: { limits: () => ({}) } as any,
      resolveForge: () => stubForge as any,
      prCache: { snapshot: () => ({}), get: () => undefined, set: () => {}, drop: () => {} } as any,
      drain: { retainClaim: () => {} } as any,
    });
    const s = mkSession(store, repo, "feature/conflict");

    const res = await app.fetch(
      new Request(`http://x/api/sessions/${s.id}/git/merge`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/merge conflict/);
    // session must NOT have been archived (nothing partially settled)
    expect(store.get(s.id)!.status).not.toBe("archived");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("forgeMerge on a local session returns 409 (not 500) when BaseCheckoutBusyError thrown, pr row stays open", async () => {
  const { repo } = mkRepoWithBranch("feature/busy", 1);
  try {
    const store = new SessionStore(":memory:");
    const stubForge = {
      kind: "local" as const,
      mergeMethod: "squash" as const,
      prStatus: async () => ({
        state: "open" as const,
        number: 1,
        checks: "success" as const,
        deployConfigured: false,
      }),
      merge: async () => {
        throw new BaseCheckoutBusyError("main");
      },
      openPr: async () => ({
        state: "open" as const,
        number: 1,
        checks: "success" as const,
        deployConfigured: false,
      }),
      currentUser: async () => null,
    };
    const app = makeApp({
      store,
      service: { archive: async () => 1 } as any,
      events: new EventHub(),
      usageLimits: { limits: () => ({}) } as any,
      resolveForge: () => stubForge as any,
      prCache: { snapshot: () => ({}), get: () => undefined, set: () => {}, drop: () => {} } as any,
      drain: { retainClaim: () => {} } as any,
    });
    const s = mkSession(store, repo, "feature/busy");

    const res = await app.fetch(
      new Request(`http://x/api/sessions/${s.id}/git/merge`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/base branch checkout/);
    expect(store.get(s.id)!.status).not.toBe("archived");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
