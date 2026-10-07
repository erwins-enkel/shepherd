/** Operator side of a Login Request (#2882): bootstrap snapshot + Done/Cancel resolve route. */
import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { makeApp, slowRequestTimeoutSec, type AppDeps } from "../src/server";
import { EventHub } from "../src/events";
import { LoginRequestService } from "../src/login-request";

function setup() {
  const events = new EventHub();
  const loginRequests = new LoginRequestService({ events });
  const deps = {
    store: new SessionStore(":memory:"),
    events,
    service: {} as unknown,
    loginRequests,
  } as unknown as AppDeps;
  const app = makeApp(deps);
  const resolve = (id: string, body: unknown) =>
    app.fetch(
      new Request(`http://x/api/sessions/${id}/login-request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  return { app, loginRequests, resolve };
}

test("GET /api/login-requests lists the open requests by session", async () => {
  const { app, loginRequests } = setup();
  loginRequests.request("s1", "https://a.example/login", "need it");
  const res = await app.fetch(new Request("http://x/api/login-requests"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    s1: expect.objectContaining({ url: "https://a.example/login", reason: "need it" }),
  });
});

test("POST …/login-request resolves the open request", async () => {
  const { loginRequests, resolve } = setup();
  const opened = loginRequests.request("s1", "https://a.example/login", "need it");
  if (opened.status !== "open") throw new Error("expected open");
  const waiting = loginRequests.wait("s1", opened.request.id, 10_000);
  const res = await resolve("s1", { outcome: "done" });
  expect(res.status).toBe(200);
  expect(await waiting).toBe("done");
  expect(loginRequests.get("s1")).toBeNull();
});

test("POST …/login-request rejects a bad outcome and a session with no request", async () => {
  const { loginRequests, resolve } = setup();
  loginRequests.request("s1", "https://a.example/login", "need it");
  expect((await resolve("s1", { outcome: "maybe" })).status).toBe(400);
  expect((await resolve("s2", { outcome: "cancelled" })).status).toBe(404);
  expect(loginRequests.get("s1")).not.toBeNull();
});

test("the MCP endpoint gets a 60s idle budget for the login long-poll", () => {
  const url = new URL("http://x/api/sessions/abc/mcp");
  expect(slowRequestTimeoutSec(new Request(url, { method: "POST" }), url)).toBe(60);
});
