import { test, expect } from "bun:test";
import { RestartService, buildRestartScript, type RestartDeps } from "../src/restart";

/** Service that IS the systemd unit (matching invocation ids) with an
 *  injectable launch + clock; overrides let each test break one leg. */
function makeService(overrides: RestartDeps = {}) {
  const launched: string[] = [];
  const svc = new RestartService({
    ownInvocationId: () => "abc-123",
    unitInvocationId: () => "abc-123\n",
    launch: (script) => launched.push(script),
    now: () => 1_000_000,
    ...overrides,
  });
  return { svc, launched };
}

test("plain restart: launches the systemctl-only script", () => {
  const { svc, launched } = makeService();
  expect(svc.apply({ herdr: false })).toEqual({ started: true });
  expect(launched).toHaveLength(1);
  expect(launched[0]).toBe("systemctl --user restart 'shepherd'");
});

test("herdr restart: live-handoff runs BEFORE the shepherd restart", () => {
  const { svc, launched } = makeService();
  expect(svc.apply({ herdr: true }).started).toBe(true);
  const lines = launched[0]!.split("\n");
  expect(lines[0]).toBe("herdr server live-handoff || true");
  expect(lines[1]).toBe("systemctl --user restart 'shepherd'");
});

test("no own INVOCATION_ID (dev worktree) → not_systemd, nothing launched", () => {
  const { svc, launched } = makeService({ ownInvocationId: () => undefined });
  expect(svc.apply({ herdr: false })).toEqual({ started: false, error: "not_systemd" });
  expect(launched).toHaveLength(0);
});

test("foreign INVOCATION_ID (child of another unit) → not_systemd", () => {
  const { svc, launched } = makeService({ ownInvocationId: () => "other-unit-id" });
  expect(svc.apply({ herdr: false }).error).toBe("not_systemd");
  expect(launched).toHaveLength(0);
});

test("systemctl show failing (no systemd at all) → not_systemd, not a throw", () => {
  const { svc } = makeService({
    unitInvocationId: () => {
      throw new Error("System has not been booted with systemd");
    },
  });
  expect(svc.apply({ herdr: false })).toEqual({ started: false, error: "not_systemd" });
});

test("double-click inside the relaunch window → already_restarting", () => {
  const { svc, launched } = makeService();
  expect(svc.apply({ herdr: false }).started).toBe(true);
  expect(svc.apply({ herdr: false })).toEqual({ started: false, error: "already_restarting" });
  expect(launched).toHaveLength(1);
});

test("relaunch window self-clears: a restart that never killed us can be retried", () => {
  let now = 1_000_000;
  const { svc, launched } = makeService({ now: () => now });
  expect(svc.apply({ herdr: false }).started).toBe(true);
  now += 61_000; // past RELAUNCH_WINDOW_MS
  expect(svc.apply({ herdr: false }).started).toBe(true);
  expect(launched).toHaveLength(2);
});

test("launcher failure surfaces its message and does NOT arm the debounce", () => {
  let fail = true;
  const { svc, launched } = makeService({
    launch: (script) => {
      if (fail) throw new Error("systemd-run missing");
      launched.push(script);
    },
  });
  expect(svc.apply({ herdr: false })).toEqual({ started: false, error: "systemd-run missing" });
  fail = false;
  // an immediate retry must work — the failed launch must not count as "restarting"
  expect(svc.apply({ herdr: false }).started).toBe(true);
});

test("buildRestartScript omits herdr line unless asked", () => {
  expect(buildRestartScript({ herdr: false })).not.toContain("herdr");
  expect(buildRestartScript({ herdr: true })).toContain("herdr server live-handoff");
});
