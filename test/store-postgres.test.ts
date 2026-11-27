import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/store";

test("postgresMode defaults off, persists, and survives writes that omit it", () => {
  const store = new SessionStore(":memory:");
  expect(store.getLocalRepoConfig("/r").postgresMode).toBe("off");
  store.setRepoConfig("/r", { ...store.getLocalRepoConfig("/r"), postgresMode: "on-request" });
  expect(store.getLocalRepoConfig("/r").postgresMode).toBe("on-request");
  const rest = { ...store.getLocalRepoConfig("/r"), criticEnabled: false };
  delete rest.postgresMode;
  store.setRepoConfig("/r", rest);
  expect(store.getLocalRepoConfig("/r").postgresMode).toBe("on-request");
  expect(store.getLocalRepoConfig("/r").criticEnabled).toBe(false);
});

test("auto round-trips; postgresRepoModes lists on-request and auto repos with their mode", () => {
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/a", { ...store.getLocalRepoConfig("/a"), postgresMode: "auto" });
  store.setRepoConfig("/b", { ...store.getLocalRepoConfig("/b"), postgresMode: "on-request" });
  store.setRepoConfig("/c", { ...store.getLocalRepoConfig("/c"), postgresMode: "off" });
  expect(store.getLocalRepoConfig("/a").postgresMode).toBe("auto");
  expect(store.getRepoConfig("/a").postgresMode).toBe("auto");
  expect(Object.fromEntries(store.postgresRepoModes())).toEqual({
    "/a": "auto",
    "/b": "on-request",
  });
});

test("postgres leases: upsert, state, list, delete", () => {
  const store = new SessionStore(":memory:");
  expect(store.getPostgresLease("s1")).toBeNull();
  store.upsertPostgresLease({ sessionId: "s1", repoPath: "/r", db: "s_a", role: "r_x" });
  store.upsertPostgresLease({ sessionId: "s2", repoPath: "/r", db: "s_b", role: "r_x" });
  expect(store.getPostgresLease("s1")).toMatchObject({ db: "s_a", state: "active" });
  store.setPostgresLeaseState("s1", "dropping");
  expect(store.getPostgresLease("s1")?.state).toBe("dropping");
  store.upsertPostgresLease({ sessionId: "s1", repoPath: "/r", db: "s_a", role: "r_x" });
  expect(store.getPostgresLease("s1")?.state).toBe("active");
  expect(store.listPostgresLeases().map((l) => l.sessionId)).toEqual(["s1", "s2"]);
  store.deletePostgresLease("s1");
  expect(store.listPostgresLeases().map((l) => l.sessionId)).toEqual(["s2"]);
});

test("postgres leases (#4270): new leases start unverified; existing rows migrate verified", () => {
  const dir = mkdtempSync(join(tmpdir(), "pg-lease-"));
  const path = join(dir, "s.db");
  try {
    const legacy = new Database(path);
    legacy.run(`CREATE TABLE postgres_leases (
      sessionId TEXT PRIMARY KEY, repoPath TEXT NOT NULL, db TEXT NOT NULL, role TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active', createdAt INTEGER NOT NULL)`);
    legacy.run(`INSERT INTO postgres_leases VALUES ('old', '/r', 's_o', 'r_x', 'active', 1)`);
    legacy.close();
    const store = new SessionStore(path);
    expect(store.getPostgresLease("old")?.roleVerified).toBe(1);
    store.upsertPostgresLease({ sessionId: "new", repoPath: "/r", db: "s_n", role: "r_x" });
    expect(store.getPostgresLease("new")?.roleVerified).toBe(0);
    store.markPostgresRoleVerified("new");
    store.upsertPostgresLease({ sessionId: "new", repoPath: "/r", db: "s_n", role: "r_x" });
    expect(store.getPostgresLease("new")?.roleVerified).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("postgresBypassRls defaults off, persists, and survives writes that omit it", () => {
  const store = new SessionStore(":memory:");
  expect(store.getLocalRepoConfig("/r").postgresBypassRls).toBe(false);
  expect(store.postgresBypassRls("/r")).toBe(false);
  store.setRepoConfig("/r", { ...store.getLocalRepoConfig("/r"), postgresBypassRls: true });
  expect(store.postgresBypassRls("/r")).toBe(true);
  expect(store.getRepoConfig("/r").postgresBypassRls).toBe(true);
  const rest = { ...store.getLocalRepoConfig("/r"), criticEnabled: false };
  delete rest.postgresBypassRls;
  store.setRepoConfig("/r", rest);
  expect(store.postgresBypassRls("/r")).toBe(true);
});
