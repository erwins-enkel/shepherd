import { expect, test } from "bun:test";
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
