import { test, expect } from "bun:test";
import { makeApp, type AppDeps } from "../src/server";
import type { SessionStore } from "../src/store";
import type { SessionService } from "../src/service";
import type { EventHub } from "../src/events";
import type { DiagnosticsService } from "../src/diagnostics";
import type { DiagnosticsSnapshot } from "../src/types";

const SNAPSHOT: DiagnosticsSnapshot = {
  checks: [{ id: "bun", state: "ok", hintKey: "diagnostics_hint_bun_ok" }],
  generatedAt: 1,
  overall: "ok",
};

// AppDeps with an injectable diagnostics.fix + an events spy.
function deps(
  fix: DiagnosticsService["fix"],
  events: { emit: (e: string, p: unknown) => void } = { emit: () => {} },
): AppDeps {
  return {
    store: {} as SessionStore,
    service: {} as SessionService,
    events: events as unknown as EventHub,
    usageLimits: { limits: () => ({}) } as never,
    diagnostics: {
      current: async () => SNAPSHOT,
      check: async () => SNAPSHOT,
      fix,
    } as Pick<DiagnosticsService, "current" | "check" | "fix">,
  };
}

function postFix(body: unknown): Request {
  return new Request("http://localhost/api/diagnostics/fix", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("POST /api/diagnostics/fix runs the fix, emits diagnostics:status, returns the snapshot", async () => {
  let fixedId = "";
  const emitted: Array<{ e: string; p: unknown }> = [];
  const app = makeApp(
    deps(
      async (id) => {
        fixedId = id;
        return SNAPSHOT;
      },
      { emit: (e, p) => emitted.push({ e, p }) },
    ),
  );
  const res = await app.fetch(postFix({ checkId: "bun" }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(SNAPSHOT);
  expect(fixedId).toBe("bun");
  expect(emitted).toEqual([{ e: "diagnostics:status", p: SNAPSHOT }]);
});

test("POST /api/diagnostics/fix → 400 on missing checkId", async () => {
  const app = makeApp(deps(async () => SNAPSHOT));
  const res = await app.fetch(postFix({}));
  expect(res.status).toBe(400);
});

test("POST /api/diagnostics/fix → 409 for an unknown / guidance-only check", async () => {
  const app = makeApp(
    deps(async () => {
      throw new Error("no remediation for tailscale");
    }),
  );
  const res = await app.fetch(postFix({ checkId: "tailscale" }));
  expect(res.status).toBe(409);
});

test("POST /api/diagnostics/fix → 502 (never 2xx) when the command fails", async () => {
  let emitted = 0;
  const app = makeApp(
    deps(
      async () => {
        throw new Error("remediation exited 1");
      },
      { emit: () => emitted++ },
    ),
  );
  const res = await app.fetch(postFix({ checkId: "bun" }));
  expect(res.status).toBe(502);
  expect((await res.json()).error).toBe("remediation failed");
  expect(emitted).toBe(0); // no status push on failure
});

test("GET /api/diagnostics/fix → 405", async () => {
  const app = makeApp(deps(async () => SNAPSHOT));
  const res = await app.fetch(new Request("http://localhost/api/diagnostics/fix"));
  expect(res.status).toBe(405);
});

test("POST /api/diagnostics/fix → 503 when diagnostics is unwired", async () => {
  const base = deps(async () => SNAPSHOT);
  delete (base as { diagnostics?: unknown }).diagnostics;
  const app = makeApp(base);
  const res = await app.fetch(postFix({ checkId: "bun" }));
  expect(res.status).toBe(503);
});
