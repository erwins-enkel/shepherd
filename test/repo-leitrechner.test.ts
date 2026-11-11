import { expect, test } from "bun:test";
import { RepoLeitrechnerService } from "../src/repo-leitrechner";

function harness() {
  let id: string | null = null;
  let remote: { name: string; status: string } | null = null;
  let now = 0;
  let calls = 0;
  let failed = false;
  const events: unknown[] = [];
  const svc = new RepoLeitrechnerService({
    config: () => ({ leitrechner: id, repoMode: "forge" }),
    self: () => ({ instanceId: "self", name: "This machine" }),
    remote: () => remote,
    context: () => "common-dir",
    fetch: async () => {
      calls++;
      if (failed) throw new Error("credential-secret");
    },
    now: () => now,
    emit: (repoPath, leitrechnerStatus) => events.push({ repoPath, leitrechnerStatus }),
  });
  return {
    svc,
    events,
    setId: (v: string | null) => {
      id = v;
    },
    setRemote: (v: typeof remote) => {
      remote = v;
    },
    advance: () => {
      now += 30_001;
    },
    fail: (v: boolean) => {
      failed = v;
    },
    calls: () => calls,
  };
}

test("resolution: missing, local, unknown and connected/offline remote IDs", async () => {
  const h = harness();
  expect((await h.svc.refresh("/r")).allowed).toBe(true);
  h.setId("self");
  expect(h.svc.status("/r")).toMatchObject({
    role: "local",
    reachable: true,
    allowed: true,
    name: "This machine",
  });
  h.setId("other");
  expect(h.svc.status("/r")).toMatchObject({ role: "unknown", reachable: null, allowed: true });
  for (const status of [
    "connected",
    "checking",
    "unreachable",
    "unauthorized",
    "incompatible",
    "identity_mismatch",
  ]) {
    h.setRemote({ name: "Other", status });
    expect(h.svc.status("/r")).toMatchObject({
      role: "remote",
      name: "Other",
      reachable: status === "connected",
      allowed: false,
      pauseReason: status === "connected" ? "remote_leitrechner" : "leitrechner_unreachable",
    });
  }
  h.setRemote(null);
  expect(h.svc.status("/r").allowed).toBe(true);
});

test("startup fetch, common-dir coalescing, TTL, sanitized failure and recovery", async () => {
  const h = harness();
  await Promise.all([h.svc.refresh("/r"), h.svc.refresh("/linked")]);
  expect(h.calls()).toBe(1);
  await h.svc.refresh("/r");
  expect(h.calls()).toBe(1);
  h.advance();
  h.fail(true);
  expect(await h.svc.refresh("/r")).toMatchObject({
    allowed: false,
    pauseReason: "config_refresh_failed",
  });
  expect(JSON.stringify(h.events)).not.toContain("credential-secret");
  await h.svc.refresh("/r");
  expect(h.calls()).toBe(2);
  h.fail(false);
  h.advance();
  expect((await h.svc.refresh("/r")).allowed).toBe(true);
});

test("publishes changed names/removal once and invalidates refresh after a config edit", async () => {
  const h = harness();
  h.setId("other");
  h.setRemote({ name: "A", status: "connected" });
  await h.svc.refresh("/r");
  h.svc.publish("/r");
  expect(h.events).toHaveLength(1);
  h.setRemote({ name: "B", status: "unreachable" });
  h.svc.publish("/r");
  expect(h.events).toHaveLength(2);
  h.setRemote(null);
  h.svc.publish("/r");
  expect(h.events).toHaveLength(3);
  h.svc.invalidate("/r");
  await h.svc.refresh("/r");
  expect(h.calls()).toBe(2);
});
