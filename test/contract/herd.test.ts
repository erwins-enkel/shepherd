import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fx from "./herd-fixtures";
import {
  bearer,
  collectEvents,
  coverage,
  login,
  mintToken,
  restoreAuth,
  startContractServer,
  validateEvent,
  validateResponse,
  withAuth,
  type ContractServer,
} from "./harness";
import { eventsForStream, operationsForStream } from "./stream-blocks";

/** This block's own coverage gate, derived from the contract rather than hand-kept: a status
 *  declared in `paths:` but forgotten here is declared-but-unexercised, and nothing else catches
 *  it. `openapi.test.ts`'s gate subtracts this block. */
const OPERATIONS = operationsForStream("herd");
const EVENTS = eventsForStream("herd");

let s: ContractServer;
let token: string;

async function get(path: string, auth = true): Promise<Response> {
  return fetch(`${s.baseUrl}${path}`, { headers: auth ? bearer(token) : {} });
}

async function post(path: string, auth = true): Promise<Response> {
  return fetch(`${s.baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? bearer(token) : {}) },
    body: "{}",
  });
}

async function createSession(prompt: string): Promise<string> {
  const res = await fetch(`${s.baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(token) },
    body: JSON.stringify({ repoPath: s.validRepo, baseBranch: "main", prompt }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

beforeAll(async () => {
  await withAuth();
  s = startContractServer();
  ({ token } = await mintToken(s, await login(s), "herd contract test"));
});
afterAll(() => {
  try {
    s?.stop();
  } finally {
    restoreAuth();
  }
});

describe("bulk git", () => {
  test("answers a session-id map with every field the classifier reads", async () => {
    const id = await createSession("classify me");
    // Seeded through the harness dep S0-prep-2 wired: without it the route answers {} and the
    // schema is declared-but-unproven. Restored at the end of the test, per the stubs contract.
    s.stubs.prCache.rows[id] = fx.gitOpenGreenHandedOff;
    try {
      const ok = await get("/api/git");
      expect(ok.status).toBe(200);
      const body = (await validateResponse("GET", "/api/git", ok)) as Record<string, unknown>;
      const row = body[id] as Record<string, unknown>;
      // Four of these are the properties S0-prep-2 added to `GitState`; `noCi` was already there.
      expect(row.noCi).toBe(false);
      expect(row.handoff).toBe("reviewer");
      expect(row.handoffWho).toBe("reviewer-one");
      expect(row.headSha).toBe(fx.gitOpenGreenHandedOff.headSha);
      s.stubs.prCache.rows[id] = fx.gitChangesRequested;
      const second = await get("/api/git");
      const blocked = ((await validateResponse("GET", "/api/git", second)) as Record<string, any>)[
        id
      ];
      expect(blocked.reviewBlock.state).toBe("changes_requested");
    } finally {
      delete s.stubs.prCache.rows[id];
    }
  });

  test("401 without a credential", async () => {
    const anon = await get("/api/git", false);
    expect(anon.status).toBe(401);
    await validateResponse("GET", "/api/git", anon);
  });
});

describe("bulk activity and liveness", () => {
  test("both answer maps and both 401", async () => {
    const id = await createSession("активность");
    s.stubs.activity.rows[id] = fx.activity;
    s.stubs.claudeAlive.rows[id] = true;
    try {
      const act = await get("/api/activity");
      expect(act.status).toBe(200);
      const actBody = (await validateResponse("GET", "/api/activity", act)) as Record<string, any>;
      expect(actBody[id].recentTs.length).toBe(3);
      expect(actBody[id].recentErrTs).toEqual([1_800_000_020_000]);

      const alive = await get("/api/claude-alive");
      expect(alive.status).toBe(200);
      const aliveBody = (await validateResponse("GET", "/api/claude-alive", alive)) as Record<
        string,
        boolean
      >;
      expect(aliveBody[id]).toBe(true);
    } finally {
      delete s.stubs.activity.rows[id];
      delete s.stubs.claudeAlive.rows[id];
    }

    for (const path of ["/api/activity", "/api/claude-alive"]) {
      const anon = await get(path, false);
      expect(anon.status).toBe(401);
      await validateResponse("GET", path, anon);
    }
  });
});

describe("reviews", () => {
  test("the verdict map and the in-flight list both answer, and both 401", async () => {
    const id = await createSession("review me");
    s.stubs.reviewCache.rows[id] = { ...fx.verdict, sessionId: id };
    s.stubs.reviewCache.inflight = [{ ...fx.reviewerEnv, id }];
    try {
      const verdicts = await get("/api/reviews");
      expect(verdicts.status).toBe(200);
      const body = (await validateResponse("GET", "/api/reviews", verdicts)) as Record<string, any>;
      expect(body[id].decision).toBe("changes_requested");
      expect(body[id].addressCap).toBe(3);

      const inflight = await get("/api/reviews/inflight");
      expect(inflight.status).toBe(200);
      const rows = (await validateResponse("GET", "/api/reviews/inflight", inflight)) as any[];
      expect(rows[0].id).toBe(id);
      expect(rows[0].provider).toBe("claude");
    } finally {
      delete s.stubs.reviewCache.rows[id];
      s.stubs.reviewCache.inflight = [];
    }

    for (const path of ["/api/reviews", "/api/reviews/inflight"]) {
      const anon = await get(path, false);
      expect(anon.status).toBe(401);
      await validateResponse("GET", path, anon);
    }
  });
});

describe("review-pr trigger", () => {
  test("202 with a status, 404 twice, 401", async () => {
    const id = await createSession("trigger a critic run");
    // The harness's `resolveForge` returns null, so this is the SECOND 404 body
    // this route can answer, and the one reachable here. The 202 path needs a forge; the stub
    // below supplies the minimum `resolveGitState` reads.
    const noForge = await post(`/api/sessions/${id}/review-pr`);
    expect(noForge.status).toBe(404);
    const noForgeBody = (await validateResponse(
      "POST",
      "/api/sessions/{id}/review-pr",
      noForge,
    )) as {
      error: string;
    };
    expect(noForgeBody.error).toBe("no forge for this repo");

    const unknown = await post("/api/sessions/nope/review-pr");
    expect(unknown.status).toBe(404);
    const unknownBody = (await validateResponse(
      "POST",
      "/api/sessions/{id}/review-pr",
      unknown,
    )) as {
      error: string;
    };
    expect(unknownBody.error).toBe("not found");

    const saved = s.deps.resolveForge;
    const savedTrigger = s.deps.reviewTrigger;
    s.deps.resolveForge = () => ({ prStatus: async () => fx.gitOpenGreenHandedOff }) as never;
    s.deps.reviewTrigger = { force: async () => "started" } as never;
    try {
      const ok = await post(`/api/sessions/${id}/review-pr`);
      expect(ok.status).toBe(202);
      const body = (await validateResponse("POST", "/api/sessions/{id}/review-pr", ok)) as {
        ok: boolean;
        status: string;
      };
      expect(body.ok).toBe(true);
      expect(body.status).toBe("started");
    } finally {
      s.deps.resolveForge = saved;
      s.deps.reviewTrigger = savedTrigger;
    }

    const anon = await post(`/api/sessions/${id}/review-pr`, false);
    expect(anon.status).toBe(401);
    await validateResponse("POST", "/api/sessions/{id}/review-pr", anon);
  });
});

describe("review-pr forge failure", () => {
  test("502 when resolving the PR state throws", async () => {
    const id = await createSession("forge lookup fails");
    const saved = s.deps.resolveForge;
    s.deps.resolveForge = () =>
      ({
        prStatus: async () => {
          throw new Error("forge lookup failed");
        },
      }) as never;
    try {
      const failed = await post(`/api/sessions/${id}/review-pr`);
      expect(failed.status).toBe(502);
      const body = (await validateResponse("POST", "/api/sessions/{id}/review-pr", failed)) as {
        error: string;
      };
      expect(body.error).toBe("forge lookup failed");
    } finally {
      s.deps.resolveForge = saved;
    }
  });
});

describe("events", () => {
  test("the four herd frames validate against their declared schemas", async () => {
    // `collectEvents(server, token, drive)` — it opens the socket, runs `drive`, then settles.
    // Emitting before it is listening loses the frames.
    const frames = await collectEvents(s, token, async () => {
      s.deps.events.emit("session:review", { id: "sess_fixture", review: fx.verdict });
      s.deps.events.emit("session:reviewing", {
        id: "sess_fixture",
        reviewing: true,
        env: { provider: "claude", model: "claude-opus-5", effort: "high" },
      });
      s.deps.events.emit("session:critic-activity", {
        id: "sess_fixture",
        summary: "reading src/limiter.ts",
      });
      for (const liveness of ["alive", "husk", "stranded"] as const) {
        s.deps.events.emit(
          "session:claude-alive",
          fx.claudeAliveEvent("sess_fixture", liveness === "alive", liveness),
        );
      }
    });
    expect(frames.filter((frame) => frame.event === "session:claude-alive")).toHaveLength(3);
    for (const frame of frames) validateEvent(frame.event, frame.data);
  });
});

// Stays LAST in this file, like every other stream's gate.
describe("herd coverage gate", () => {
  test("every operation and event in the herd block was exercised", () => {
    // `coverage()` takes no arguments and returns `{operations, events}` as Sets — the same
    // shape `detail.test.ts:397-403` and `actions.test.ts:302` use. Do not invent a signature.
    const { operations, events } = coverage();
    expect(OPERATIONS.filter((o) => !operations.has(o))).toEqual([]);
    expect(EVENTS.filter((e) => !events.has(e))).toEqual([]);
  });
});
