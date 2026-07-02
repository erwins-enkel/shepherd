import { test, expect, afterEach } from "bun:test";
import { SessionStore } from "../src/store";
import { SessionService } from "../src/service";
import { EventHub } from "../src/events";
import { makeApp, type AppDeps } from "../src/server";
import { config } from "../src/config";

// Minimal deps — /api/ping is a pure liveness probe and touches no repo/session state.
function makeDeps(): AppDeps {
  const store = new SessionStore(":memory:");
  const events = new EventHub();
  const service = new SessionService({
    store,
    namer: async () => "x",
    worktree: {
      create: () => ({ worktreePath: "/wt", branch: "shepherd/x", isolated: true }),
      remove: () => {},
    } as any,
    herdr: { start: () => ({}), list: () => [], stop: () => {}, send: () => {} } as any,
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
  return { store, service, events, usageLimits, distiller: { distillNow: () => {} } };
}

const harness = () => makeApp(makeDeps());

function ping(app: ReturnType<typeof makeApp>, headers?: HeadersInit) {
  return app.fetch(new Request("http://x/api/ping", { method: "POST", headers }));
}

// Restore any config we mutate so tests stay isolated.
const origToken = config.token;
afterEach(() => {
  config.token = origToken;
});

test("POST /api/ping with allowlisted Origin → 200 {ok:true}", async () => {
  // A real allowlisted Origin — not omitted — so we actually exercise the allowlist
  // rather than the no-browser bypass (validate.ts originAllowed).
  const res = await ping(harness(), { Origin: "http://localhost:7330" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

test("POST /api/ping with disallowed Origin → 403", async () => {
  const res = await ping(harness(), { Origin: "chrome-extension://not-allowed" });
  expect(res.status).toBe(403);
});

test("POST /api/ping with bad token → 401 (before origin check)", async () => {
  config.token = "secret-token";
  // Bad token + allowlisted origin still 401: checkAuth runs before checkOrigin.
  const res = await ping(harness(), {
    Origin: "http://localhost:7330",
    Authorization: "Bearer wrong",
  });
  expect(res.status).toBe(401);
});

test("POST /api/ping with valid token + allowlisted Origin → 200", async () => {
  config.token = "secret-token";
  const res = await ping(harness(), {
    Origin: "http://localhost:7330",
    Authorization: "Bearer secret-token",
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});
