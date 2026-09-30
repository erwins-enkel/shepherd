import { test, expect } from "bun:test";
import { makeApp, type AppDeps } from "../src/server";
import type { SessionStore } from "../src/store";
import type { SessionService } from "../src/service";
import type { EventHub } from "../src/events";

// POST /api/sessions/:id/review-hold and /review-cancel — the review banner's hold/cancel actions.

function app(reviewControl?: AppDeps["reviewControl"]) {
  const deps: AppDeps = {
    store: { get: () => null, getRepoConfig: () => ({}) as any } as unknown as SessionStore,
    service: {} as SessionService,
    events: { emit: () => {} } as unknown as EventHub,
    usageLimits: { limits: () => ({}) } as never,
    reviewControl,
  };
  return makeApp(deps);
}

function post(path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: "http://localhost" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const control = (
  over: Partial<NonNullable<AppDeps["reviewControl"]>> = {},
): NonNullable<AppDeps["reviewControl"]> => ({
  hold: () => "critic",
  cancel: async () => ({ kind: "critic", status: "cancelled" }),
  ...over,
});

test("review-hold → 200 with the kind it acted on", async () => {
  const calls: [string, boolean][] = [];
  const res = await app(
    control({
      hold: (id, held) => {
        calls.push([id, held]);
        return "plangate";
      },
    }),
  ).fetch(post("/api/sessions/s1/review-hold", { held: true }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, held: true, kind: "plangate" });
  expect(calls).toEqual([["s1", true]]);
});

test("review-hold → 400 for a malformed body", async () => {
  const res = await app(control()).fetch(post("/api/sessions/s1/review-hold", { held: "yes" }));
  expect(res.status).toBe(400);
});

test("review-hold → 409 when no review is in flight", async () => {
  const res = await app(control({ hold: () => null })).fetch(
    post("/api/sessions/s1/review-hold", { held: false }),
  );
  expect(res.status).toBe(409);
  expect((await res.json()).error).toBe("no review in flight");
});

test("review-cancel → 200 when cancelled", async () => {
  const res = await app(control()).fetch(post("/api/sessions/s1/review-cancel"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, status: "cancelled", kind: "critic" });
});

test("review-cancel → 409 when nothing is in flight or it is finalizing", async () => {
  const none = await app(
    control({ cancel: async () => ({ kind: "plangate", status: "none" }) }),
  ).fetch(post("/api/sessions/s1/review-cancel"));
  expect(none.status).toBe(409);
  expect((await none.json()).error).toBe("no review in flight");
  const busy = await app(
    control({ cancel: async () => ({ kind: "critic", status: "skipped" }) }),
  ).fetch(post("/api/sessions/s1/review-cancel"));
  expect(busy.status).toBe(409);
  expect((await busy.json()).error).toBe("review is finalizing");
});

test("review routes → 409 when review control is not wired", async () => {
  expect((await app().fetch(post("/api/sessions/s1/review-cancel"))).status).toBe(409);
  expect((await app().fetch(post("/api/sessions/s1/review-hold", { held: true }))).status).toBe(
    409,
  );
});
