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

// Task 8: the DONE lens threw `sessions.find is not a function` because GET
// /api/sessions/done had no handler and fell through to the permissive `{}` fallback —
// `done.svelte.ts` assigns that straight to a `Session[]` store with no shape check.
describe("GET /api/sessions/done (Done lens) is populated, never the {} fallback", () => {
  it("returns a non-empty Session[], distinct from the live /api/sessions list", async () => {
    const { status, body } = await get("/api/sessions/done");
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    const liveIds = new Set(demoState.sessions().map((s: { id: string }) => s.id));
    for (const s of body as { id: string; archivedAt: number | null }[]) {
      expect(liveIds.has(s.id)).toBe(false); // archived, not part of the live herd
      expect(s.archivedAt).not.toBeNull();
    }
  });

  it("every done session has a matching recap so its row shows content, not recap_unavailable", async () => {
    const done = (await get("/api/sessions/done")).body as { id: string }[];
    const recaps = (await get("/api/recaps")).body as Record<string, unknown>;
    for (const s of done) expect(recaps[s.id]).toBeDefined();
  });
});

// Task 8 sibling audit: every showcased session-detail-tab GET must resolve to the shape
// its api.ts caller + Svelte consumer expect — never the empty-object fallback, which
// throws downstream (`.find`/`.map`/`.length` on a non-array, or `.files.length` /
// `.entries.length` on a property `{}` doesn't have).
describe("session-detail tab GETs never fall back to {}", () => {
  it("GET /api/sessions/:id/activity returns ActivityEntry[] (rich for the hero)", async () => {
    const { status, body } = await get("/api/sessions/coupon/activity");
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    // an unseeded session still gets a valid array, not {}
    expect((await get("/api/sessions/rounding/activity")).body).toEqual([]);
  });

  it("GET /api/sessions/:id/diff returns a DiffResult with a `files` array (rich for the hero)", async () => {
    const { status, body } = await get("/api/sessions/coupon/diff");
    expect(status).toBe(200);
    expect(Array.isArray(body.files)).toBe(true);
    expect(body.files.length).toBeGreaterThan(0);
    // an unseeded session still gets a valid DiffResult, not {} (files would be undefined)
    const empty = await get("/api/sessions/rounding/diff");
    expect(Array.isArray(empty.body.files)).toBe(true);
  });

  it("GET /api/sessions/:id/scratchpad returns a ScratchListing with an `entries` array", async () => {
    const { status, body } = await get("/api/sessions/coupon/scratchpad");
    expect(status).toBe(200);
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.entries.length).toBeGreaterThan(0);
    const empty = await get("/api/sessions/rounding/scratchpad");
    expect(Array.isArray(empty.body.entries)).toBe(true);
  });

  it("GET /api/sessions/:id/usage returns a SessionUsage record, never {}", async () => {
    const { body } = await get("/api/sessions/coupon/usage");
    expect(typeof body.total).toBe("number");
    expect(body.total).toBeGreaterThan(0);
    expect(typeof (await get("/api/sessions/rounding/usage")).body.total).toBe("number");
  });

  it("GET /api/sessions/:id/leftovers returns [], never {}", async () => {
    expect((await get("/api/sessions/coupon/leftovers")).body).toEqual([]);
  });

  it("GET /api/sessions/:id/queue returns a BuildQueue with a `steps` array for every session", async () => {
    const withQueue = await get("/api/sessions/coupon/queue");
    expect(Array.isArray(withQueue.body.steps)).toBe(true);
    expect(withQueue.body.steps.length).toBeGreaterThan(0);
    // a session with no seeded queue still gets a valid empty BuildQueue, not {}
    const noQueue = await get("/api/sessions/rounding/queue");
    expect(noQueue.body).toEqual({ sessionId: "rounding", approved: false, steps: [] });
  });

  it("GET /api/repo-config, /api/commands, /api/todo resolve for a known repo", async () => {
    const repo = encodeURIComponent(REPO);
    const cfg = await get(`/api/repo-config?repo=${repo}`);
    expect(cfg.body.buildQueueEnabled).toBe(true);
    const cmds = await get(`/api/commands?repo=${repo}`);
    expect(Array.isArray(cmds.body.commands)).toBe(true);
    expect(cmds.body.commands.length).toBeGreaterThan(0);
    const todo = await get(`/api/todo?repo=${repo}`);
    expect(todo.body).toEqual({ exists: false, content: "" });
  });
});

// Task 8 sibling audit: the Owed lens's `{#each}` silently no-ops on a non-array (Svelte's
// `ensure_array_like` falls back to `Array.from`, which is `[]` for a plain `{}`), so this
// gap never THREW — it just left a showcased lens (deps' one real owed step) empty.
describe("GET /api/manual-steps/outstanding (Owed lens) is populated, never silently empty", () => {
  it("returns deps' seeded owed step", async () => {
    const { status, body } = await get("/api/manual-steps/outstanding");
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0].sessionId).toBe("deps");
    expect(body[0].steps).toHaveLength(1);
    expect(body[0].steps[0].doneAt).toBeNull();
  });

  it("POST .../steps/:stepId ticks the step; dismiss clears the whole record", async () => {
    const stepRes = await handleApi("POST", u("/api/manual-steps/deps/steps/deps-ms-1"), {
      done: true,
    });
    expect(stepRes.status).toBe(200);
    const stepBody = await stepRes.json();
    expect(stepBody.steps[0].doneAt).not.toBeNull();

    const dismissRes = await handleApi("POST", u("/api/manual-steps/deps/dismiss"), {});
    expect(dismissRes.status).toBe(200);
    expect((await get("/api/manual-steps/outstanding")).body).toEqual([]);
  });
});
