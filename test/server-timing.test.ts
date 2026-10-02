import { test, expect, afterEach } from "bun:test";
import { SessionStore } from "../src/store";
import { SessionService } from "../src/service";
import { EventHub } from "../src/events";
import { makeApp, makeAgentIngressApp, type AppDeps } from "../src/server";
import {
  LoopLagWindow,
  LAG_WINDOW_MS,
  serverTimingValue,
  startLoopLagMonitor,
  withServerTiming,
} from "../src/server-timing";

function makeDeps(): AppDeps {
  const store = new SessionStore(":memory:");
  const events = new EventHub();
  const service = new SessionService({
    store,
    namer: async () => "x",
    worktree: {} as any,
    herdr: { list: () => [] } as any,
    events,
  });
  const usageLimits = {
    limits: () => ({
      session5h: null,
      week: null,
      perModelWeek: [],
      credits: null,
      stale: true,
      calibratedAt: null,
      subscriptionOnly: false,
    }),
    projections: () => [],
  };
  return { store, service, events, usageLimits };
}

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
});

test("LoopLagWindow records how late a tick fired and keeps the window max", () => {
  const w = new LoopLagWindow(0, 250);
  w.tick(250); // on time
  expect(w.maxLag(250)).toBe(0);
  w.tick(250 + 250 + 4_000); // fired 4s late
  expect(w.maxLag(4_500)).toBe(4_000);
  w.tick(4_750);
  // still inside the window
  expect(w.maxLag(4_750 + 10_000 - 1)).toBeGreaterThanOrEqual(4_000);
});

test("LoopLagWindow forgets a stall once it leaves the window", () => {
  const w = new LoopLagWindow(0, 250);
  w.tick(3_250); // 3s stall at t≈3s
  let t = 3_250;
  while (t < 3_250 + LAG_WINDOW_MS + 10_000) {
    t += 250;
    w.tick(t);
  }
  expect(w.maxLag(t)).toBe(0);
});

test("LoopLagWindow counts a stall still in progress", () => {
  const w = new LoopLagWindow(0, 250);
  w.tick(250);
  // The overdue timer has not run yet, but 2.25s have passed since the last tick.
  expect(w.maxLag(2_750)).toBe(2_250);
});

test("serverTimingValue formats app and optional lag", () => {
  expect(serverTimingValue(12.345, null)).toBe("app;dur=12.3");
  expect(serverTimingValue(3, 4_200.4)).toBe("app;dur=3.0, lag;dur=4200");
});

test("withServerTiming leaves immutable headers alone", () => {
  const res = Response.redirect("https://example.test/", 302);
  expect(() => withServerTiming(res, 1)).not.toThrow();
});

test("credentialed API responses carry Server-Timing; public probes do not", async () => {
  const app = makeApp(makeDeps());
  const sessions = await app.fetch(new Request("http://localhost/api/sessions"));
  expect(sessions.status).toBe(200);
  expect(sessions.headers.get("Server-Timing")).toMatch(/^app;dur=\d+\.\d(, lag;dur=\d+)?$/);

  const health = await app.fetch(new Request("http://localhost/api/health"));
  expect(health.headers.get("Server-Timing")).toBeNull();

  const missing = await app.fetch(new Request("http://localhost/api/does-not-exist"));
  expect(missing.status).toBe(404);
  expect(missing.headers.get("Server-Timing")).toMatch(/^app;dur=/);
});

test("the lag metric appears once the monitor runs", async () => {
  stop = startLoopLagMonitor();
  const app = makeApp(makeDeps());
  const res = await app.fetch(new Request("http://localhost/api/sessions"));
  expect(res.headers.get("Server-Timing")).toMatch(/^app;dur=\d+\.\d, lag;dur=\d+$/);
});

test("the agent ingress never stamps Server-Timing", async () => {
  const deps = makeDeps();
  const app = makeAgentIngressApp(deps);
  const res = await app.fetch(
    new Request("http://127.0.0.1/api/sessions/00000000-0000-4000-8000-000000000000"),
  );
  expect(res.headers.get("Server-Timing")).toBeNull();
});
