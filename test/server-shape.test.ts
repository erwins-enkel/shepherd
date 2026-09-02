import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { makeApp, slowRequestTimeoutSec, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { config } from "../src/config";
import { SHAPE_BLOCK_ID, type ShapeResult } from "../src/task-shape";

let tmpRoot: string;
let repoDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-shape-api-"));
  repoDir = join(tmpRoot, "repo");
  mkdirSync(repoDir);
});
afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

const round: ShapeResult = {
  draft: { problem: "leaks", outcome: "no leaks", constraints: [], nonGoals: [] },
  block: {
    type: "question-form",
    id: SHAPE_BLOCK_ID,
    questions: [
      { id: "q1", prompt: "Which reaper?", kind: "single", options: ["tab", "transient"] },
      { id: "q2", prompt: "Out of scope?", kind: "freeform" },
    ],
  },
};

function harness(shapeTask?: AppDeps["shapeTask"]) {
  const calls: { repoPath: string; prompt: string; provider: string; model: string | null }[] = [];
  const wrapped: AppDeps["shapeTask"] = shapeTask
    ? async (repoPath, prompt, provider, model) => {
        calls.push({ repoPath, prompt, provider, model });
        return shapeTask(repoPath, prompt, provider, model);
      }
    : undefined;
  const deps = {
    store: new SessionStore(":memory:"),
    service: {} as never,
    shapeTask: wrapped,
  } as unknown as AppDeps;
  return { app: makeApp(deps), calls };
}

const post = (path: string, body: unknown) =>
  new Request(`http://x${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("POST /api/shape runs the round and returns the draft + question block", async () => {
  const { app, calls } = harness(async () => round);
  const res = await app.fetch(
    post("/api/shape", {
      repoPath: repoDir,
      prompt: "make the reaper stop leaking",
      provider: "claude",
      model: "opus",
    }),
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(round);
  // The route hands the CONTAINMENT-CHECKED path down, not the caller's string.
  expect(calls[0]?.repoPath).toBe(realpathSync(repoDir));
  expect(calls[0]?.provider).toBe("claude");
});

test("POST /api/shape rejects a repo outside the configured root before any spawn", async () => {
  const { app, calls } = harness(async () => round);
  const res = await app.fetch(
    post("/api/shape", {
      repoPath: "/etc",
      prompt: "x",
      provider: "claude",
      model: "opus",
    }),
  );
  expect(res.status).toBe(400);
  expect(calls).toHaveLength(0);
});

test('POST /api/shape maps an absent model to null — never the picker\'s "default" string', async () => {
  const { app, calls } = harness(async () => round);
  // The New Task picker's "default" option is normalised client-side; the route must accept the
  // resulting null rather than forcing a literal through to `--model`.
  const res = await app.fetch(
    post("/api/shape", { repoPath: repoDir, prompt: "x", provider: "claude", model: null }),
  );
  expect(res.status).toBe(200);
  expect(calls[0]?.model).toBeNull();

  await app.fetch(post("/api/shape", { repoPath: repoDir, prompt: "x", provider: "claude" }));
  expect(calls[1]?.model).toBeNull();
});

test("POST /api/shape validates the body and 503s when the helper is unwired", async () => {
  const { app } = harness(async () => round);
  for (const body of [
    { repoPath: repoDir, prompt: 1, provider: "claude", model: "opus" },
    { repoPath: repoDir, prompt: "x", provider: "gemini", model: "opus" },
    { repoPath: repoDir, prompt: "x", provider: "claude", model: "" },
    { repoPath: repoDir, prompt: "x", provider: "claude", model: 7 },
  ]) {
    expect((await app.fetch(post("/api/shape", body))).status).toBe(400);
  }
  const unwired = harness(undefined);
  const res = await unwired.app.fetch(
    post("/api/shape", { repoPath: repoDir, prompt: "x", provider: "claude", model: "opus" }),
  );
  expect(res.status).toBe(503);
});

test("POST /api/shape maps a helper failure to 422 with its reason", async () => {
  const { app } = harness(async () => ({ error: "timeout" }) as ShapeResult);
  const res = await app.fetch(
    post("/api/shape", { repoPath: repoDir, prompt: "x", provider: "claude", model: "opus" }),
  );
  expect(res.status).toBe(422);
  expect(await res.json()).toEqual({ error: "timeout" });
});

test("POST /api/shape/brief composes the answered round into an intent-shaped brief", async () => {
  const { app } = harness(async () => round);
  const res = await app.fetch(
    post("/api/shape/brief", {
      draft: round.draft,
      block: round.block,
      answers: [
        { blockId: SHAPE_BLOCK_ID, questionId: "q1", optionIndices: [1] },
        { blockId: SHAPE_BLOCK_ID, questionId: "q2", text: "herdr itself" },
      ],
    }),
  );
  expect(res.status).toBe(200);
  const { brief } = (await res.json()) as { brief: string };
  expect(brief).toContain("## Problem\nleaks");
  expect(brief).toContain("- Which reaper?\n  → transient");
  expect(brief).toContain("- Out of scope?\n  → herdr itself");
  expect(brief).not.toContain("## Open questions");
});

test("POST /api/shape/brief drops answers that match no question, keeping them open", async () => {
  const { app } = harness(async () => round);
  const res = await app.fetch(
    post("/api/shape/brief", {
      draft: round.draft,
      block: round.block,
      answers: [
        { blockId: "somewhere-else", questionId: "q1", optionIndices: [0] },
        { blockId: SHAPE_BLOCK_ID, questionId: "q9", text: "invented" },
        { blockId: SHAPE_BLOCK_ID, questionId: "q1", optionIndices: [99] },
      ],
    }),
  );
  const { brief } = (await res.json()) as { brief: string };
  expect(brief).not.toContain("invented");
  expect(brief).toContain("## Open questions\n- Which reaper?\n- Out of scope?");
});

test("POST /api/shape/brief 400s an empty round", async () => {
  const { app } = harness(async () => round);
  const res = await app.fetch(
    post("/api/shape/brief", { draft: {}, block: { questions: [] }, answers: [] }),
  );
  expect(res.status).toBe(400);
});

test("the shaping round gets an idle budget; the pure compose route stays on the default", () => {
  const sec = (method: string, path: string) =>
    slowRequestTimeoutSec(new Request(`http://x${path}`, { method }), new URL(`http://x${path}`));
  // The round polls a transient agent for up to 180s — on Bun's 10s default the socket is severed
  // mid-round and the card shows a failure for a round still running.
  expect(sec("POST", "/api/shape")).toBe(255);
  expect(sec("POST", "/api/shape/brief")).toBeNull();
  expect(sec("GET", "/api/shape")).toBeNull();
});
