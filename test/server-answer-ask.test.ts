import { test, expect } from "bun:test";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import type { AnswerAskOutcome } from "../src/ask-answer-service";

function harness(outcome: AnswerAskOutcome, provider?: "claude" | "codex") {
  const store = new SessionStore(":memory:");
  const calls: unknown[][] = [];
  const deps: AppDeps = {
    store,
    service: {} as any,
    events: new EventHub(),
    usageLimits: { limits: () => ({}) } as any,
    askAnswers: {
      answer: async (...args) => {
        calls.push(args);
        return outcome;
      },
    },
  };
  const session = store.create({
    name: "t",
    prompt: "p",
    repoPath: "/wt",
    baseBranch: "main",
    branch: "shepherd/t",
    worktreePath: "/wt",
    isolated: false,
    herdrSession: "s",
    herdrAgentId: "a",
    claudeSessionId: "c",
    model: null,
    ...(provider ? { agentProvider: provider } : {}),
  });
  return { app: makeApp(deps), session, calls };
}

const post = (app: ReturnType<typeof makeApp>, id: string, body: unknown) =>
  app.fetch(
    new Request(`http://x/api/sessions/${id}/answer-ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const BODY = { toolUseId: "toolu_1", answers: [{ blockId: "toolu_1", questionId: "0", optionIndices: [1] }] };

test("200 with the verification result, answers forwarded", async () => {
  const h = harness({ ok: true, result: "verified" });
  const res = await post(h.app, h.session.id, BODY);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ result: "verified" });
  expect(h.calls[0]).toEqual([h.session.id, "toolu_1", BODY.answers]);
});

test("service refusals map to their status", async () => {
  const h = harness({ ok: false, status: 409, error: "ask_in_flight" });
  const res = await post(h.app, h.session.id, BODY);
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "ask_in_flight" });
});

test("400 on a malformed body, 404 unknown session, 409 non-claude", async () => {
  const h = harness({ ok: true, result: "verified" });
  expect((await post(h.app, h.session.id, { answers: [] })).status).toBe(400);
  expect(
    (await post(h.app, h.session.id, { toolUseId: "t", answers: [{ questionId: "0", optionIndices: "1" }] }))
      .status,
  ).toBe(400);
  expect((await post(h.app, "nope", BODY)).status).toBe(404);
  const codex = harness({ ok: true, result: "verified" }, "codex");
  expect((await post(codex.app, codex.session.id, BODY)).status).toBe(409);
  expect(codex.calls).toHaveLength(0);
});
