import { test, expect } from "bun:test";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import type { HerdDigest } from "../src/types";

function harness(over: Partial<AppDeps> = {}): ReturnType<typeof makeApp> {
  const deps: AppDeps = {
    store: new SessionStore(":memory:"),
    service: {} as any,
    events: new EventHub(),
    usageLimits: { limits: () => ({}) } as any,
    ...over,
  };
  return makeApp(deps);
}

function mkDigest(over: Partial<HerdDigest> = {}): HerdDigest {
  return {
    dayKey: "2026-06-15",
    state: "ready",
    overnight: "two PRs merged overnight",
    decisions: [{ label: "answer the autopilot question on TASK-07", sessionId: "s1" }],
    ciRework: [],
    train: "queue idle",
    focusNext: [],
    attentionFingerprint: { s1: ["blocked-decision"], s2: ["in-flight"] },
    spawnSessionId: "spawn-1",
    cwd: "/tmp/rundown-xyz",
    model: "sonnet",
    spawnedAt: 900,
    generatedAt: 1000,
    updatedAt: 1000,
    ...over,
  };
}

// ── GET /api/herd/digest ────────────────────────────────────────────────────────

test("GET /api/herd/digest → null when no digest exists", async () => {
  const app = harness({
    herdDigest: {
      snapshot: () => null,
      currentFingerprint: () => ({}),
      regenerate: async () => "started",
    },
  });
  const res = await app.fetch(new Request("http://x/api/herd/digest"));
  expect(res.status).toBe(200);
  expect(await res.json()).toBeNull();
});

test("GET /api/herd/digest → null when herdDigest dep is absent", async () => {
  const app = harness();
  const res = await app.fetch(new Request("http://x/api/herd/digest"));
  expect(res.status).toBe(200);
  expect(await res.json()).toBeNull();
});

test("GET /api/herd/digest → returns the digest with staleCount 0 when the herd is unchanged", async () => {
  const digest = mkDigest();
  const app = harness({
    herdDigest: {
      snapshot: () => digest,
      // identical fingerprint → no drift
      currentFingerprint: () => ({ s1: ["blocked-decision"], s2: ["in-flight"] }),
      regenerate: async () => "started",
    },
  });
  const res = await app.fetch(new Request("http://x/api/herd/digest"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as HerdDigest;
  expect(body.dayKey).toBe("2026-06-15");
  expect(body.decisions).toEqual(digest.decisions);
  expect(body.staleCount).toBe(0);
});

test("GET /api/herd/digest → staleCount reflects drift (a session went CI-red, another cleared)", async () => {
  const digest = mkDigest({
    attentionFingerprint: { s1: ["blocked-decision"], s2: ["in-flight"] },
  });
  const app = harness({
    herdDigest: {
      snapshot: () => digest,
      // s1 added a ci-red signal; s2 dropped out (its bottleneck cleared)
      currentFingerprint: () => ({ s1: ["blocked-decision", "ci-red"] }),
      regenerate: async () => "started",
    },
  });
  const res = await app.fetch(new Request("http://x/api/herd/digest"));
  const body = (await res.json()) as HerdDigest;
  // s1 changed (1) + s2 removed (1) = 2
  expect(body.staleCount).toBe(2);
});

// ── POST /api/herd/digest/regenerate ──────────────────────────────────────────────

test("POST /api/herd/digest/regenerate → 202 and triggers the service", async () => {
  let called = 0;
  const app = harness({
    herdDigest: {
      snapshot: () => null,
      currentFingerprint: () => ({}),
      regenerate: async () => {
        called++;
        return "started" as const;
      },
    },
  });
  const res = await app.fetch(
    new Request("http://x/api/herd/digest/regenerate", { method: "POST" }),
  );
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ ok: true, status: "started" });
  expect(called).toBe(1);
});

test("POST /api/herd/digest/regenerate → 202 status:error when herdDigest dep is absent", async () => {
  const app = harness();
  const res = await app.fetch(
    new Request("http://x/api/herd/digest/regenerate", { method: "POST" }),
  );
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ ok: true, status: "error" });
});
