/**
 * Tests for issue #1025: first-task automation-confirmation persistence + API.
 * RED phase — all tests fail until implementation lands.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { SessionStore } from "../src/store";
import { makeApp, type AppDeps } from "../src/server";
import { SessionService } from "../src/service";
import { EventHub } from "../src/events";
import { config } from "../src/config";

// ── Store unit tests ──────────────────────────────────────────────────────────

const base = {
  name: "repo-flatten",
  prompt: "flatten repo",
  repoPath: "/r",
  baseBranch: "main",
  branch: "shepherd/repo-flatten",
  worktreePath: "/r-wt",
  isolated: true,
  herdrSession: "default",
  herdrAgentId: "term_1",
};

test("migrateRepoConfigColumns adds automationConfirmedAt column", () => {
  const s = new SessionStore(":memory:");
  // Column exists after init — PRAGMA returns it.
  const cols = (s as any).db.query(`PRAGMA table_info(repo_config)`).all() as { name: string }[];
  expect(cols.some((c: { name: string }) => c.name === "automationConfirmedAt")).toBe(true);
});

test("migrateRepoConfigColumns backfill: pre-existing rows get automationConfirmedAt set, re-open with NULL stays NULL", () => {
  // Uses a file-backed DB to survive across SessionStore instances.
  const dir = mkdtempSync(join(tmpdir(), "shepherd-test-"));
  const dbPath = join(dir, "test.db");
  try {
    // Step 1: create a raw DB with repo_config but WITHOUT automationConfirmedAt, insert a row.
    const raw = new Database(dbPath);
    raw.run(`CREATE TABLE IF NOT EXISTS repo_config (
      repoPath TEXT PRIMARY KEY, criticEnabled INTEGER NOT NULL DEFAULT 1,
      criticAllPrs INTEGER NOT NULL DEFAULT 0,
      learningsEnabled INTEGER NOT NULL DEFAULT 1,
      autoDrainEnabled INTEGER NOT NULL DEFAULT 0,
      autoMergeEnabled INTEGER NOT NULL DEFAULT 0,
      maxAuto INTEGER NOT NULL DEFAULT 1,
      autoLabel TEXT NOT NULL DEFAULT 'shepherd:auto',
      usageCeilingPct INTEGER NOT NULL DEFAULT 80,
      repoMode TEXT NOT NULL DEFAULT 'forge',
      updatedAt INTEGER NOT NULL)`);
    raw.run(`INSERT INTO repo_config (repoPath, updatedAt) VALUES ('/repo/legacy', 9999)`);
    raw.close();

    // Step 2: open a real SessionStore — migration runs, adds column + backfills from updatedAt.
    const s1 = new SessionStore(dbPath);
    // Backfill should have set automationConfirmedAt = updatedAt (9999) → confirmed.
    expect(s1.isAutomationConfirmed("/repo/legacy")).toBe(true);

    // Step 3: simulate a freshly-seeded-but-unconfirmed row (NULL set explicitly after migration).
    (s1 as any).db.run(
      `UPDATE repo_config SET automationConfirmedAt = NULL WHERE repoPath = '/repo/legacy'`,
    );

    // Step 4: re-open — column already exists, backfill branch is skipped → row stays NULL.
    const s2 = new SessionStore(dbPath);
    expect(s2.isAutomationConfirmed("/repo/legacy")).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migrateRepoConfigColumns backfill is one-time: re-opening does not re-confirm a NULL row", () => {
  // We can't test the column-missing branch directly on :memory: (it's always fresh),
  // but we can verify that markAutomationConfirmed → NULL reset is respected on re-open:
  // i.e., the migrate code checks column-missing, not value-null, so a NULL row stays NULL.
  const s = new SessionStore(":memory:");
  s.setRepoConfig("/repo/b", s.getRepoConfig("/repo/b"));
  // Manually clear automationConfirmedAt via the internal DB (simulates a freshly-seeded
  // unconfirmed row on a DB that already has the column).
  (s as any).db.run(
    `UPDATE repo_config SET automationConfirmedAt = NULL WHERE repoPath = '/repo/b'`,
  );
  // isAutomationConfirmed uses the session fallback — no sessions → should be false.
  expect(s.isAutomationConfirmed("/repo/b")).toBe(false);
  // A new store instance opening the same :memory: DB is not possible, but we can verify
  // the store doesn't re-backfill by re-calling migrate via a second store (isolated DB).
  // The gist: the branch is column-missing, and since the column exists now, it won't re-run.
});

test("isAutomationConfirmed: true when automationConfirmedAt is set", () => {
  const s = new SessionStore(":memory:");
  s.setRepoConfig("/repo/c", s.getRepoConfig("/repo/c"));
  // Clear to ensure clean state
  (s as any).db.run(
    `UPDATE repo_config SET automationConfirmedAt = NULL WHERE repoPath = '/repo/c'`,
  );
  expect(s.isAutomationConfirmed("/repo/c")).toBe(false);
  s.markAutomationConfirmed("/repo/c");
  expect(s.isAutomationConfirmed("/repo/c")).toBe(true);
});

test("isAutomationConfirmed: true when a session exists for the repo (no confirmedAt)", () => {
  const s = new SessionStore(":memory:");
  // No repo_config row at all, but a session exists
  s.create({ ...base, repoPath: "/repo/with-session" });
  expect(s.isAutomationConfirmed("/repo/with-session")).toBe(true);
});

test("isAutomationConfirmed: false when neither confirmedAt nor session exists", () => {
  const s = new SessionStore(":memory:");
  // setRepoConfig writes a row; clear automationConfirmedAt so it's null
  s.setRepoConfig("/repo/fresh", s.getRepoConfig("/repo/fresh"));
  (s as any).db.run(
    `UPDATE repo_config SET automationConfirmedAt = NULL WHERE repoPath = '/repo/fresh'`,
  );
  expect(s.isAutomationConfirmed("/repo/fresh")).toBe(false);
});

test("isAutomationConfirmed: false when no repo_config row exists", () => {
  const s = new SessionStore(":memory:");
  expect(s.isAutomationConfirmed("/repo/nonexistent")).toBe(false);
});

test("hasSessionForRepo: true when at least one session exists", () => {
  const s = new SessionStore(":memory:");
  s.create({ ...base, repoPath: "/repo/has-session" });
  expect(s.hasSessionForRepo("/repo/has-session")).toBe(true);
});

test("hasSessionForRepo: false when no session exists", () => {
  const s = new SessionStore(":memory:");
  expect(s.hasSessionForRepo("/repo/no-session")).toBe(false);
});

test("automationRowExists: false when no repo_config row", () => {
  const s = new SessionStore(":memory:");
  expect(s.automationRowExists("/repo/new")).toBe(false);
});

test("automationRowExists: true after setRepoConfig is called", () => {
  const s = new SessionStore(":memory:");
  s.setRepoConfig("/repo/exists", s.getRepoConfig("/repo/exists"));
  expect(s.automationRowExists("/repo/exists")).toBe(true);
});

test("markAutomationConfirmed sets automationConfirmedAt to non-null", () => {
  const s = new SessionStore(":memory:");
  s.setRepoConfig("/repo/mark", s.getRepoConfig("/repo/mark"));
  (s as any).db.run(
    `UPDATE repo_config SET automationConfirmedAt = NULL WHERE repoPath = '/repo/mark'`,
  );
  expect(s.isAutomationConfirmed("/repo/mark")).toBe(false);
  const before = Date.now();
  s.markAutomationConfirmed("/repo/mark");
  const after = Date.now();
  const row = (s as any).db
    .query(`SELECT automationConfirmedAt FROM repo_config WHERE repoPath = '/repo/mark'`)
    .get() as { automationConfirmedAt: number } | null;
  expect(row?.automationConfirmedAt).toBeGreaterThanOrEqual(before);
  expect(row?.automationConfirmedAt).toBeLessThanOrEqual(after);
});

// ── API tests ─────────────────────────────────────────────────────────────────

let tmpRoot: string;
let validRepo: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-srv-test-"));
  validRepo = join(tmpRoot, "repo");
  mkdirSync(validRepo);
});

afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

function makeDeps(): AppDeps {
  const store = new SessionStore(":memory:");
  const events = new EventHub();
  const service = new SessionService({
    store,
    namer: async () => "x",
    worktree: {
      create: () => ({ worktreePath: "/wt", branch: "shepherd/x", isolated: true }),
      ensureBaseRef: async () => {},
      branchExists: () => false,
      remove: () => {},
    } as any,
    herdr: {
      start: () => ({
        terminalId: "term_x",
        cwd: "/wt",
        agent: "claude",
        agentStatus: "working",
        paneId: "p",
        tabId: "t",
        workspaceId: "w",
      }),
      list: () => [],
      stop: () => {},
      send: () => {},
    } as any,
    events,
  });
  const usageLimits = {
    limits: () => ({
      session5h: null,
      week: null,
      credits: null,
      stale: true,
      calibratedAt: null,
      subscriptionOnly: false,
    }),
    projections: () => [],
  };
  const distiller = { distillNow: () => {} };
  return { store, service, events, usageLimits, distiller };
}

function getRepoConfig(app: ReturnType<typeof makeApp>, repo: string) {
  return app.fetch(
    new Request(`http://x/api/repo-config?repo=${encodeURIComponent(repo)}`, {
      headers: { Origin: "http://localhost:7330" },
    }),
  );
}

function putRepoConfig(app: ReturnType<typeof makeApp>, repo: string, body: unknown) {
  return app.fetch(
    new Request(`http://x/api/repo-config?repo=${encodeURIComponent(repo)}`, {
      method: "PUT",
      headers: { "content-type": "application/json", Origin: "http://localhost:7330" },
      body: JSON.stringify(body),
    }),
  );
}

test("GET /api/repo-config returns automationConfirmed and automationRowExists", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  const res = await getRepoConfig(app, validRepo);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toHaveProperty("automationConfirmed");
  expect(body).toHaveProperty("automationRowExists");
});

test("GET /api/repo-config on fresh repo returns automationConfirmed: false, automationRowExists: false", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  const res = await getRepoConfig(app, validRepo);
  const body = await res.json();
  expect(body.automationConfirmed).toBe(false);
  expect(body.automationRowExists).toBe(false);
});

test("PUT /api/repo-config with only { automationConfirmed: true } returns 200", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  const res = await putRepoConfig(app, validRepo, { automationConfirmed: true });
  expect(res.status).toBe(200);
});

test("PUT /api/repo-config with automationConfirmed: true marks the repo as confirmed", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  await putRepoConfig(app, validRepo, { automationConfirmed: true });
  expect(deps.store.isAutomationConfirmed(validRepo)).toBe(true);
});

test("PUT /api/repo-config with automationConfirmed: true does not mutate other fields", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  // First establish a config with criticEnabled: false
  await putRepoConfig(app, validRepo, { criticEnabled: false });
  // Then confirm automation (should not touch criticEnabled)
  await putRepoConfig(app, validRepo, { automationConfirmed: true });
  expect(deps.store.getRepoConfig(validRepo).criticEnabled).toBe(false);
});

test("PUT /api/repo-config returns automationConfirmed and automationRowExists in response", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  const res = await putRepoConfig(app, validRepo, { automationConfirmed: true });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.automationConfirmed).toBe(true);
  expect(body.automationRowExists).toBe(true);
});

test("GET and PUT return the same shape (both include automationConfirmed + automationRowExists)", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  // PUT a toggle
  const putRes = await putRepoConfig(app, validRepo, { criticEnabled: true });
  const putBody = await putRes.json();
  // GET
  const getRes = await getRepoConfig(app, validRepo);
  const getBody = await getRes.json();
  expect(Object.keys(putBody).sort()).toEqual(Object.keys(getBody).sort());
  expect(putBody.automationConfirmed).toBeDefined();
  expect(putBody.automationRowExists).toBeDefined();
  expect(getBody.automationConfirmed).toBeDefined();
  expect(getBody.automationRowExists).toBeDefined();
});

test("routine toggle PUT on already-confirmed repo still reports automationConfirmed: true", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  // Confirm first
  await putRepoConfig(app, validRepo, { automationConfirmed: true });
  // Now toggle some other field
  const res = await putRepoConfig(app, validRepo, { criticEnabled: false });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.automationConfirmed).toBe(true);
});

test("PUT /api/repo-config rejects automationConfirmed: non-boolean", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  const res = await putRepoConfig(app, validRepo, { automationConfirmed: "yes" });
  expect(res.status).toBe(400);
});

test("PUT /api/repo-config automationConfirmed: false alongside a valid toggle is accepted", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  // automationConfirmed: false just means "don't call markAutomationConfirmed" — still valid
  const res = await putRepoConfig(app, validRepo, {
    criticEnabled: true,
    automationConfirmed: false,
  });
  expect(res.status).toBe(200);
  expect(deps.store.isAutomationConfirmed(validRepo)).toBe(false);
});
