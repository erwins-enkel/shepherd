import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fx from "./plan-fixtures";
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

const OPERATIONS = operationsForStream("plan");
const EVENTS = eventsForStream("plan");
let s: ContractServer;
let token: string;

function get(path: string, auth = true): Promise<Response> {
  return fetch(`${s.baseUrl}${path}`, { headers: auth ? bearer(token) : {} });
}
function post(path: string, auth = true): Promise<Response> {
  return fetch(`${s.baseUrl}${path}`, { method: "POST", headers: auth ? bearer(token) : {} });
}
function postJson(path: string, body: unknown, auth = true): Promise<Response> {
  return fetch(`${s.baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? bearer(token) : {}) },
    body: JSON.stringify(body),
  });
}
async function createSession(prompt: string): Promise<string> {
  const res = await postJson("/api/sessions", {
    repoPath: s.validRepo,
    baseBranch: "main",
    prompt,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}
beforeAll(async () => {
  await withAuth();
  s = startContractServer();
  ({ token } = await mintToken(s, await login(s), "plan contract test"));
});
afterAll(() => {
  try {
    s?.stop();
  } finally {
    restoreAuth();
  }
});

describe("plan gates", () => {
  test("the map and the in-flight list answer, and both 401", async () => {
    const id = await createSession("plan me");
    s.stubs.planGateCache.rows[id] = { ...fx.gate, sessionId: id };
    s.stubs.planGateCache.inflight = [{ ...fx.inflight, id }];
    try {
      const map = await get("/api/plan-gates");
      expect(map.status).toBe(200);
      const body = (await validateResponse("GET", "/api/plan-gates", map)) as Record<string, any>;
      expect(body[id].approved).toBe(true);
      // The gate preserves all six fixture block types through the real snapshot route.
      expect(body[id].blocks.map((b: { type: string }) => b.type)).toEqual([
        "rich-text",
        "callout",
        "file-tree",
        "checklist",
        "question-form",
        "table",
      ]);
      expect(body[id].answeredQuestionKeys).toEqual(["b5 q1"]);

      const flight = await get("/api/plan-gates/inflight");
      expect(flight.status).toBe(200);
      const rows = (await validateResponse("GET", "/api/plan-gates/inflight", flight)) as any[];
      expect(rows[0].effort).toBe("high");
    } finally {
      delete s.stubs.planGateCache.rows[id];
      s.stubs.planGateCache.inflight = [];
    }
    for (const path of ["/api/plan-gates", "/api/plan-gates/inflight"]) {
      const anon = await get(path, false);
      expect(anon.status).toBe(401);
      await validateResponse("GET", path, anon);
    }
  });
});

describe("go", () => {
  test("409 for an unreleasable gate AND for an unknown id — there is no 404", async () => {
    const id = await createSession("not approved");
    const refused = await post(`/api/sessions/${id}/go`);
    expect(refused.status).toBe(409);
    const body = (await validateResponse("POST", "/api/sessions/{id}/go", refused)) as {
      error: string;
    };
    expect(body.error).toBe("plan not approved or not in planning phase");

    // The same 409, not a 404: releasePlanGate answers false for a missing session
    // (src/server.ts:2905-2911). Declaring a 404 here would be a status the server never sends.
    const unknown = await post("/api/sessions/nope/go");
    expect(unknown.status).toBe(409);
    await validateResponse("POST", "/api/sessions/{id}/go", unknown);

    const anon = await post(`/api/sessions/${id}/go`, false);
    expect(anon.status).toBe(401);
    await validateResponse("POST", "/api/sessions/{id}/go", anon);
  });
});

describe("answer plan questions", () => {
  test("walks the whole guard ladder: 400, 404, 409, 409, 400, then 200", async () => {
    const id = await createSession("answer me");

    const badBody = await postJson(`/api/sessions/${id}/answer-plan-questions`, { answers: "no" });
    expect(badBody.status).toBe(400);
    await validateResponse("POST", "/api/sessions/{id}/answer-plan-questions", badBody);

    const unknown = await postJson("/api/sessions/nope/answer-plan-questions", { answers: [] });
    expect(unknown.status).toBe(404);
    await validateResponse("POST", "/api/sessions/{id}/answer-plan-questions", unknown);

    // planPhase is null on a fresh stub session, so this is the "not in planning phase" 409.
    const notPlanning = await postJson(`/api/sessions/${id}/answer-plan-questions`, {
      answers: [],
    });
    expect(notPlanning.status).toBe(409);
    const phase = (await validateResponse(
      "POST",
      "/api/sessions/{id}/answer-plan-questions",
      notPlanning,
    )) as { error: string };
    expect(phase.error).toBe("not in planning phase");

    s.deps.store.update(id, { planPhase: "planning" });
    const noQuestions = await postJson(`/api/sessions/${id}/answer-plan-questions`, {
      answers: [],
    });
    expect(noQuestions.status).toBe(409);
    const none = (await validateResponse(
      "POST",
      "/api/sessions/{id}/answer-plan-questions",
      noQuestions,
    )) as { error: string };
    expect(none.error).toBe("no plan questions");

    s.deps.store.putPlanGate({ ...fx.gate, sessionId: id });
    const unresolvable = await postJson(`/api/sessions/${id}/answer-plan-questions`, {
      answers: [{ blockId: "b5", questionId: "q1", optionIndices: [99] }],
    });
    // An out-of-range single index is DROPPED by resolvePlanAnswers, leaving nothing resolved.
    expect(unresolvable.status).toBe(400);
    await validateResponse("POST", "/api/sessions/{id}/answer-plan-questions", unresolvable);

    const ok = await postJson(`/api/sessions/${id}/answer-plan-questions`, {
      answers: [
        { blockId: "b5", questionId: "q1", optionIndices: [0] },
        { blockId: "b5", questionId: "q2", optionIndices: [] },
        { blockId: "b5", questionId: "q3", text: "60 seconds" },
      ],
    });
    expect(ok.status).toBe(200);
    const result = (await validateResponse(
      "POST",
      "/api/sessions/{id}/answer-plan-questions",
      ok,
    )) as { ok: boolean; delivered: boolean };
    expect(result.ok).toBe(true);
    expect(typeof result.delivered).toBe("boolean");
    // An EMPTY multi selection is a real answer ("none of these"), so its key is recorded.
    const merged = s.deps.store.getPlanGate(id);
    expect(merged?.answeredQuestionKeys).toContain("b5 q2");
  });
});

describe("review-plan and quota", () => {
  test("all three answer 202 with a status, and 404 on an unknown id", async () => {
    const id = await createSession("review my plan");
    for (const path of ["review-plan", "quota/resume", "quota/dismiss"]) {
      const ok = await post(`/api/sessions/${id}/${path}`);
      expect(ok.status).toBe(202);
      const template = `/api/sessions/{id}/${path}`;
      const body = (await validateResponse("POST", template, ok)) as {
        ok: boolean;
        status: string;
      };
      expect(body.ok).toBe(true);
      expect(typeof body.status).toBe("string");

      const unknown = await post(`/api/sessions/nope/${path}`);
      expect(unknown.status).toBe(404);
      await validateResponse("POST", template, unknown);

      const anon = await post(`/api/sessions/${id}/${path}`, false);
      expect(anon.status).toBe(401);
      await validateResponse("POST", template, anon);
    }
  });
});

describe("plan action status coverage", () => {
  test("go releases an approved planning session with a live conversation", async () => {
    const id = await createSession("approved plan");
    s.deps.store.update(id, { planPhase: "planning", claudeSessionId: "claude-plan-fixture" });
    s.deps.store.putPlanGate({ ...fx.gate, sessionId: id });
    const ok = await post(`/api/sessions/${id}/go`);
    expect(ok.status).toBe(200);
    expect(await validateResponse("POST", "/api/sessions/{id}/go", ok)).toEqual({ ok: true });
    expect(s.deps.store.get(id)?.planPhase).toBe("executing");
  });

  test("answer-plan-questions requires authentication", async () => {
    const anon = await postJson("/api/sessions/nope/answer-plan-questions", { answers: [] }, false);
    expect(anon.status).toBe(401);
    await validateResponse("POST", "/api/sessions/{id}/answer-plan-questions", anon);
  });

  test("critic quota resume distinguishes a missing forge from a failed forge lookup", async () => {
    const id = await createSession("critic stalled");
    s.deps.store.update(id, { status: "done" });
    s.deps.store.putReview({
      sessionId: id,
      headSha: "abc",
      patchId: "p1",
      decision: "changes_requested",
      summary: "fix it",
      body: "body",
      findings: ["finding 1"],
      addressRound: 3,
      addressCap: 3,
      streakReviews: 1,
      reviewedPatchIds: [],
      errorRound: 0,
      finalRoundPending: false,
      finalRoundTimeoutMs: 60000,
      seenNoteIds: [],
      updatedAt: 0,
    });
    const saved = s.stubs.resolveForge.forge;
    try {
      s.stubs.resolveForge.forge = null;
      const absent = await post(`/api/sessions/${id}/quota/resume`);
      expect(absent.status).toBe(404);
      expect(await validateResponse("POST", "/api/sessions/{id}/quota/resume", absent)).toEqual({
        error: "no forge for this repo",
      });
      s.stubs.resolveForge.forge = {
        kind: "gitea",
        prStatus: async () => {
          throw new Error("forge boom");
        },
      };
      const failed = await post(`/api/sessions/${id}/quota/resume`);
      expect(failed.status).toBe(502);
      expect(await validateResponse("POST", "/api/sessions/{id}/quota/resume", failed)).toEqual({
        error: "forge boom",
      });
    } finally {
      s.stubs.resolveForge.forge = saved;
    }
  });
});

describe("plan events", () => {
  test("validates both gate frame shapes, both reviewing edges and reviewer activity", async () => {
    const id = await createSession("plan events");
    const payloads = [
      { event: "session:plangate", data: { id, gate: { ...fx.gate, sessionId: id } } },
      { event: "session:plangate", data: { id, planPhase: "executing" } },
      {
        event: "session:plangate-reviewing",
        data: {
          id,
          reviewing: true,
          env: { provider: "claude", model: "claude-opus-5", effort: "high" },
        },
      },
      { event: "session:plangate-reviewing", data: { id, reviewing: false } },
      { event: "session:plangate-activity", data: { id, summary: "Reading the plan" } },
    ];
    const frames = await collectEvents(s, token, async () => {
      for (const frame of payloads) s.deps.events.emit(frame.event, frame.data);
    });
    // Assert receipt independently of the contract: an empty event block must fail RED too.
    expect(frames.filter((frame) => frame.event.startsWith("session:plangate"))).toEqual(payloads);
    for (const frame of payloads) validateEvent(frame.event, frame.data);
  });
});

describe("plan read-side schema regressions", () => {
  test.each([
    { type: "question-form", id: "bad-questions", questions: "not an array" },
    { type: "question-form", id: "bad-question", questions: [{ id: "q1" }] },
    { type: "file-tree", id: "bad-path", entries: [{ path: 42, change: "added" }] },
    { type: "rich-text" },
  ])("rejects malformed known block: %j", async (block) => {
    await expect(
      validateResponse(
        "GET",
        "/api/plan-gates",
        Response.json({
          [fx.gate.sessionId]: { ...fx.gate, blocks: [block] },
        }),
      ),
    ).rejects.toThrow();
  });

  test("preserves a genuinely unknown block with markdown", async () => {
    const body = {
      [fx.gate.sessionId]: {
        ...fx.gate,
        blocks: [{ type: "future-chart", markdown: "Fallback chart" }],
      },
    };
    expect(await validateResponse("GET", "/api/plan-gates", Response.json(body))).toEqual(body);
  });

  test("accepts an unknown wireframe surface", async () => {
    const body = {
      [fx.gate.sessionId]: {
        ...fx.gate,
        blocks: [{ type: "wireframe", id: "future", surface: "spatial", html: "<p>Plan</p>" }],
      },
    };
    expect(await validateResponse("GET", "/api/plan-gates", Response.json(body))).toEqual(body);
  });

  test("accepts an unknown plan phase in an event", () => {
    expect(() =>
      validateEvent("session:plangate", {
        id: "future-session",
        planPhase: "verifying",
      }),
    ).not.toThrow();
  });
});

// Stays LAST: every declared status/event must be driven by this file.
describe("plan coverage gate", () => {
  test("every plan operation and event was exercised", () => {
    const { operations, events } = coverage();
    expect(OPERATIONS.filter((operation) => !operations.has(operation))).toEqual([]);
    expect(EVENTS.filter((event) => !events.has(event))).toEqual([]);
  });
});
