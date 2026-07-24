import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitState } from "../src/forge/types";
import { SessionStore } from "../src/store";

const base = {
  name: "cached-git",
  prompt: "persist git state",
  repoPath: "/repo",
  baseBranch: "main",
  branch: "shepherd/cached-git",
  worktreePath: "/repo-wt",
  isolated: true,
  herdrSession: "default",
  herdrAgentId: "term_git_cache",
};

function withFileStore(run: (store: SessionStore, path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-git-cache-"));
  const path = join(dir, "state.db");
  try {
    run(new SessionStore(path), path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("session git cache round-trips open and none states", () => {
  withFileStore((store, path) => {
    const openSession = store.create(base);
    const noneSession = store.create({
      ...base,
      name: "no-pr",
      branch: "shepherd/no-pr",
      herdrAgentId: "term_no_pr",
    });
    const open: GitState = {
      kind: "github",
      state: "open",
      number: 7,
      checks: "pending",
      deployConfigured: false,
      headSha: "abc123",
    };
    const none: GitState = {
      kind: "github",
      state: "none",
      checks: "none",
      deployConfigured: false,
    };

    store.putSessionGitCache(openSession.id, open);
    store.putSessionGitCache(noneSession.id, none);

    const reopened = new SessionStore(path);
    expect(reopened.listSessionGitCache()).toEqual({
      [openSession.id]: open,
      [noneSession.id]: none,
    });
  });
});

test("session git cache rejects and deletes structurally invalid JSON objects", () => {
  withFileStore((store, path) => {
    const session = store.create(base);
    const db = new Database(path);
    db.run(`INSERT INTO session_git_cache (sessionId, gitJson, updatedAt) VALUES (?, ?, ?)`, [
      session.id,
      JSON.stringify({ kind: "github", number: 7, checks: "success", deployConfigured: false }),
      Date.now(),
    ]);

    expect(store.listSessionGitCache()).toEqual({});
    expect(
      db
        .query(`SELECT COUNT(*) AS count FROM session_git_cache WHERE sessionId = ?`)
        .get(session.id),
    ).toEqual({ count: 0 });
    db.close();
  });
});

test("session git cache validates every optional GitState field before hydration", () => {
  withFileStore((store, path) => {
    const invalidFields: Array<[string, unknown]> = [
      ["url", "javascript:alert(1)"],
      ["title", 7],
      ["createdAt", "now"],
      ["mergeable", "yes"],
      ["runningChecks", ["verify", 7]],
      ["headSha", 7],
      ["latestReview", { state: "approved", author: "scoop", submittedAt: "now" }],
      ["reviewerStates", { scoop: { state: "approved", latestAt: "now" } }],
      ["requestedReviewers", ["scoop", 7]],
      ["isDraft", "yes"],
      ["mergeStateStatus", "ready"],
      ["baseRefName", 7],
      ["noCi", "yes"],
      ["handoff", "operator"],
      ["handoffWho", 7],
      ["handoffInferred", "yes"],
      ["reviewBlock", { reviewer: "scoop", state: "approved", latestAt: 1 }],
      ["issueUrl", "data:text/html,bad"],
    ];
    const db = new Database(path);
    for (const [index, [field, invalidValue]] of invalidFields.entries()) {
      const session = store.create({
        ...base,
        name: `invalid-${field}`,
        branch: `shepherd/invalid-${index}`,
        herdrAgentId: `term_invalid_${index}`,
      });
      db.run(`INSERT INTO session_git_cache (sessionId, gitJson, updatedAt) VALUES (?, ?, ?)`, [
        session.id,
        JSON.stringify({
          kind: "github",
          state: "open",
          number: 7,
          checks: "pending",
          deployConfigured: false,
          [field]: invalidValue,
        }),
        Date.now(),
      ]);
    }

    expect(store.listSessionGitCache()).toEqual({});
    expect(db.query(`SELECT COUNT(*) AS count FROM session_git_cache`).get()).toEqual({ count: 0 });
    db.close();
  });
});

test("session git cache preserves valid optional fields and strips unknown fields", () => {
  withFileStore((store, path) => {
    const session = store.create(base);
    const db = new Database(path);
    const expected: GitState = {
      kind: "github",
      state: "open",
      number: 7,
      url: "https://github.com/acme/repo/pull/7",
      title: "Persisted PR",
      createdAt: 1,
      mergeable: null,
      checks: "pending",
      runningChecks: ["verify"],
      headSha: "abc123",
      latestReview: { state: "approved", author: "scoop", submittedAt: 2 },
      reviewerStates: { scoop: { state: "changes_requested", latestAt: null } },
      requestedReviewers: ["scoop"],
      isDraft: true,
      mergeStateStatus: "blocked",
      baseRefName: "main",
      deployConfigured: true,
      noCi: false,
      handoff: "reviewer",
      handoffWho: "scoop",
      handoffInferred: true,
      reviewBlock: { reviewer: "scoop", state: "changes_requested", latestAt: 3 },
      issueUrl: "http://gitea.local/acme/repo/issues/9",
    };
    db.run(`INSERT INTO session_git_cache (sessionId, gitJson, updatedAt) VALUES (?, ?, ?)`, [
      session.id,
      JSON.stringify({
        ...expected,
        latestReview: { ...expected.latestReview, unknown: "discard me" },
        reviewerStates: {
          scoop: { ...expected.reviewerStates?.scoop, unknown: "discard me" },
        },
        reviewBlock: { ...expected.reviewBlock, unknown: "discard me" },
        unknown: "discard me",
      }),
      Date.now(),
    ]);

    expect(store.listSessionGitCache()).toEqual({ [session.id]: expected });
    db.close();
  });
});

test("archive atomically removes the session git cache row", () => {
  withFileStore((store, path) => {
    const session = store.create(base);
    store.putSessionGitCache(session.id, {
      kind: "github",
      state: "open",
      number: 7,
      checks: "success",
      deployConfigured: false,
    });

    store.archive(session.id);

    expect(store.get(session.id)?.status).toBe("archived");
    expect(store.pruneArchivedSessions({ maxAgeMs: -1, keepNewest: 0 })).toBe(1);
    expect(store.get(session.id)).toBeNull();
    const db = new Database(path);
    expect(
      db
        .query(`SELECT COUNT(*) AS count FROM session_git_cache WHERE sessionId = ?`)
        .get(session.id),
    ).toEqual({ count: 0 });
    db.close();
  });
});
