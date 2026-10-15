import { test, expect } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { SessionStore } from "../src/store";

const RETIRED_TABLES = [
  "learnings",
  "session_injected_learnings",
  "learning_relevance",
  "learning_prune_tombstones",
  "learning_merge_suggestions",
];

/** A DB laid down by a pre-#3139 build: learnings tables, repo_config toggles, settings keys. */
function seedLegacy(dbPath: string): void {
  const raw = new Database(dbPath);
  raw.run(`CREATE TABLE learnings (
    id TEXT PRIMARY KEY, repoPath TEXT NOT NULL, rule TEXT NOT NULL,
    status TEXT NOT NULL, createdAt INTEGER NOT NULL)`);
  raw.run(`INSERT INTO learnings VALUES ('a1', '/r', 'keep me', 'active', 1)`);
  raw.run(`INSERT INTO learnings VALUES ('a2', '/r', 'and me', 'active', 2)`);
  raw.run(`INSERT INTO learnings VALUES ('x1', '/r', 'gone', 'retired', 3)`);
  raw.run(`INSERT INTO learnings VALUES ('p1', '/r', 'unreviewed', 'proposed', 4)`);
  for (const t of RETIRED_TABLES.slice(1)) raw.run(`CREATE TABLE ${t} (k TEXT)`);
  raw.run(`CREATE TABLE repo_config (
    repoPath TEXT PRIMARY KEY, criticEnabled INTEGER NOT NULL DEFAULT 1,
    learningsEnabled INTEGER NOT NULL DEFAULT 1,
    autoOptimizeFlagged INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL)`);
  raw.run(`INSERT INTO repo_config (repoPath, criticEnabled, updatedAt) VALUES ('/r', 0, 1)`);
  raw.run(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  for (const [k, v] of <[string, string][]>[
    ["learnings:retired-seen:/r", "5"],
    ["distiller:last-run:/r", "9"],
    ["distillerCli", "claude"],
    ["houseRuleRelevance", "shadow"],
    ["criticCli", "codex"],
  ])
    raw.run(`INSERT INTO settings (key, value) VALUES (?, ?)`, [k, v]);
  raw.close();
}

function tables(dbPath: string): string[] {
  const raw = new Database(dbPath);
  const rows = raw.query(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as {
    name: string;
  }[];
  raw.close();
  return rows.map((r) => r.name);
}

test("retire learnings: exports active rules, drops tables/columns/settings, idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-store-retire-learnings-"));
  const dbPath = join(dir, "test.db");
  try {
    seedLegacy(dbPath);
    const store = new SessionStore(dbPath);

    const exports = readdirSync(dir).filter((f) => f.startsWith("learnings-export-"));
    expect(exports).toHaveLength(1);
    const dumped = JSON.parse(readFileSync(join(dir, exports[0]!), "utf8")) as { id: string }[];
    expect(dumped.map((r) => r.id)).toEqual(["a1", "a2"]);

    for (const t of RETIRED_TABLES) expect(tables(dbPath)).not.toContain(t);
    expect(store.getSetting("learnings:retired-seen:/r")).toBeNull();
    expect(store.getSetting("distiller:last-run:/r")).toBeNull();
    expect(store.getSetting("distillerCli")).toBeNull();
    expect(store.getSetting("houseRuleRelevance")).toBeNull();
    expect(store.getSetting("criticCli")).toBe("codex");
    // The surviving repo_config row keeps its other values; the retired columns are gone.
    expect(store.getRepoConfig("/r").criticEnabled).toBe(false);
    store.setRepoConfig("/r", { ...store.getRepoConfig("/r"), criticEnabled: true });
    expect(store.getRepoConfig("/r").criticEnabled).toBe(true);
    const raw = new Database(dbPath);
    const cols = (raw.query(`PRAGMA table_info(repo_config)`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    raw.close();
    expect(cols).not.toContain("learningsEnabled");
    expect(cols).not.toContain("autoOptimizeFlagged");

    // A second open finds nothing to retire and writes no second export.
    new SessionStore(dbPath);
    expect(readdirSync(dir).filter((f) => f.startsWith("learnings-export-"))).toHaveLength(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retire learnings: no active rules → no export file, tables still dropped", () => {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-store-retire-learnings-empty-"));
  const dbPath = join(dir, "test.db");
  try {
    const raw = new Database(dbPath);
    raw.run(`CREATE TABLE learnings (id TEXT PRIMARY KEY, status TEXT NOT NULL)`);
    raw.run(`INSERT INTO learnings VALUES ('x1', 'retired')`);
    raw.close();
    new SessionStore(dbPath);
    expect(readdirSync(dir).filter((f) => f.startsWith("learnings-export-"))).toHaveLength(0);
    expect(tables(dbPath)).not.toContain("learnings");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retire learnings: fresh DB has no learnings tables or columns", () => {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-store-retire-learnings-fresh-"));
  const dbPath = join(dir, "test.db");
  try {
    new SessionStore(dbPath);
    for (const t of RETIRED_TABLES) expect(tables(dbPath)).not.toContain(t);
    expect(readdirSync(dir).filter((f) => f.startsWith("learnings-export-"))).toHaveLength(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
