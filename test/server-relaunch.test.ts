import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeApp, type AppDeps } from "../src/server";
import { config } from "../src/config";
import type { SessionStore } from "../src/store";
import type { SessionService } from "../src/service";
import type { EventHub } from "../src/events";
import type { GitForge, Issue } from "../src/forge/types";
import { EMPTY_BACKLOG_COUNTS } from "../src/forge/types";
import type { Session } from "../src/types";

// Override-validation (validateRelaunchOverrides) confines a supplied `repoPath` to
// config.repoRoot and requires it to exist — so the override tests need a real repoRoot
// with a real sibling repo dir to relaunch INTO. Patch the module-level config.repoRoot
// to a temp tree for the whole file (restored after), and create `repo/` + `other-repo/`
// under it. Tests reference these via REPO / OTHER_REPO instead of bare "/repo" literals.
let tmpRoot: string;
let REPO: string;
let OTHER_REPO: string;
let STAGED_IMAGE: string; // realpath of a real staged upload, for the images-override test
let originalRepoRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "shepherd-relaunch-test-"));
  REPO = join(tmpRoot, "repo");
  OTHER_REPO = join(tmpRoot, "other-repo");
  mkdirSync(REPO);
  mkdirSync(OTHER_REPO);
  // A real staged upload so validateImages (confined to repoRoot's staging dir) passes.
  const staging = join(tmpRoot, ".shepherd-uploads-staging");
  mkdirSync(staging);
  const img = join(staging, "new.png");
  writeFileSync(img, "x");
  STAGED_IMAGE = realpathSync(img); // validateImages returns the realpath-resolved path
  originalRepoRoot = config.repoRoot;
  config.repoRoot = tmpRoot;
});

afterAll(() => {
  config.repoRoot = originalRepoRoot;
  rmSync(tmpRoot, { recursive: true, force: true });
});

const ISSUE: Issue = {
  number: 42,
  title: "Fix the thing",
  body: "details here",
  url: "https://github.com/team/proj/issues/42",
  labels: [],
  createdAt: 1_700_000_000_000,
  assignees: [],
};

type Spy = { event: string; data: unknown };

// The route only reads status / issueNumber / repoPath off the original and passes
// the `fresh` session through verbatim — so the mocks cast minimal shapes through
// `unknown` rather than filling the whole Session type.
function harness(opts: {
  original?: Partial<Session> | null; // null → store.get returns undefined (404)
  fresh?: Session; // what service.relaunch resolves to
  relaunchThrows?: Error;
  resolveForge?: AppDeps["resolveForge"];
  archiveCleared?: string[]; // ids archiveMany reports cleared (default: the requested id)
  staged?: { path: string; name: string | null; nameRecorded: boolean }[]; // what stageRelaunchImages returns
}) {
  const emitted: Spy[] = [];
  const calls = {
    relaunch: [] as Array<{ id: string; issueRef: unknown; overrides: unknown }>,
    archiveMany: [] as Array<{ ids: string[]; reason: unknown }>,
    stageRelaunchImages: [] as string[],
  };
  let retainClaimSeenArchived = false;

  const originalSession =
    opts.original === null
      ? undefined
      : ({
          id: "orig",
          repoPath: REPO,
          status: "running",
          issueNumber: null,
          ...opts.original,
        } as unknown as Session);

  const fresh =
    opts.fresh ?? ({ id: "new", desig: "TASK-02", repoPath: REPO } as unknown as Session);

  const store = {
    get: (id: string) => (id === "orig" ? originalSession : undefined),
  } as unknown as SessionStore;

  const service = {
    relaunch: async (id: string, issueRef: unknown, overrides: unknown) => {
      calls.relaunch.push({ id, issueRef, overrides });
      if (opts.relaunchThrows) throw opts.relaunchThrows;
      // Mirror the real service just enough for route-level assertions: the returned
      // session reflects repo/base overrides and drops the issue when issueRef is absent.
      const o = (overrides ?? {}) as Record<string, unknown>;
      const ir = issueRef as { number?: number } | undefined;
      return {
        ...fresh,
        repoPath: (o.repoPath as string) ?? fresh.repoPath,
        baseBranch: (o.baseBranch as string) ?? (fresh as Session).baseBranch,
        prompt: (o.prompt as string) ?? (fresh as Session).prompt,
        model: "model" in o ? (o.model as string | null) : (fresh as Session).model,
        planGateEnabled:
          "planGateEnabled" in o
            ? (o.planGateEnabled as boolean | null)
            : (fresh as Session).planGateEnabled,
        issueNumber: ir?.number ?? null,
      } as Session;
    },
    archiveMany: (ids: string[], reason: unknown) => {
      calls.archiveMany.push({ ids, reason });
      return { cleared: opts.archiveCleared ?? ids, leftovers: 0 };
    },
    stageRelaunchImages: (id: string) => {
      calls.stageRelaunchImages.push(id);
      return (
        opts.staged ?? [{ path: "/stage/carried.png", name: "carried.png", nameRecorded: true }]
      );
    },
  } as unknown as SessionService;

  const events = {
    emit: (event: string, data: unknown) => {
      emitted.push({ event, data });
    },
  } as unknown as EventHub;

  const drainCalls: string[] = [];
  const droppedFromCache: string[] = [];

  const deps: AppDeps = {
    store,
    service,
    events,
    usageLimits: { limits: () => ({}) } as never,
    resolveForge: opts.resolveForge,
    prCache: {
      drop: (id: string) => droppedFromCache.push(id),
    } as unknown as AppDeps["prCache"],
    drain: {
      snapshot: async () => [],
      queue: async () => [],
      retainClaim: (id: string) => {
        drainCalls.push(id);
        // record whether session:archived was already emitted at retain time
        retainClaimSeenArchived = emitted.some((e) => e.event === "session:archived");
      },
      buildEpic: async () => null,
      diagnoseEpic: async () => null,
      approveEpicNext: () => {},
      tick: async () => {},
    },
  };

  return {
    app: makeApp(deps),
    emitted,
    calls,
    drainCalls,
    droppedFromCache,
    retainSeenArchived: () => retainClaimSeenArchived,
  };
}

function relaunchReq(id = "orig", body?: unknown): Request {
  return new Request(`http://localhost/api/sessions/${id}/relaunch`, {
    method: "POST",
    ...(body !== undefined
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
}

function fakeForge(over: Partial<GitForge> = {}): GitForge {
  return {
    kind: "github",
    slug: "team/proj",
    mergeMethod: "squash",
    deployWorkflow: null,
    listIssues: async () => [],
    listPullRequests: async () => [],
    listBacklogCounts: async () => EMPTY_BACKLOG_COUNTS,
    prStatus: async () => ({ state: "none", checks: "none", deployConfigured: false }),
    openPr: async () => ({ state: "none", checks: "none", deployConfigured: false }),
    merge: async () => {},
    redeploy: async () => {},
    postReview: async () => ({}),
    defaultBranch: async () => "main",
    getIssue: async () => ISSUE,
    ...over,
  };
}

test("happy path: emits session:new then session:archived, returns {session, archived:true}", async () => {
  const h = harness({ original: { issueNumber: null } });
  const res = await h.app.fetch(relaunchReq());
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.archived).toBe(true);
  expect(body.session.id).toBe("new");

  const order = h.emitted.map((e) => e.event);
  expect(order).toEqual(["session:new", "session:archived"]);
  expect(h.emitted[0]?.data).toMatchObject({ id: "new" });
  expect(h.emitted[1]?.data).toEqual({ id: "orig" });
  expect(h.calls.relaunch).toHaveLength(1);
  expect(h.calls.relaunch[0]).toEqual({ id: "orig", issueRef: undefined, overrides: undefined });
  expect(h.calls.archiveMany).toEqual([{ ids: ["orig"], reason: "relaunch" }]);
  expect(h.droppedFromCache).toEqual(["orig"]);
});

test("issue-linked relaunch retains the claim before the session:archived emit", async () => {
  // Retain fires only when the replacement carries the issue (issueRef truthy), so this
  // case must be issue-linked. The new session owns ACTIVE_LABEL → relaunch ≠ retire.
  const h = harness({ original: { issueNumber: 42 }, resolveForge: () => fakeForge() });
  await h.app.fetch(relaunchReq());
  expect(h.drainCalls).toEqual(["orig"]);
  expect(h.retainSeenArchived()).toBe(false); // archived not yet emitted when retain fired
});

test("non-issue relaunch does NOT retain the claim (nothing to keep)", async () => {
  const h = harness({ original: { issueNumber: null } });
  await h.app.fetch(relaunchReq());
  expect(h.drainCalls).toHaveLength(0);
});

test("missing original → 404, nothing spawned", async () => {
  const h = harness({ original: null });
  const res = await h.app.fetch(relaunchReq());
  expect(res.status).toBe(404);
  expect(h.calls.relaunch).toHaveLength(0);
  expect(h.emitted).toHaveLength(0);
});

test("archived original → 409, nothing spawned", async () => {
  const h = harness({ original: { status: "archived" } });
  const res = await h.app.fetch(relaunchReq());
  expect(res.status).toBe(409);
  expect(h.calls.relaunch).toHaveLength(0);
});

test("issue-linked original re-resolves and threads issueRef into service.relaunch", async () => {
  const h = harness({
    original: { issueNumber: 42 },
    resolveForge: () => fakeForge(),
  });
  const res = await h.app.fetch(relaunchReq());
  expect(res.status).toBe(201);
  expect(h.calls.relaunch[0]?.issueRef).toEqual({
    number: 42,
    url: ISSUE.url,
    title: ISSUE.title,
    body: ISSUE.body,
  });
});

test("issue-linked original whose getIssue returns null → 502, nothing spawned or torn down", async () => {
  const h = harness({
    original: { issueNumber: 42 },
    resolveForge: () => fakeForge({ getIssue: async () => null }),
  });
  const res = await h.app.fetch(relaunchReq());
  expect(res.status).toBe(502);
  expect((await res.json()).error).toMatch(/re-resolve/);
  expect(h.calls.relaunch).toHaveLength(0);
  expect(h.emitted).toHaveLength(0);
  expect(h.drainCalls).toHaveLength(0);
});

test("issue-linked original whose getIssue throws → 502, nothing spawned", async () => {
  const h = harness({
    original: { issueNumber: 42 },
    resolveForge: () =>
      fakeForge({
        getIssue: async () => {
          throw new Error("network down");
        },
      }),
  });
  const res = await h.app.fetch(relaunchReq());
  expect(res.status).toBe(502);
  expect(h.calls.relaunch).toHaveLength(0);
  expect(h.emitted).toHaveLength(0);
});

test("issue-linked original on a forge lacking getIssue → relaunches WITHOUT issue (no 502)", async () => {
  // Capability gap (getIssue is optional on GitForge): fall back to spawning without the
  // issue rather than hard-failing, so issue-linked relaunch isn't permanently broken on
  // such a host. The issue link is dropped (issueRef undefined), but the relaunch proceeds.
  const h = harness({
    original: { issueNumber: 42 },
    resolveForge: () => fakeForge({ getIssue: undefined }),
  });
  const res = await h.app.fetch(relaunchReq());
  expect(res.status).toBe(201);
  expect(h.calls.relaunch).toHaveLength(1);
  expect(h.calls.relaunch[0]).toEqual({ id: "orig", issueRef: undefined, overrides: undefined });
  expect(h.emitted.map((e) => e.event)).toEqual(["session:new", "session:archived"]);
  // Issue was dropped → claim must NOT be retained, so onArchived releases the orphaned
  // ACTIVE_LABEL and the issue is re-queued rather than stuck claimed.
  expect(h.drainCalls).toHaveLength(0);
});

test("spawn failure (service.relaunch throws) → 502, original left intact (no archive/emit)", async () => {
  const h = harness({
    original: { issueNumber: null },
    relaunchThrows: new Error("herdr boom"),
  });
  const res = await h.app.fetch(relaunchReq());
  expect(res.status).toBe(502);
  expect((await res.json()).error).toContain("herdr boom");
  expect(h.emitted).toHaveLength(0); // no session:new, no session:archived
  expect(h.drainCalls).toHaveLength(0); // retainClaim never reached
});

test("teardown not-cleared → archived:false, still emits session:new (no session:archived)", async () => {
  const h = harness({ original: { issueNumber: null }, archiveCleared: [] });
  const res = await h.app.fetch(relaunchReq());
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.archived).toBe(false);
  expect(body.session.id).toBe("new");
  const order = h.emitted.map((e) => e.event);
  expect(order).toEqual(["session:new"]); // archived NOT emitted
  expect(h.droppedFromCache).toHaveLength(0); // prCache.drop only on cleared
  // No session:archived fires, so drain.onArchived never runs to consume a retain flag.
  // Stamping retainClaim here would leak a stale one-shot that mis-converts a later
  // manual abandon of the still-live original into a retire — so it MUST NOT be called.
  expect(h.drainCalls).toHaveLength(0);
});

test("concurrent second relaunch of the same id → 409, no double-spawn", async () => {
  // Make service.relaunch hang until released so two requests overlap.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let relaunchCalls = 0;
  const emitted: Spy[] = [];

  const deps: AppDeps = {
    store: {
      get: () => ({ id: "orig", repoPath: "/repo", status: "running", issueNumber: null }),
    } as unknown as SessionStore,
    service: {
      relaunch: async () => {
        relaunchCalls++;
        await gate;
        return { id: "new", desig: "TASK-02" } as unknown as Session;
      },
      archiveMany: (ids: string[]) => ({ cleared: ids, leftovers: 0 }),
    } as unknown as SessionService,
    events: {
      emit: (event: string, data: unknown) => emitted.push({ event, data }),
    } as unknown as EventHub,
    usageLimits: { limits: () => ({}) } as never,
    drain: {
      snapshot: async () => [],
      queue: async () => [],
      retainClaim: () => {},
      buildEpic: async () => null,
      diagnoseEpic: async () => null,
      approveEpicNext: () => {},
      tick: async () => {},
    },
    prCache: { drop: () => {} } as unknown as AppDeps["prCache"],
  };
  const app = makeApp(deps);

  const first = app.fetch(relaunchReq()); // starts, hangs in relaunch
  // give the first request a tick to register in inFlightRelaunch
  await new Promise((r) => setTimeout(r, 10));
  const secondRes = await app.fetch(relaunchReq());
  expect(secondRes.status).toBe(409);
  expect((await secondRes.json()).error).toMatch(/in progress/);
  expect(relaunchCalls).toBe(1); // second request did NOT spawn

  release();
  const firstRes = await first;
  expect(firstRes.status).toBe(201);

  // after the first completes, the id is cleared → a fresh relaunch is allowed again
  const thirdRes = await app.fetch(relaunchReq());
  expect(thirdRes.status).toBe(201);
  expect(relaunchCalls).toBe(2);
});

// ── Overrides (relaunch-into-a-different-repo + per-field carry-forward) ──────────────

test("quick relaunch (no body) lands in the ORIGINAL repo and keeps the issue", async () => {
  // Regression guard: a bare POST → no overrides, same-repo, issue re-resolved + retained.
  const h = harness({
    original: { issueNumber: 42, repoPath: REPO },
    resolveForge: () => fakeForge(),
  });
  const res = await h.app.fetch(relaunchReq());
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.session.repoPath).toBe(REPO);
  expect(body.session.issueNumber).toBe(42);
  expect(h.calls.relaunch[0]?.overrides).toBeUndefined();
  expect(h.calls.relaunch[0]?.issueRef).toMatchObject({ number: 42 });
  expect(h.drainCalls).toEqual(["orig"]); // claim retained (issue kept)
});

test("relaunch with { repoPath } → new repo, issue DROPPED, baseBranch override honored", async () => {
  // Cross-repo: even though the original is issue-linked, the issue is NOT re-resolved
  // (it belongs to the old repo's tracker) → issueNumber null on the replacement.
  const forgeCalls: number[] = [];
  const h = harness({
    original: { issueNumber: 42, repoPath: REPO },
    resolveForge: () =>
      fakeForge({
        getIssue: async (n: number) => {
          forgeCalls.push(n);
          return ISSUE;
        },
      }),
  });
  const res = await h.app.fetch(
    relaunchReq("orig", { repoPath: OTHER_REPO, baseBranch: "develop" }),
  );
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.session.repoPath).toBe(OTHER_REPO);
  expect(body.session.baseBranch).toBe("develop");
  expect(body.session.issueNumber).toBe(null); // issue dropped
  expect(h.calls.relaunch[0]?.issueRef).toBeUndefined(); // not re-resolved
  expect(h.calls.relaunch[0]?.overrides).toMatchObject({
    repoPath: OTHER_REPO,
    baseBranch: "develop",
  });
  expect(forgeCalls).toHaveLength(0); // reResolveRelaunchIssue skipped for cross-repo
});

test("cross-repo relaunch does NOT retain the claim → released on archive", async () => {
  // No surviving issueRef → handler skips retainClaim → drain.onArchived releases the
  // original's ACTIVE_LABEL back to its backlog. Observed via the drain.retainClaim spy.
  const h = harness({
    original: { issueNumber: 42, repoPath: REPO },
    resolveForge: () => fakeForge(),
  });
  const res = await h.app.fetch(relaunchReq("orig", { repoPath: OTHER_REPO }));
  expect(res.status).toBe(201);
  expect(h.drainCalls).toHaveLength(0); // retainClaim NOT called
  expect(h.emitted.map((e) => e.event)).toEqual(["session:new", "session:archived"]);
});

test("same-repo relaunch with { prompt, model, planGateEnabled, baseBranch } applies each + keeps issue", async () => {
  const h = harness({
    original: { issueNumber: 42, repoPath: REPO },
    resolveForge: () => fakeForge(),
  });
  const res = await h.app.fetch(
    relaunchReq("orig", {
      prompt: "do the new thing",
      model: "opus",
      planGateEnabled: true,
      baseBranch: "release",
    }),
  );
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.session.prompt).toBe("do the new thing");
  expect(body.session.model).toBe("opus");
  expect(body.session.planGateEnabled).toBe(true);
  expect(body.session.baseBranch).toBe("release");
  expect(body.session.issueNumber).toBe(42); // same-repo → issue re-resolved + kept
  expect(h.calls.relaunch[0]?.issueRef).toMatchObject({ number: 42 });
  expect(h.calls.relaunch[0]?.overrides).toMatchObject({
    prompt: "do the new thing",
    model: "opus",
    planGateEnabled: true,
    baseBranch: "release",
  });
  expect(h.drainCalls).toEqual(["orig"]); // retainClaim called
});

test("images override is threaded through to service.relaunch as the authoritative set", async () => {
  // Image semantics live in the service (overrides → verbatim, no auto-carry); at the route
  // boundary we assert the supplied images ride through unchanged as that authoritative set.
  const h = harness({ original: { issueNumber: null, repoPath: REPO } });
  const res = await h.app.fetch(relaunchReq("orig", { images: [STAGED_IMAGE] }));
  expect(res.status).toBe(201);
  // validateImages resolves each entry to its realpath; that resolved path rides through.
  expect(h.calls.relaunch[0]?.overrides).toMatchObject({ images: [STAGED_IMAGE] });
});

// ── POST /api/sessions/:id/relaunch-uploads — stage carried images for the composer ──────
function relaunchUploadsReq(id = "orig"): Request {
  return new Request(`http://localhost/api/sessions/${id}/relaunch-uploads`, { method: "POST" });
}

test("POST /api/sessions/:id/relaunch-uploads returns staged { images }", async () => {
  const staged = [
    { path: "/stage/a.png", name: "a.png", nameRecorded: true },
    { path: "/stage/b.jpg", name: "b.jpg", nameRecorded: true },
  ];
  const h = harness({ original: { issueNumber: null, repoPath: REPO }, staged });
  const res = await h.app.fetch(relaunchUploadsReq("orig"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ images: staged });
  expect(h.calls.stageRelaunchImages).toEqual(["orig"]); // sourced from the service
});

test("POST /api/sessions/:id/relaunch-uploads → 404 for a missing original", async () => {
  const h = harness({ original: null });
  const res = await h.app.fetch(relaunchUploadsReq("ghost"));
  expect(res.status).toBe(404);
  expect(h.calls.stageRelaunchImages).toHaveLength(0); // never staged
});

test("POST /api/sessions/:id/relaunch-uploads → 409 for an archived original", async () => {
  const h = harness({ original: { status: "archived", issueNumber: null, repoPath: REPO } });
  const res = await h.app.fetch(relaunchUploadsReq("orig"));
  expect(res.status).toBe(409);
  expect(h.calls.stageRelaunchImages).toHaveLength(0);
});

// ── Override validation (closes the create/relaunch asymmetry — fail-closed) ──────────
// Every supplied override field is run through the SAME validators create uses, BEFORE
// service.relaunch → create. A bad field → 400 (matching create's body), nothing spawned.

test("out-of-root / traversal repoPath override → 400, nothing spawned", async () => {
  // "/etc" is outside config.repoRoot (tmpRoot) → validateRepoPath's containment check
  // rejects it before it can reach worktree.create. Same guard create applies.
  const h = harness({ original: { issueNumber: null, repoPath: REPO } });
  const res = await h.app.fetch(relaunchReq("orig", { repoPath: "/etc" }));
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/repoRoot/);
  expect(h.calls.relaunch).toHaveLength(0); // not spawned
  expect(h.emitted).toHaveLength(0);
});

test("non-existent repoPath override (inside root) → 400, nothing spawned", async () => {
  // Inside repoRoot but the dir doesn't exist → validateRepoPath's statSync rejects it.
  const h = harness({ original: { issueNumber: null, repoPath: REPO } });
  const res = await h.app.fetch(relaunchReq("orig", { repoPath: join(tmpRoot, "ghost") }));
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/does not exist/);
  expect(h.calls.relaunch).toHaveLength(0);
});

test("invalid model override → 400, nothing spawned (not passed to --model)", async () => {
  // An arbitrary model string must never reach the --model spawn flag; the MODELS
  // allowlist (validateModel) rejects it the same way create does.
  const h = harness({ original: { issueNumber: null, repoPath: REPO } });
  const res = await h.app.fetch(relaunchReq("orig", { model: "gpt-4-turbo" }));
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/unknown model/);
  expect(h.calls.relaunch).toHaveLength(0);
});

test("invalid baseBranch override → 400, nothing spawned", async () => {
  // BRANCH_RE rejects spaces / unsafe chars — same guard create applies.
  const h = harness({ original: { issueNumber: null, repoPath: REPO } });
  const res = await h.app.fetch(relaunchReq("orig", { baseBranch: "bad branch!!" }));
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/baseBranch/);
  expect(h.calls.relaunch).toHaveLength(0);
});

test("unknown key in override body → 400, nothing spawned", async () => {
  // Mirrors create's unknown-key rejection so no unvetted field slips through.
  const h = harness({ original: { issueNumber: null, repoPath: REPO } });
  const res = await h.app.fetch(relaunchReq("orig", { repoPath: REPO, evil: "yes" }));
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/unknown key/);
  expect(h.calls.relaunch).toHaveLength(0);
});

test("model: null override is legal (means default) → 201, threaded through", async () => {
  // An explicit null is the "use claude's default model" signal — NOT an invalid value.
  const h = harness({ original: { issueNumber: null, repoPath: REPO } });
  const res = await h.app.fetch(relaunchReq("orig", { model: null }));
  expect(res.status).toBe(201);
  expect(h.calls.relaunch[0]?.overrides).toMatchObject({ model: null });
});

test("a fully VALID override body still succeeds (regression)", async () => {
  // repoPath inside root + existing, allowlisted model, BRANCH_RE baseBranch → passes all
  // validators and reaches service.relaunch unchanged.
  const h = harness({ original: { issueNumber: null, repoPath: REPO } });
  const res = await h.app.fetch(
    relaunchReq("orig", { repoPath: OTHER_REPO, model: "opus", baseBranch: "develop" }),
  );
  expect(res.status).toBe(201);
  expect(h.calls.relaunch).toHaveLength(1);
  expect(h.calls.relaunch[0]?.overrides).toMatchObject({
    repoPath: OTHER_REPO,
    model: "opus",
    baseBranch: "develop",
  });
});
