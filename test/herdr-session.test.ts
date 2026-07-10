import { test, expect } from "bun:test";
import { resolveHerdrSocket, applyHerdrSocket } from "../src/herdr-session";

const HOME = "/home/u";
const DEFAULT_SOCK = `${HOME}/.config/herdr/herdr.sock`;
const sessSock = (name: string) => `${HOME}/.config/herdr/sessions/${name}/herdr.sock`;

// ── resolveHerdrSocket: pure precedence ──────────────────────────────────────

test("no pane, explicit HERDR_SOCKET_PATH → honored, no conflict", () => {
  const r = resolveHerdrSocket({ HERDR_SOCKET_PATH: "/custom/x.sock" }, HOME);
  expect(r.socketPath).toBe("/custom/x.sock");
  expect(r.conflict).toBeNull();
  expect(r.session).toBe("default");
});

test("no pane, non-default HERDR_SESSION, no socket → session-derived, no conflict", () => {
  const r = resolveHerdrSocket({ HERDR_SESSION: "s1567" }, HOME);
  expect(r.socketPath).toBe(sessSock("s1567"));
  expect(r.conflict).toBeNull();
});

test("pane, HERDR_SESSION unset/default, inherited socket → inherited used, no conflict", () => {
  const r = resolveHerdrSocket({ HERDR_ENV: "1", HERDR_SOCKET_PATH: DEFAULT_SOCK }, HOME);
  expect(r.socketPath).toBe(DEFAULT_SOCK);
  expect(r.conflict).toBeNull();
});

test("pane, non-default HERDR_SESSION, inherited socket DISAGREES → session-derived, conflict", () => {
  const r = resolveHerdrSocket(
    { HERDR_ENV: "1", HERDR_SESSION: "s1567", HERDR_SOCKET_PATH: DEFAULT_SOCK },
    HOME,
  );
  expect(r.socketPath).toBe(sessSock("s1567"));
  expect(r.conflict).toEqual({
    session: "s1567",
    inheritedPath: DEFAULT_SOCK,
    sessionPath: sessSock("s1567"),
  });
});

test("pane, non-default HERDR_SESSION, inherited socket EQUALS session path → no conflict", () => {
  const r = resolveHerdrSocket(
    { HERDR_ENV: "1", HERDR_SESSION: "s1567", HERDR_SOCKET_PATH: sessSock("s1567") },
    HOME,
  );
  expect(r.socketPath).toBe(sessSock("s1567"));
  expect(r.conflict).toBeNull();
});

test("pane, non-default HERDR_SESSION, no inherited socket → session-derived, no conflict", () => {
  const r = resolveHerdrSocket({ HERDR_ENV: "1", HERDR_SESSION: "s1567" }, HOME);
  expect(r.socketPath).toBe(sessSock("s1567"));
  expect(r.conflict).toBeNull();
});

test("no pane (HERDR_ENV unset), non-default HERDR_SESSION + explicit socket → honored, no conflict", () => {
  const r = resolveHerdrSocket(
    { HERDR_SESSION: "s1567", HERDR_SOCKET_PATH: "/custom/x.sock" },
    HOME,
  );
  expect(r.socketPath).toBe("/custom/x.sock");
  expect(r.conflict).toBeNull();
});

test("SHEPHERD_HERDR_IGNORE_SESSION=1 on the disagreeing-pane case → inherited honored, no conflict", () => {
  const r = resolveHerdrSocket(
    {
      HERDR_ENV: "1",
      HERDR_SESSION: "s1567",
      HERDR_SOCKET_PATH: DEFAULT_SOCK,
      SHEPHERD_HERDR_IGNORE_SESSION: "1",
    },
    HOME,
  );
  expect(r.socketPath).toBe(DEFAULT_SOCK);
  expect(r.conflict).toBeNull();
});

// ── applyHerdrSocket: the load-bearing process.env side effect (CLI-path fix) ──

test("conflict: rewrites env.HERDR_SOCKET_PATH to the session socket and warns once", () => {
  const env: Record<string, string | undefined> = {
    HERDR_ENV: "1",
    HERDR_SESSION: "s1567",
    HERDR_SOCKET_PATH: DEFAULT_SOCK,
  };
  const logs: string[] = [];
  const r = applyHerdrSocket(env, HOME, (m) => logs.push(m));

  expect(r.socketPath).toBe(sessSock("s1567"));
  expect(env.HERDR_SOCKET_PATH).toBe(sessSock("s1567")); // <- spawned herdr CLI now agrees
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("s1567");
});

test("no conflict: env is left untouched and log is not called", () => {
  const env: Record<string, string | undefined> = {
    HERDR_ENV: "1",
    HERDR_SOCKET_PATH: DEFAULT_SOCK,
  };
  const logs: string[] = [];
  applyHerdrSocket(env, HOME, (m) => logs.push(m));

  expect(env.HERDR_SOCKET_PATH).toBe(DEFAULT_SOCK);
  expect(logs).toHaveLength(0);
});
