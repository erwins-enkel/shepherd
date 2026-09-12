import { describe, it, expect, beforeEach } from "vitest";
import { handleApi } from "./router";
import { demoState } from "./state";
import { bus } from "./bus";

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

  it("GET /api/sessions/clear-merged returns the merged, non-archived ids (deps + envflag)", async () => {
    const { status, body } = await get("/api/sessions/clear-merged");
    expect(status).toBe(200);
    expect(body).toEqual({ ids: ["deps", "envflag"], leftovers: 0, probesUnavailable: false });
  });

  it("the rich scenario seeds eight sessions across two repos", async () => {
    const { body } = await get("/api/sessions");
    expect(body).toHaveLength(8);
    expect(body.map((s: { id: string }) => s.id).sort()).toEqual(
      [
        "authstore",
        "checkout-child",
        "coupon",
        "deps",
        "envflag",
        "neon",
        "ogimg",
        "rounding",
      ].sort(),
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

  it("POST /review-plan returns started for the seeded plan-gate demo", async () => {
    const r = await handleApi("POST", u("/api/sessions/authstore/review-plan"), undefined);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: "started" });
  });

  it("POST /review-plan returns plan-unavailable when the demo session has no plan gate", async () => {
    const r = await handleApi("POST", u("/api/sessions/neon/review-plan"), undefined);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: "plan-unavailable" });
  });

  it("POST git/merge returns a PrStatus", async () => {
    const r = await handleApi("POST", u("/api/sessions/rounding/git/merge"), {});
    const body = await r.json();
    expect(body).toHaveProperty("state");
    expect(body).toHaveProperty("checks");
  });

  it("POST git/close closes the PR and returns its state", async () => {
    const r = await handleApi("POST", u("/api/sessions/rounding/git/close"), {});
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ state: "closed", number: 512 });
    expect(demoState.gitState("rounding")?.state).toBe("closed");
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
    // re-querying the clearable set now returns envflag only — deps is gone, not re-offered.
    expect((await get("/api/sessions/clear-merged")).body).toEqual({
      ids: ["envflag"],
      leftovers: 0,
      probesUnavailable: false,
    });
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
    // Every file carries a synthesized `patch` — the Diff tab renders from it, so a
    // missing patch would make the demo show "no textual changes" for every file.
    for (const f of body.files) {
      expect(typeof f.patch).toBe("string");
      expect(f.patch.startsWith("diff --git ")).toBe(true);
      expect(f.patch).toContain("@@ ");
    }
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

  it("GET /api/sessions/:id/worktree returns a ScratchListing with an `entries` array, never {}", async () => {
    const { status, body } = await get("/api/sessions/coupon/worktree");
    expect(status).toBe(200);
    expect(Array.isArray(body.entries)).toBe(true);
    const withPath = await get("/api/sessions/coupon/worktree?path=src");
    expect(withPath.status).toBe(200);
    expect(Array.isArray(withPath.body.entries)).toBe(true);
    expect(withPath.body.path).toBe("src");
  });

  it("GET /api/sessions/:id/usage returns a full SessionUsage DTO, never {}", async () => {
    const { body } = await get("/api/sessions/coupon/usage");
    expect(typeof body.total).toBe("number");
    expect(body.total).toBeGreaterThan(0);
    expect(body.available).toBe(true);
    expect(body.source).toBe("live");
    // seeded true zero: available with total 0 (renders "0 tok", never the placeholder)
    const zero = (await get("/api/sessions/rounding/usage")).body;
    expect(zero.available).toBe(true);
    expect(zero.total).toBe(0);
    // the one deliberately unavailable session exercises the "—" placeholder path
    const none = (await get("/api/sessions/neon/usage")).body;
    expect(none.available).toBe(false);
    expect(none.source).toBe("none");
    expect(none.byModel).toBeNull();
    // unseeded id → the zeroed available fallback, still a full DTO
    const unseeded = (await get("/api/sessions/not-seeded/usage")).body;
    expect(unseeded.available).toBe(true);
    expect(unseeded.total).toBe(0);
  });

  // Shape-pinned deliberately: the real endpoint moved from a bare array to
  // `{leftovers, probesUnavailable}` (#1923) so a host that can't detect processes stops
  // reading as a clean one. `getLeftovers` destructures both fields, so a demo that drifts
  // back to an array would leave `found` undefined and throw on `.length`.
  it("GET /api/sessions/:id/leftovers returns {leftovers, probesUnavailable}, never a bare array", async () => {
    expect((await get("/api/sessions/coupon/leftovers")).body).toEqual({
      leftovers: [],
      probesUnavailable: false,
    });
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
    expect(cfg.body.previewOpenMode).toBe("ask");
    const cmds = await get(`/api/commands?repo=${repo}`);
    expect(Array.isArray(cmds.body.commands)).toBe(true);
    expect(cmds.body.commands.length).toBeGreaterThan(0);
    expect(
      cmds.body.commands.every((c: { providers?: string[] }) =>
        (c.providers ?? ["claude"]).includes("claude"),
      ),
    ).toBe(true);
    const codexCmds = await get(`/api/commands?repo=${repo}&provider=codex`);
    expect(codexCmds.body.commands.some((c: { name: string }) => c.name === "github:yeet")).toBe(
      true,
    );
    const todo = await get(`/api/todo?repo=${repo}`);
    expect(todo.body).toEqual({ exists: false, content: "" });
  });
});

// Task 8 sibling audit: the Owed lens's `{#each}` silently no-ops on a non-array (Svelte's
// `ensure_array_like` falls back to `Array.from`, which is `[]` for a plain `{}`), so this
// gap never THREW — it just left a showcased lens (deps' one real owed step) empty.
describe("GET /api/manual-steps/outstanding (Owed lens) is populated, never silently empty", () => {
  it("returns deps' + envflag's seeded owed steps", async () => {
    const { status, body } = await get("/api/manual-steps/outstanding");
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
    const byId = new Map(
      (body as { sessionId: string; steps: { doneAt: number | null }[] }[]).map((r) => [
        r.sessionId,
        r,
      ]),
    );
    expect(byId.get("deps")!.steps).toHaveLength(1);
    expect(byId.get("deps")!.steps[0].doneAt).toBeNull();
    expect(byId.get("envflag")!.steps).toHaveLength(1);
    expect(byId.get("envflag")!.steps[0].doneAt).toBeNull();
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
    // deps is cleared; envflag's owed record is untouched and still outstanding.
    const remaining = (await get("/api/manual-steps/outstanding")).body as { sessionId: string }[];
    expect(remaining.map((r) => r.sessionId)).toEqual(["envflag"]);
  });
});

// #1478 Part 2: the demo router previously had no ack-manual-steps route, so the
// pre-merge "Ack steps" CTA was a silent no-op in the demo build.
describe("POST /api/sessions/:id/ack-manual-steps (mirrors the real server handler)", () => {
  it("stamps manualStepsAckedAt and returns {ok:true}", async () => {
    expect(demoState.sessions().find((s) => s.id === "envflag")?.manualStepsAckedAt).toBeNull();
    const r = await handleApi("POST", u("/api/sessions/envflag/ack-manual-steps"), undefined);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(demoState.sessions().find((s) => s.id === "envflag")?.manualStepsAckedAt).not.toBeNull();
  });

  it("emits session:manual-steps with a non-null manualStepsAckedAt", async () => {
    const frames: { event: string; data: unknown }[] = [];
    const unsub = bus.subscribe((ev) => frames.push(ev));
    try {
      await handleApi("POST", u("/api/sessions/envflag/ack-manual-steps"), undefined);
    } finally {
      unsub();
    }
    const ev = frames.find((f) => f.event === "session:manual-steps");
    expect(ev).toBeDefined();
    expect((ev!.data as { manualStepsAckedAt: number | null }).manualStepsAckedAt).not.toBeNull();
  });
});

// #2240: `PUT /api/settings` had no route, so every settings control in the demo saved into the
// permissive `{ok:true}` tail. Callers that adopt the echoed field (`defaultModel = r.defaultModel`)
// got `undefined`, and an undefined required-string prop throws inside a `$derived` during Svelte's
// flush — which aborts the batch and freezes the whole Settings dialog until a reload.
describe("PUT /api/settings echoes the field the real server echoes", () => {
  async function put(patch: Record<string, unknown>) {
    const r = await handleApi("PUT", u("/api/settings"), patch);
    return { status: r.status, body: await r.json() };
  }

  it("echoes a plain field and applies it to the world", async () => {
    expect(await put({ defaultModel: "opus" })).toEqual({
      status: 200,
      body: { defaultModel: "opus" },
    });
    expect((await get("/api/settings")).body.defaultModel).toBe("opus");
  });

  it("echoes a per-role field under its own key", async () => {
    expect((await put({ plannerCli: "codex" })).body).toEqual({ plannerCli: "codex" });
    expect((await put({ plannerModel: "gpt-6-astra" })).body).toEqual({
      plannerModel: "gpt-6-astra",
    });
    const { body } = await get("/api/settings");
    expect(body.plannerCli).toBe("codex");
    expect(body.plannerModel).toBe("gpt-6-astra");
  });

  it("answers authMode with the {authMode, hasApiKey} pair api.ts is typed against", async () => {
    const { body } = await put({ authMode: "api-key" });
    expect(body.authMode).toBe("api-key");
    expect(typeof body.hasApiKey).toBe("boolean");
  });

  it("answers anthropicApiKey with {hasApiKey} only — the key never round-trips", async () => {
    expect((await put({ anthropicApiKey: "sk-demo-secret" })).body).toEqual({ hasApiKey: true });
    expect((await get("/api/settings")).body.hasApiKey).toBe(true);
    // Nothing anywhere in the world echoes the key back.
    expect(JSON.stringify((await get("/api/settings")).body)).not.toContain("sk-demo-secret");
    expect((await put({ anthropicApiKey: null })).body).toEqual({ hasApiKey: false });
  });

  it("answers repoRoot with a full Settings (putRepoRoot is typed Promise<Settings>)", async () => {
    const { body } = await put({ repoRoot: "/demo/acme" });
    expect(body.repoRoot).toBe("/demo/acme");
    expect(body.repoRootDisplay).toBe("/demo/acme");
    // The Workspace panel reads more than the root off this response.
    expect(body.defaultModel).toBeDefined();
    expect(typeof body.upnextSkipCliPicker).toBe("boolean");
  });

  it("an empty patch is a read, not a stub", async () => {
    const { body } = await put({});
    expect(body.repoRoot).toBeDefined();
    expect(body.ok).toBeUndefined();
  });
});

// #1800: `/api/repos` had no handler, so `listRepos()` saw the permissive `{}` tail and
// `ReposStore.load()` put `undefined` into `entries` (typed `RepoEntry[]`). The `pathIndex`
// $derived then threw `undefined.flatMap` INSIDE Svelte's flush, aborting the whole batch —
// which is what logged an error on every session open, left the mobile detail screen
// unmounted, and stranded the terminal pane at 0x0 after a tab roundtrip.
//
// The same trap sits behind the two other GETs the New Task composer fires (`/api/branches`,
// `/api/issues`): both assign a response array straight into a non-optional `$state` array.
describe("New Task flow GETs never fall back to {} (#1800)", () => {
  it("GET /api/repos returns {repos, recentWindowDays} — an ARRAY, never {}", async () => {
    const { status, body } = await get("/api/repos");
    expect(status).toBe(200);
    expect(Array.isArray(body.repos)).toBe(true);
    expect(body.repos.length).toBeGreaterThan(0);
    expect(typeof body.recentWindowDays).toBe("number");
  });

  it("every repo entry resolves the repoPath its seeded sessions carry", async () => {
    const { body } = await get("/api/repos");
    // repos.nameFor() indexes on BOTH path and realPath; every seeded session's repoPath
    // must land in that index, or steer scoping and the command bar silently see no repo.
    const known = new Set<string>(
      (body.repos as { path: string; realPath: string }[]).flatMap((r) => [r.path, r.realPath]),
    );
    for (const s of demoState.sessions()) expect(known.has(s.repoPath)).toBe(true);
  });

  it("GET /api/branches returns {branches, current, default} per repo", async () => {
    const { status, body } = await get(`/api/branches?repo=${encodeURIComponent(REPO)}`);
    expect(status).toBe(200);
    expect(Array.isArray(body.branches)).toBe(true);
    expect(body.branches).toContain("main");
    expect(body.default).toBe("main");
    // An unrecognized repo still gets a valid list, so pickBaseBranch() falls back to "main".
    const unknown = (await get("/api/branches?repo=/nope")).body;
    expect(unknown).toEqual({ branches: [], current: null, default: null });
  });

  it("GET /api/branch-status reports a clean, in-sync seeded base", async () => {
    const { status, body } = await get(
      `/api/branch-status?repo=${encodeURIComponent(REPO)}&branch=main`,
    );
    expect(status).toBe(200);
    expect(body).toEqual({
      behind: 0,
      ahead: 0,
      diverged: false,
      hasUpstream: true,
      localExists: true,
    });
    // An unseeded branch reads as neither local nor upstream — what the real server says
    // about a branch it cannot find.
    const missing = (await get(`/api/branch-status?repo=${encodeURIComponent(REPO)}&branch=nope`))
      .body;
    expect(missing.localExists).toBe(false);
    expect(missing.hasUpstream).toBe(false);
  });

  it("GET /api/issues returns the listIssues() shape with a real issue array", async () => {
    const { status, body } = await get(`/api/issues?repo=${encodeURIComponent(REPO)}`);
    expect(status).toBe(200);
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.length).toBeGreaterThan(0);
    expect(body.slug).toBe("acme/storefront");
    expect(body.webUrl).toBe("https://github.com/acme/storefront");
    expect(typeof body.viewer).toBe("string");
    // `error: null` matters: an empty-but-errored list makes the UI blame the forge.
    expect(body.error).toBeNull();
    expect(body.lightweight).toBe(false);
    expect(Array.isArray(body.attempts)).toBe(true);
    for (const i of body.issues) {
      expect(typeof i.number).toBe("number");
      expect(typeof i.title).toBe("string");
      expect(Array.isArray(i.labels)).toBe(true);
      expect(Array.isArray(i.assignees)).toBe(true);
    }
  });

  it("issue counts match the Backlog lens' openIssues, so the demo never contradicts itself", async () => {
    const backlog = (await get("/api/backlog")).body as {
      projects: { path: string; openIssues: number }[];
      totals: { openIssues: number };
    };
    let sum = 0;
    for (const p of backlog.projects) {
      const { issues } = (await get(`/api/issues?repo=${encodeURIComponent(p.path)}`)).body;
      expect(issues.length).toBe(p.openIssues);
      sum += issues.length;
    }
    expect(sum).toBe(backlog.totals.openIssues);
  });

  it("every epic child issue is listed, so picking one in New Task finds a real issue", async () => {
    const { issues } = (await get(`/api/issues?repo=${encodeURIComponent(REPO)}`)).body;
    const numbers = new Set((issues as { number: number }[]).map((i) => i.number));
    const { subIssues } = (await get(`/api/epics?repo=${encodeURIComponent(REPO)}`)).body;
    for (const n of subIssues as number[]) expect(numbers.has(n)).toBe(true);
  });

  it("an unrecognized repo yields an empty-but-successful issue list, not a failure", async () => {
    const { body } = await get("/api/issues?repo=/nope");
    expect(body.issues).toEqual([]);
    expect(body.slug).toBeNull();
    expect(body.error).toBeNull();
  });
});

describe("POST /api/sessions (#1800) creates a real session instead of {ok:true}", () => {
  it("returns a Session and pushes it into the live herd", async () => {
    const before = demoState.sessions().length;
    const r = await handleApi("POST", u("/api/sessions"), {
      repoPath: REPO,
      baseBranch: "main",
      prompt: "Add a gift-wrap option to the checkout summary",
      model: "opus",
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    // The page calls selectNewSession(r.id) — a missing id selected `undefined`.
    expect(typeof body.id).toBe("string");
    expect(body.id.length).toBeGreaterThan(0);
    expect(body.repoPath).toBe(REPO);
    expect(body.prompt).toBe("Add a gift-wrap option to the checkout summary");
    expect(body.branch).toBe("shepherd/add-a-gift");
    expect(body.status).toBe("running");
    expect(demoState.sessions().length).toBe(before + 1);
    expect(demoState.sessions().find((s) => s.id === body.id)).toBeDefined();
  });

  it("emits session:new so the herd rail picks the row up over the socket", async () => {
    const seen: string[] = [];
    const off = bus.subscribe((ev) => {
      if (ev.event === "session:new") seen.push(ev.data.id);
    });
    const r = await handleApi("POST", u("/api/sessions"), {
      repoPath: REPO,
      baseBranch: "main",
      prompt: "Tidy the footer",
      model: "opus",
    });
    off();
    expect(seen).toEqual([(await r.json()).id]);
  });

  it("takes a fresh TASK designation that collides with no live or archived session", async () => {
    const taken = new Set(
      [...demoState.sessions(), ...demoState.doneSessions()].map((s) => s.desig),
    );
    const r = await handleApi("POST", u("/api/sessions"), {
      repoPath: REPO,
      baseBranch: "main",
      prompt: "Tweak the header",
      model: "opus",
    });
    expect(taken.has((await r.json()).desig)).toBe(false);
  });

  it("carries the operator's plan-gate choice into the planning phase", async () => {
    const r = await handleApi("POST", u("/api/sessions"), {
      repoPath: REPO,
      baseBranch: "main",
      prompt: "Rework the cart",
      model: "opus",
      planGateEnabled: true,
    });
    const body = await r.json();
    expect(body.planGateEnabled).toBe(true);
    expect(body.planPhase).toBe("planning");
  });

  it("the terminal arm creates a bare, non-isolated shell in the repo's main checkout", async () => {
    const r = await handleApi("POST", u("/api/sessions"), { terminal: true, repoPath: REPO });
    const body = await r.json();
    expect(body.terminal).toBe(true);
    expect(body.branch).toBeNull();
    expect(body.isolated).toBe(false);
    expect(body.worktreePath).toBe(REPO);
    expect(body.prompt).toBe("");
  });

  it("rejects a body with no repoPath rather than inventing a session", async () => {
    const before = demoState.sessions().length;
    const r = await handleApi("POST", u("/api/sessions"), { prompt: "no repo" });
    expect(r.status).toBe(400);
    expect(demoState.sessions().length).toBe(before);
  });

  it("a created session's detail tabs all answer with valid empty records", async () => {
    const id = (
      await (
        await handleApi("POST", u("/api/sessions"), {
          repoPath: REPO,
          baseBranch: "main",
          prompt: "Check the tabs",
          model: "opus",
        })
      ).json()
    ).id;
    expect((await get(`/api/sessions/${id}/activity`)).body).toEqual([]);
    expect(Array.isArray((await get(`/api/sessions/${id}/diff`)).body.files)).toBe(true);
    expect((await get(`/api/sessions/${id}/usage`)).body.total).toBe(0);
    expect((await get(`/api/sessions/${id}/queue`)).body.steps).toEqual([]);
    // No seeded git state — the real server 404s for a session with no PR yet. Read via
    // handleApi, not get(): a 404 carries no body, so get()'s r.json() would throw.
    expect((await handleApi("GET", u(`/api/sessions/${id}/git`), undefined)).status).toBe(404);
  });
});

// #1821: these four all reached the permissive `{}` tail with a shape their api.ts caller
// cannot survive. The throw that follows lands inside a `$derived` during Svelte's flush and
// ABORTS THE BATCH, so every queued user `$effect` in the app stops re-running until a reload.
// The assertions below are on the shape CONTRACT each caller is typed against — not on
// incidental seeded values — because that contract is what keeps the flush alive.
describe("GETs whose {} fallback threw in the caller (#1821)", () => {
  it("GET /api/fs/dirs returns a DirListing — DirPicker reads entries.length", async () => {
    const { status, body } = await get("/api/fs/dirs?path=/demo/acme");
    expect(status).toBe(200);
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.entries.map((e: { name: string }) => e.name)).toEqual(["api", "storefront"]);
    // `display` matches settings.repoRootDisplay, so the panel's "already your root" check resolves.
    expect(body.display).toBe((await get("/api/settings")).body.repoRootDisplay);
    expect(body.parent).toBe("/demo");
  });

  it("GET /api/fs/dirs browses the chain above the repo root, and bottoms out at null", async () => {
    expect((await get("/api/fs/dirs?path=/demo")).body.parent).toBe("/");
    expect((await get("/api/fs/dirs?path=/")).body.parent).toBeNull();
  });

  it("GET /api/fs/dirs with no path browses the configured repo root", async () => {
    const { body } = await get("/api/fs/dirs");
    expect(body.path).toBe((await get("/api/settings")).body.repoRoot);
    expect(Array.isArray(body.entries)).toBe(true);
  });

  it("GET /api/fs/dirs gives an unseeded directory a valid listing with a working up-crumb", async () => {
    const { status, body } = await get("/api/fs/dirs?path=/demo/acme/storefront");
    expect(status).toBe(200);
    expect(body.entries).toEqual([]); // empty, but never {}
    expect(body.parent).toBe("/demo/acme"); // "up" still walks back into the seeded chain
  });

  it("GET /api/access-tokens wraps an array under {tokens} — the panel reads tokens.length", async () => {
    const { status, body } = await get("/api/access-tokens");
    expect(status).toBe(200);
    expect(Array.isArray(body.tokens)).toBe(true);
  });

  it("GET /api/plugin-update always carries `plugins` — {} is truthy, so `?.` would not save it", async () => {
    const { status, body } = await get("/api/plugin-update");
    expect(status).toBe(200);
    expect(Array.isArray(body.plugins)).toBe(true);
    expect(body.updateAvailable).toBe(false);
    expect(typeof body.checkedAt).toBe("number");
  });

  it("GET /api/stranded is an ARRAY — setClaudeAlive iterates it with for…of", async () => {
    const { status, body } = await get("/api/stranded");
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    // No session in the scenario is a restart-strand; the `false` liveness entries are plain husks.
    expect(body).toEqual([]);
  });
});
