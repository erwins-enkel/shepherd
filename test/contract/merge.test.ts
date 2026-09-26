import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  bearer,
  collectEvents,
  coverage,
  login,
  mintToken,
  restoreAuth,
  startContractServer,
  validateEvent,
  validateRequest,
  validateResponse,
  withAuth,
  type ContractServer,
} from "./harness";
import { eventsForStream, operationsForStream } from "./stream-blocks";
import * as fx from "./merge-fixtures";
import { takeoverConfirm, takeoverStatus } from "./detail-fixtures";
import { MergeConflictError } from "../../src/forge/local";
let s: ContractServer;
let token: string;
let id: string;
const OPS = operationsForStream("merge");
const EVENTS = eventsForStream("merge");
async function request(
  method: string,
  template: string,
  status: number,
  body?: unknown,
  path = template.replaceAll("{id}", id).replaceAll("{stepId}", "one"),
  auth = true,
) {
  const res = await fetch(s.baseUrl + path, {
    method,
    headers: { "content-type": "application/json", ...(auth ? bearer(token) : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  expect(res.status, `${method} ${path}`).toBe(status);
  return await validateResponse(method, template, res);
}
beforeAll(async () => {
  await withAuth();
  s = startContractServer();
  ({ token } = await mintToken(s, await login(s), "merge contract"));
  const r = await fetch(s.baseUrl + "/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(token) },
    body: JSON.stringify({ repoPath: s.validRepo, baseBranch: "main", prompt: "fixture" }),
  });
  expect(r.status).toBe(201);
  id = ((await r.json()) as { id: string }).id;
});
afterAll(() => {
  try {
    s?.stop();
  } finally {
    restoreAuth();
  }
});

test("bulk snapshots are non-empty, and drain validates repo", async () => {
  const savedDrain = s.deps.drain;
  const savedAuto = s.stubs.autoMerge.rows;
  s.stubs.autoMerge.rows = [{ ...fx.auto, repoPath: s.validRepo, sessionId: id }];
  s.deps.drain = {
    snapshot: async () => [{ ...fx.drain, repoPath: s.validRepo }],
    queue: async () => fx.queued,
  } as never;
  try {
    const auto = (await request("GET", "/api/automerge", 200)) as (typeof fx.auto)[];
    expect(auto[0]?.sessionId).toBe(id);
    const drain = (await request("GET", "/api/drain", 200)) as (typeof fx.drain)[];
    expect(drain[0]?.queued).toBe(1);
    const rows = await request(
      "GET",
      "/api/drain/queue",
      200,
      undefined,
      `/api/drain/queue?repo=${encodeURIComponent(s.validRepo)}`,
    );
    expect(rows).toEqual(fx.queued);
    await request("GET", "/api/drain/queue", 400, undefined, "/api/drain/queue?repo=/outside");
  } finally {
    s.deps.drain = savedDrain;
    s.stubs.autoMerge.rows = savedAuto;
  }
});

test("both per-session overrides support true, false and explicit null", async () => {
  for (const name of ["autopilot", "automerge"]) {
    const p = `/api/sessions/{id}/${name}`;
    for (const enabled of [true, false, null]) {
      const body = (await request("PUT", p, 200, { enabled })) as Record<string, unknown>;
      expect(body[name === "autopilot" ? "autopilotEnabled" : "autoMergeEnabled"]).toBe(enabled);
    }
    await request("PUT", p, 400, { enabled: "yes" });
    await request("PUT", p, 404, { enabled: true }, `/api/sessions/missing/${name}`);
  }
});

test("redeploy guards and forge errors", async () => {
  const p = "/api/sessions/{id}/git/redeploy";
  const saved = s.stubs.resolveForge.forge;
  try {
    s.stubs.resolveForge.forge = null;
    await request("POST", p, 404);
    await request("POST", p, 404, undefined, "/api/sessions/missing/git/redeploy");
    s.stubs.resolveForge.forge = { deployWorkflow: null };
    expect(await request("POST", p, 400)).toEqual({ error: "no deploy workflow configured" });
    let calls = 0;
    s.stubs.resolveForge.forge = {
      deployWorkflow: "deploy.yml",
      redeploy: async () => {
        calls++;
      },
    };
    expect(await request("POST", p, 200)).toEqual({ ok: true });
    expect(calls).toBe(1);
    s.stubs.resolveForge.forge = {
      deployWorkflow: "deploy.yml",
      redeploy: async () => {
        throw new Error("fixture failure");
      },
    };
    expect(await request("POST", p, 502)).toEqual({ error: "fixture failure" });
  } finally {
    s.stubs.resolveForge.forge = saved;
  }
});

test("owed materialization outlives its session; tick, untick, dismiss and acknowledge differ", async () => {
  s.deps.store.materializePostMergeSteps({
    sessionId: "pruned",
    desig: "TASK-1",
    repoPath: s.validRepo,
    prNumber: 7,
    prTitle: "Ship",
    steps: fx.steps,
  });
  const outstanding = (await request("GET", "/api/manual-steps/outstanding", 200)) as {
    sessionId: string;
  }[];
  expect(outstanding.map((r) => r.sessionId)).toContain("pruned");
  const p = "/api/manual-steps/{id}/steps/{stepId}";
  const actual = "/api/manual-steps/pruned/steps/one";
  await request("POST", p, 400, { done: 1 }, actual);
  await request("POST", p, 404, { done: true }, "/api/manual-steps/missing/steps/one");
  const done = (await request("POST", p, 200, { done: true }, actual)) as {
    clearedAt: number | null;
  };
  expect(done.clearedAt).not.toBeNull();
  const undone = (await request("POST", p, 200, { done: false }, actual)) as {
    clearedAt: number | null;
  };
  expect(undone.clearedAt).toBeNull();
  const dismissed = (await request(
    "POST",
    "/api/manual-steps/{id}/dismiss",
    200,
    undefined,
    "/api/manual-steps/pruned/dismiss",
  )) as { clearedAt: number | null };
  expect(dismissed.clearedAt).not.toBeNull();
  await request(
    "POST",
    "/api/manual-steps/{id}/dismiss",
    404,
    undefined,
    "/api/manual-steps/missing/dismiss",
  );
  await request("POST", "/api/sessions/{id}/ack-manual-steps", 200);
  expect(s.deps.store.get(id)?.manualStepsAckedAt).not.toBeNull();
  await request(
    "POST",
    "/api/sessions/{id}/ack-manual-steps",
    404,
    undefined,
    "/api/sessions/missing/ack-manual-steps",
  );
});

test("build queue GET is non-null, writes validate, approval is a separate action", async () => {
  const p = "/api/sessions/{id}/queue";
  expect(await request("GET", p, 200)).toMatchObject({ sessionId: id, steps: [], approved: false });
  await request("GET", p, 404, undefined, "/api/sessions/missing/queue");
  for (const steps of [
    [{ title: "" }],
    [
      { id: "dup", title: "a" },
      { id: "dup", title: "b" },
    ],
    Array.from({ length: 101 }, () => ({ title: "x" })),
  ]) {
    await request("PUT", p, 400, { steps });
  }
  const q = (await request("PUT", p, 200, { steps: fx.build })) as { steps: { id: string }[] };
  expect(q.steps[0]?.id).toBe("one");
  await request("PUT", p, 404, { steps: fx.build }, "/api/sessions/missing/queue");
  expect(await request("GET", "/api/queues", 200)).toHaveProperty(id);
  const approved = (await request("POST", "/api/sessions/{id}/queue/approve", 200)) as {
    approved: boolean;
  };
  expect(approved.approved).toBe(true);
  await request(
    "POST",
    "/api/sessions/{id}/queue/approve",
    404,
    undefined,
    "/api/sessions/missing/queue/approve",
  );
});

test("clear-merged sends only the explicitly reviewed ids", async () => {
  const saved = s.deps.service.archiveMany;
  const savedLeftovers = s.deps.service.leftovers;
  const savedProbes = s.deps.service.leftoverProbesUnavailable;
  s.stubs.prCache.rows[id] = { state: "merged", checks: "success", deployConfigured: false };
  let targets: string[] = [];
  s.deps.service.archiveMany = async (ids) => {
    targets = ids;
    return { cleared: ids, leftovers: 0 };
  };
  s.deps.service.leftovers = () => [];
  s.deps.service.leftoverProbesUnavailable = () => true;
  try {
    expect(await request("GET", "/api/sessions/clear-merged", 200)).toEqual({
      ids: [id],
      leftovers: 0,
      probesUnavailable: true,
    });
    expect(await request("POST", "/api/sessions/clear-merged", 200, { ids: [] })).toEqual({
      cleared: [],
      leftovers: 0,
    });
    expect(targets).toEqual([]);
    await request("POST", "/api/sessions/clear-merged", 200, { ids: [id, "not-merged"] });
    expect(targets).toEqual([id]);
  } finally {
    s.deps.service.archiveMany = saved;
    s.deps.service.leftovers = savedLeftovers;
    s.deps.service.leftoverProbesUnavailable = savedProbes;
    delete s.stubs.prCache.rows[id];
  }
});

test("eight frames, including null-clearing variants, arrive over the socket", async () => {
  const cases: [string, unknown][] = [
    ["session:automerge", { id, enabled: null }],
    [
      "session:autopilot",
      { id, paused: true, complete: false, question: "Choose?", enabled: null },
    ],
    ["session:autopilot", { id, paused: false, complete: true, question: null }],
    ["session:merging", { id, since: 1, trainId: "train" }],
    ["session:merging", { id, since: null, trainId: null }],
    ["mergetrain:landed", { repoPath: s.validRepo }],
    ["post-merge-steps:changed", {}],
    [
      "session:manual-steps",
      { id, manualSteps: fx.steps.map(({ id, text, postMerge }) => ({ id, text, postMerge })) },
    ],
    ["session:manual-steps", { id, manualSteps: [], manualStepsAckedAt: 1 }],
    ["queue:update", s.deps.store.getBuildQueue(id)],
    ["drain:status", fx.drain],
  ];
  const frames = await collectEvents(s, token, async () => {
    for (const [name, data] of cases) s.deps.events.emit(name, data);
  });
  for (const name of EVENTS) {
    const received = frames.filter((f) => f.event === name);
    expect(received.length).toBeGreaterThan(0);
    for (const frame of received) validateEvent(frame.event, frame.data);
  }
});

test("backlog merge validates input, gates takeovers and maps classified failures", async () => {
  const p = "/api/prs/merge";
  const savedForge = s.stubs.resolveForge.forge;
  const savedRoles = s.deps.readRoles;
  const roles = { reviewer: "reviewer", merger: "owner" };
  const calls: { number: number; options: unknown }[] = [];
  let mergeImpl = async (number: number, options: unknown) => {
    calls.push({ number, options });
  };
  const forge = {
    kind: "github",
    mergeMethod: "squash",
    currentUser: async () => "operator",
    listPullRequests: async () => [{ number: 12, headRefName: "feature" }],
    prStatus: async () => takeoverStatus,
    merge: (number: number, options: unknown) => mergeImpl(number, options),
  };
  const send = async (status: number, body: Record<string, unknown>) => {
    validateRequest("POST", p, body);
    return await request("POST", p, status, body);
  };
  try {
    await request("POST", p, 400, { repo: "/outside", number: 12 });
    await request("POST", p, 400, { repo: s.validRepo });
    expect(await send(400, { repo: s.validRepo, number: 12 })).toEqual({
      error: "no forge for repo",
    });
    s.stubs.resolveForge.forge = forge;
    s.deps.readRoles = () => roles;
    expect(await send(409, { repo: s.validRepo, number: 12 })).toMatchObject({
      code: "merge_confirm_required",
      headSha: "head-a",
      baseRefName: "release",
      gate: { handoff: "reviewer", handoffWho: "reviewer", reviewBlockBy: "reviewer" },
    });
    expect(
      await send(409, {
        repo: s.validRepo,
        number: 12,
        confirm: { ...takeoverConfirm, headSha: "old" },
      }),
    ).toMatchObject({ code: "merge_confirm_stale" });
    expect(calls).toEqual([]);
    expect(
      await send(200, {
        repo: s.validRepo,
        number: 12,
        method: "rebase",
        deleteBranch: false,
        confirm: takeoverConfirm,
      }),
    ).toEqual({ ok: true });
    expect(calls).toEqual([
      {
        number: 12,
        options: {
          method: "rebase",
          deleteBranch: false,
          allowStacked: true,
          expectedHeadSha: "head-a",
        },
      },
    ]);
    const confirmed = { repo: s.validRepo, number: 12, confirm: takeoverConfirm };
    mergeImpl = async () => {
      throw new MergeConflictError("feature", "release");
    };
    expect(await send(409, confirmed)).toEqual({
      error: "merge conflict — resolve manually before merging",
    });
    mergeImpl = async () => {
      throw new Error("fixture failure");
    };
    expect(await send(502, confirmed)).toEqual({ error: "fixture failure" });
    expect(() => validateRequest("POST", p, { number: 12 })).toThrow();
    expect(() => validateRequest("POST", p, { repo: "r", number: 1, extra: true })).toThrow();
  } finally {
    s.stubs.resolveForge.forge = savedForge;
    s.deps.readRoles = savedRoles;
  }
});

test("this file owns its 401 sweep", async () => {
  for (const op of OPS.filter((o) => o.endsWith(" 401"))) {
    const [method, template] = op.split(" ") as [string, string];
    await request(method, template, 401, method === "GET" ? undefined : {}, undefined, false);
  }
});
describe("merge coverage gate — last", () => {
  test("nonempty block, every declared status and event", () => {
    expect(OPS.length).toBeGreaterThan(35);
    expect(EVENTS.length).toBe(8);
    const { operations, events } = coverage();
    expect(OPS.filter((o) => !operations.has(o))).toEqual([]);
    expect(EVENTS.filter((e) => !events.has(e))).toEqual([]);
  });
});
