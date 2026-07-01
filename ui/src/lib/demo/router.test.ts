import { describe, it, expect, beforeEach } from "vitest";
import { handleApi } from "./router";
import { demoState } from "./state";

const REPO = "/demo/acme/storefront";
const u = (path: string) => new URL(path, "http://localhost");

async function get(path: string) {
  const r = await handleApi("GET", u(path), undefined);
  return { status: r.status, body: await r.json() };
}

beforeEach(() => demoState.reset());

describe("polished GET handlers return the shape api.ts consumes", () => {
  it("/api/me authenticates", async () => {
    expect(await get("/api/me")).toEqual({ status: 200, body: { authenticated: true } });
  });

  it("/api/sessions returns the session array", async () => {
    const { status, body } = await get("/api/sessions");
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });

  it("/api/usage/limits wraps limits + projections (caller reads r.limits)", async () => {
    const { body } = await get("/api/usage/limits");
    expect(body.limits).toBeDefined();
    expect(body.limits.session5h).not.toBeNull();
    expect(Array.isArray(body.projections)).toBe(true);
  });

  it("/api/plugins wraps the array under {plugins}", async () => {
    const { body } = await get("/api/plugins");
    expect(Array.isArray(body.plugins)).toBe(true);
    expect(body.plugins.length).toBeGreaterThan(0);
  });

  it("map-shaped bootstrap GETs return keyed objects", async () => {
    for (const p of ["/api/git", "/api/activity", "/api/holds", "/api/subagents", "/api/queues"]) {
      const { status, body } = await get(p);
      expect(status).toBe(200);
      expect(Object.keys(body).length).toBeGreaterThan(0);
    }
  });

  it("array-shaped bootstrap GETs are non-empty", async () => {
    for (const p of ["/api/drain", "/api/automerge", "/api/epics/completed", "/api/steers"]) {
      const { status, body } = await get(p);
      expect(status).toBe(200);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThan(0);
    }
  });

  it("inflight lens GETs return empty arrays", async () => {
    expect((await get("/api/reviews/inflight")).body).toEqual([]);
    expect((await get("/api/plan-gates/inflight")).body).toEqual([]);
  });

  it("/api/epics returns {epics, subIssues}; /api/epic returns one Epic", async () => {
    const list = await get(`/api/epics?repo=${encodeURIComponent(REPO)}`);
    expect(Array.isArray(list.body.epics)).toBe(true);
    expect(Array.isArray(list.body.subIssues)).toBe(true);
    const one = await get(`/api/epic?repo=${encodeURIComponent(REPO)}&parent=100`);
    expect(one.body.parentIssueNumber).toBe(100);
  });

  it("GET /api/sessions/clear-merged returns the merged, non-archived ids (deps)", async () => {
    const { status, body } = await get("/api/sessions/clear-merged");
    expect(status).toBe(200);
    expect(body).toEqual({ ids: ["deps"], leftovers: 0 });
  });

  it("the rich scenario seeds seven sessions across two repos", async () => {
    const { body } = await get("/api/sessions");
    expect(body).toHaveLength(7);
    expect(body.map((s: { id: string }) => s.id).sort()).toEqual(
      ["authstore", "checkout-child", "coupon", "deps", "neon", "ogimg", "rounding"].sort(),
    );
    expect(new Set(body.map((s: { repoPath: string }) => s.repoPath))).toEqual(
      new Set(["/demo/acme/storefront", "/demo/acme/api"]),
    );
  });

  it("unknown GET falls through to a benign empty object", async () => {
    expect(await get("/api/nonexistent-thing")).toEqual({ status: 200, body: {} });
  });
});

describe("mutation handlers call the mutator and return the caller's shape", () => {
  it("POST reply → 200 {}", async () => {
    const r = await handleApi("POST", u("/api/sessions/coupon/reply"), { text: "go" });
    expect(r.status).toBe(200);
    expect(demoState.sessions().find((s) => s.id === "coupon")?.status).toBe("running");
  });

  it("POST /go releases the approved plan gate → {ok:true}", async () => {
    const r = await handleApi("POST", u("/api/sessions/authstore/go"), undefined);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(demoState.sessions().find((s) => s.id === "authstore")?.planPhase).toBe("executing");
  });

  it("POST git/merge returns a PrStatus", async () => {
    const r = await handleApi("POST", u("/api/sessions/rounding/git/merge"), {});
    const body = await r.json();
    expect(body).toHaveProperty("state");
    expect(body).toHaveProperty("checks");
  });

  it("POST /api/sessions/clear-merged with no ids clears nothing", async () => {
    const r = await handleApi("POST", u("/api/sessions/clear-merged"), { ids: [] });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ cleared: [], leftovers: 0 });
  });

  it("POST /api/sessions/clear-merged archives the merged session and it disappears", async () => {
    const r = await handleApi("POST", u("/api/sessions/clear-merged"), { ids: ["deps"] });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ cleared: ["deps"], leftovers: 0 });
    expect(demoState.sessions().find((s) => s.id === "deps")).toBeUndefined();
    // re-querying the clearable set now returns none — deps is gone, not re-offered.
    expect((await get("/api/sessions/clear-merged")).body).toEqual({ ids: [], leftovers: 0 });
  });

  it("POST /api/sessions/clear-merged ignores an id that isn't actually merged", async () => {
    const r = await handleApi("POST", u("/api/sessions/clear-merged"), { ids: ["coupon"] });
    expect(await r.json()).toEqual({ cleared: [], leftovers: 0 });
    expect(demoState.sessions().find((s) => s.id === "coupon")).toBeDefined();
  });

  it("POST epic/approve-next returns the updated Epic", async () => {
    const r = await handleApi(
      "POST",
      u(`/api/epic/approve-next?repo=${encodeURIComponent(REPO)}&parent=100`),
      undefined,
    );
    const body = await r.json();
    expect(body.parentIssueNumber).toBe(100);
  });

  it("POST held/:id/spawn returns the new Session", async () => {
    const before = demoState.held().length;
    const heldId = demoState.held()[0].id;
    const r = await handleApi("POST", u(`/api/held/${heldId}/spawn`), undefined);
    const body = await r.json();
    expect(body).toHaveProperty("id");
    expect(demoState.held().length).toBe(before - 1);
  });

  it("DELETE /api/sessions/:id archives", async () => {
    const r = await handleApi("DELETE", u("/api/sessions/coupon"), undefined);
    expect(r.status).toBe(200);
    expect(demoState.sessions().find((s) => s.id === "coupon")).toBeUndefined();
  });

  it("unknown mutation falls through to {ok:true}", async () => {
    const r = await handleApi("POST", u("/api/some/off-screen/thing"), undefined);
    expect(await r.json()).toEqual({ ok: true });
  });

  it("handleApi never throws on a malformed request", async () => {
    const r = await handleApi("GET", u("/api/sessions"), undefined);
    expect(r.status).toBe(200);
  });
});
