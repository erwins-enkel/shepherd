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
    db.run(
      `INSERT INTO session_git_cache (sessionId, gitJson, updatedAt) VALUES (?, ?, ?)`,
      [
        session.id,
        JSON.stringify({ kind: "github", number: 7, checks: "success", deployConfigured: false }),
        Date.now(),
      ],
    );

    expect(store.listSessionGitCache()).toEqual({});
    expect(
      db.query(`SELECT COUNT(*) AS count FROM session_git_cache WHERE sessionId = ?`).get(
        session.id,
      ),
    ).toEqual({ count: 0 });
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
      db.query(`SELECT COUNT(*) AS count FROM session_git_cache WHERE sessionId = ?`).get(
        session.id,
      ),
    ).toEqual({ count: 0 });
    db.close();
  });
});
