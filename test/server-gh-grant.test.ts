/** Operator side of a gh permission request (#4119): snapshot, Grant/Deny answer, revoke. */
import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { makeApp, type AppDeps } from "../src/server";
import { EventHub } from "../src/events";
import { GhPermissionRequestService, type GhGrantResult } from "../src/gh-grant";

function setup(grantResult: GhGrantResult = { ok: true }) {
  const events = new EventHub();
  const ghPermissionRequests = new GhPermissionRequestService({ events });
  const calls: [string, string, string, string][] = [];
  const ghGrants = {
    grant: async (id: string, p: string, actor: string) => (
      calls.push(["grant", id, p, actor]),
      grantResult
    ),
    revoke: async (id: string, p: string, actor: string) => (
      calls.push(["revoke", id, p, actor]),
      grantResult
    ),
  };
  const deps = {
    store: new SessionStore(":memory:"),
    events,
    service: {} as unknown,
    ghPermissionRequests,
    ghGrants,
  } as unknown as AppDeps;
  const app = makeApp(deps);
  const answer = (id: string, body: unknown) =>
    app.fetch(
      new Request(`http://x/api/sessions/${id}/gh-permission-request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const revoke = (id: string, permission: string) =>
    app.fetch(
      new Request(`http://x/api/sessions/${id}/gh-grants/${permission}`, { method: "DELETE" }),
    );
  return { app, ghPermissionRequests, calls, answer, revoke };
}

test("GET /api/gh-permission-requests lists the open requests by session", async () => {
  const { app, ghPermissionRequests } = setup();
  ghPermissionRequests.request("s1", "workflows", "ci fix", [".github/workflows/ci.yml"]);
  const res = await app.fetch(new Request("http://x/api/gh-permission-requests"));
  expect(await res.json()).toEqual({
    s1: expect.objectContaining({ permission: "workflows", reason: "ci fix" }),
  });
});

test("Grant goes through the grant service as the operator; Deny resolves the request", async () => {
  const { ghPermissionRequests, calls, answer } = setup();
  ghPermissionRequests.request("s1", "workflows", "ci fix", []);
  expect((await answer("s1", { outcome: "granted" })).status).toBe(200);
  expect(calls).toEqual([["grant", "s1", "workflows", "operator"]]);

  ghPermissionRequests.request("s2", "workflows", "ci fix", []);
  expect((await answer("s2", { outcome: "denied" })).status).toBe(200);
  expect(ghPermissionRequests.get("s2")).toBeNull();
  expect(calls).toHaveLength(1);
});

test("a refused grant passes its status + code through; bad input and no request are refused", async () => {
  const { ghPermissionRequests, answer } = setup({
    ok: false,
    status: 409,
    code: "installation-lacks-permission",
    error: "Grant it on the App installation first.",
  });
  ghPermissionRequests.request("s1", "workflows", "ci fix", []);
  const res = await answer("s1", { outcome: "granted" });
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({
    error: "Grant it on the App installation first.",
    code: "installation-lacks-permission",
  });
  expect((await answer("s1", { outcome: "maybe" })).status).toBe(400);
  expect((await answer("s9", { outcome: "granted" })).status).toBe(404);
});

test("DELETE …/gh-grants/:permission revokes; an unknown permission is a 400", async () => {
  const { calls, revoke } = setup();
  expect((await revoke("s1", "workflows")).status).toBe(200);
  expect(calls).toEqual([["revoke", "s1", "workflows", "operator"]]);
  expect((await revoke("s1", "admin")).status).toBe(400);
});
