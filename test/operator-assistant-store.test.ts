// Operator Assistant scopes in the store: one live global assistant plus one per repo, enforced by
// the `sessions_operator_assistant_scope` partial index, and the legacy singleton index migrated.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/store";

function assistant(store: SessionStore, assistantRepo: string | null, name = "operator-assistant") {
  return store.create({
    name,
    prompt: "",
    repoPath: "/assistant",
    baseBranch: "",
    branch: null,
    worktreePath: "/assistant",
    isolated: false,
    herdrSession: "default",
    herdrAgentId: `term_${name}`,
    claudeSessionId: `claude-${name}`,
    model: null,
    operatorAssistant: true,
    assistantRepo,
  });
}

const indexNames = (path: string) => {
  const raw = new Database(path);
  try {
    return (
      raw
        .query(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sessions'`)
        .all() as { name: string }[]
    ).map((r) => r.name);
  } finally {
    raw.close();
  }
};

test("assistantRepo round-trips; null on the global assistant and on every other row", () => {
  const store = new SessionStore(":memory:");
  const global = assistant(store, null);
  const scoped = assistant(store, "/r/alpha", "operator-assistant-alpha");
  const worker = store.create({
    name: "worker",
    prompt: "p",
    repoPath: "/r/alpha",
    baseBranch: "main",
    branch: "shepherd/worker",
    worktreePath: "/wt",
    isolated: false,
    herdrSession: "default",
    herdrAgentId: "term_w",
  });
  expect(global.assistantRepo).toBeNull();
  expect(store.get(global.id)!.assistantRepo).toBeNull();
  expect(scoped.assistantRepo).toBe("/r/alpha");
  expect(store.get(scoped.id)!.assistantRepo).toBe("/r/alpha");
  expect(store.get(worker.id)!.assistantRepo).toBeNull();
});

test("one live global plus one per repo; a second in the same scope is refused", () => {
  const store = new SessionStore(":memory:");
  assistant(store, null);
  assistant(store, "/r/alpha", "oa-alpha");
  assistant(store, "/r/beta", "oa-beta");
  expect(() => assistant(store, null, "oa-global-2")).toThrow();
  expect(() => assistant(store, "/r/alpha", "oa-alpha-2")).toThrow();
});

test("getLiveOperatorAssistant reads one scope; no arg is the global one", () => {
  const store = new SessionStore(":memory:");
  expect(store.getLiveOperatorAssistant()).toBeNull();
  const alpha = assistant(store, "/r/alpha", "oa-alpha");
  // A repo assistant is never the global one.
  expect(store.getLiveOperatorAssistant()).toBeNull();
  expect(store.getLiveOperatorAssistant(null)).toBeNull();
  expect(store.getLiveOperatorAssistant("/r/alpha")?.id).toBe(alpha.id);
  expect(store.getLiveOperatorAssistant("/r/beta")).toBeNull();
  const global = assistant(store, null);
  expect(store.getLiveOperatorAssistant()?.id).toBe(global.id);
});

test("archiving frees the scope's slot", () => {
  const store = new SessionStore(":memory:");
  const alpha = assistant(store, "/r/alpha", "oa-alpha");
  store.archive(alpha.id);
  expect(store.getLiveOperatorAssistant("/r/alpha")).toBeNull();
  const fresh = assistant(store, "/r/alpha", "oa-alpha-2");
  expect(store.getLiveOperatorAssistant("/r/alpha")?.id).toBe(fresh.id);
});

test("listLiveOperatorAssistants: global first, then repo ones oldest first, archived left out", () => {
  const store = new SessionStore(":memory:");
  const beta = assistant(store, "/r/beta", "oa-beta");
  const alpha = assistant(store, "/r/alpha", "oa-alpha");
  const gone = assistant(store, "/r/gamma", "oa-gamma");
  store.archive(gone.id);
  const global = assistant(store, null);
  // createdAt can tie within a millisecond; pin it so the order under test is the scope order.
  const raw = (store as unknown as { db: Database }).db;
  raw.run(`UPDATE sessions SET createdAt = 1 WHERE id = ?`, [beta.id]);
  raw.run(`UPDATE sessions SET createdAt = 2 WHERE id = ?`, [alpha.id]);
  raw.run(`UPDATE sessions SET createdAt = 3 WHERE id = ?`, [global.id]);
  expect(store.listLiveOperatorAssistants().map((s) => s.id)).toEqual([
    global.id,
    beta.id,
    alpha.id,
  ]);
});

test("a legacy DB with the install-wide singleton index migrates to the scope index", () => {
  const path = join(mkdtempSync(join(tmpdir(), "oa-store-")), "shepherd.db");
  const before = new SessionStore(path);
  const legacy = assistant(before, null);
  (before as unknown as { db: Database }).db.close();
  // Rewind to the pre-scope schema: no assistantRepo column, the old singleton index.
  const raw = new Database(path);
  raw.run(`DROP INDEX sessions_operator_assistant_scope`);
  raw.run(`ALTER TABLE sessions DROP COLUMN assistantRepo`);
  raw.run(
    `CREATE UNIQUE INDEX sessions_operator_assistant_singleton
       ON sessions (operatorAssistant) WHERE operatorAssistant = 1 AND archivedAt IS NULL`,
  );
  raw.close();

  const store = new SessionStore(path);
  const names = indexNames(path);
  expect(names).toContain("sessions_operator_assistant_scope");
  expect(names).not.toContain("sessions_operator_assistant_singleton");
  // The legacy row is the global assistant; a repo one now fits beside it.
  expect(store.getLiveOperatorAssistant()?.id).toBe(legacy.id);
  expect(store.get(legacy.id)!.assistantRepo).toBeNull();
  const alpha = assistant(store, "/r/alpha", "oa-alpha");
  expect(store.listLiveOperatorAssistants().map((s) => s.id)).toEqual([legacy.id, alpha.id]);
  expect(() => assistant(store, null, "oa-global-2")).toThrow();
});
