import { test, expect } from "bun:test";
import { createTypeSafeJudge, judgeCostUsd, JUDGE_INPUT_USD_PER_MTOK } from "../src/judge-typesafe";
import { JudgeError } from "../src/judge";
import { isCannotRun, isPermanent } from "../scripts/eval-core";

// HERMETIC, and deliberately NOT mocked at the SDK boundary: `fetch` is injected, so every test
// below drives the REAL SDK — its retry policy, its error classes, its parsing — with no network
// and no key. Mocking the SDK would test our stub instead of the thing that ships.

const MODEL = "jev-1.13.0";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function okBody(over: Record<string, unknown> = {}) {
  return {
    model: MODEL,
    answers: {
      kind: {
        type: "choice",
        choice: "gate",
        confidence: 0.64,
        probabilities: { gate: 0.72, unknown: 0.28 },
      },
    },
    usage: { input_tokens: 1_900, output_tokens: 0 },
    ...over,
  };
}

function judge(
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
  deadlineMs = 8_000,
) {
  return createTypeSafeJudge({
    apiKey: "test-key",
    baseUrl: "https://judge.test",
    model: MODEL,
    deadlineMs,
    fetch: fetchImpl,
  });
}

const QUESTION = {
  kind: {
    type: "choice" as const,
    instructions: "why did it stop?",
    criteria: { gate: null, unknown: null },
  },
};

// ── the happy path ──────────────────────────────────────────────────────────────

test("a choice answer crosses the seam as its raw distribution, plus the vendor scalar by its own name", async () => {
  const result = await judge(async () => jsonResponse(okBody())).ask("THE PROMPT", QUESTION);

  expect(result.answers.kind).toEqual({
    type: "choice",
    choice: "gate",
    probabilities: { gate: 0.72, unknown: 0.28 },
    vendorConfidence: 0.64,
  });
  // The model that ANSWERED, as reported — not the one we asked for. A silent vendor re-point is
  // then visible after the fact rather than indistinguishable from a prompt change.
  expect(result.model).toBe(MODEL);
  expect(result.usage).toEqual({ inputTokens: 1_900, outputTokens: 0 });
  expect(result.costUsd).toBeCloseTo(judgeCostUsd(1_900), 12);
});

test("the pinned model and configured base URL are what actually go on the wire", async () => {
  const seen: { url: string; body: unknown; auth: string | null }[] = [];
  await judge(async (url, init) => {
    seen.push({
      url,
      body: JSON.parse(String(init?.body)),
      auth: new Headers(init?.headers).get("authorization"),
    });
    return jsonResponse(okBody());
  }).ask("THE PROMPT", QUESTION);

  expect(seen[0]!.url).toStartWith("https://judge.test");
  expect(seen[0]!.auth).toBe("Bearer test-key");
  const body = seen[0]!.body as { model: string; state: unknown; questions: unknown };
  // NEVER the SDK's own `jev-latest` default: under a floating alias a vendor re-point would land
  // as a silent accuracy change rather than a version bump.
  expect(body.model).toBe(MODEL);
  // The production prompt VERBATIM as state — the framing the measurement picked.
  expect(body.state).toBe("THE PROMPT");
  expect(body.questions).toEqual({
    kind: {
      type: "choice",
      instructions: "why did it stop?",
      criteria: { gate: null, unknown: null },
    },
  });
});

test("a noul answers to a probability and nothing else", async () => {
  const result = await judge(async () =>
    jsonResponse({
      model: MODEL,
      answers: { waiting: { type: "noul", noul: 0.81 } },
      usage: { input_tokens: 10, output_tokens: 0 },
    }),
  ).ask("s", { waiting: { type: "noul", instructions: "is it waiting?" } });

  expect(result.answers.waiting).toEqual({ type: "noul", p: 0.81 });
});

// ── failure modes: every one of these must be a JudgeError the caller can fall back from ────────

test("an HTTP error becomes a JudgeError whose message leads with the status", async () => {
  const body = { detail: { error_type: "authentication_error", message: "Cannot authenticate." } };
  const err = (await judge(async () => jsonResponse(body, 401))
    .ask("s", QUESTION)
    .catch((e: unknown) => e)) as JudgeError;

  expect(err).toBeInstanceOf(JudgeError);
  expect(err.status).toBe(401);
  // The eval harness classifies transport failures by matching this text. A 401 must fail the run
  // fast; a 429 must read as "cannot call right now" rather than as a prompt regression.
  expect(isPermanent(err.message)).toBe(true);
  expect(isCannotRun(err.message)).toBe(true);
});

test("a rate limit is retried by the SDK and, if it persists, surfaces as a non-permanent failure", async () => {
  let calls = 0;
  const err = (await judge(async () => {
    calls++;
    return jsonResponse({ detail: "slow down" }, 429);
  })
    .ask("s", QUESTION)
    .catch((e: unknown) => e)) as JudgeError;

  expect(err.status).toBe(429);
  // Retrying 429 with backoff is the whole reason the transport is the official SDK rather than the
  // spike's hand-rolled `fetch`, which met a 429 by failing on the first response.
  expect(calls).toBeGreaterThan(1);
  expect(isPermanent(err.message)).toBe(false);
  expect(isCannotRun(err.message)).toBe(true);
});

test("a connection failure becomes a JudgeError with no status", async () => {
  const err = (await judge(async () => {
    throw new TypeError("fetch failed");
  })
    .ask("s", QUESTION)
    .catch((e: unknown) => e)) as JudgeError;

  expect(err).toBeInstanceOf(JudgeError);
  expect(err.status).toBeUndefined();
});

test("the TOTAL deadline aborts, rather than the SDK's per-attempt timeout times its retries", async () => {
  // The SDK's own `timeout` is per attempt with no total retry budget, so without the deadline a
  // rate-limited call honouring `Retry-After` can outlast the 120 s spawn the judge exists to be
  // faster than. This is that guard.
  const started = Date.now();
  // A hang that honours `signal`, exactly as a real `fetch` does — the SDK forwards the caller's
  // signal into the transport, so a stub that ignored it would prove nothing.
  const hang = (_url: string, init?: RequestInit): Promise<Response> =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason as Error));
    });
  const err = (await judge(hang, 60)
    .ask("s", QUESTION)
    .catch((e: unknown) => e)) as JudgeError;

  expect(err).toBeInstanceOf(JudgeError);
  expect(err.message).toContain("deadline");
  // Bounded by the deadline, NOT by the 1s per-attempt floor multiplied by three attempts.
  expect(Date.now() - started).toBeLessThan(1_000);
});

test("a missing answer for a question we asked is an error, not an empty verdict", async () => {
  const err = (await judge(async () =>
    jsonResponse({ model: MODEL, answers: {}, usage: { input_tokens: 1, output_tokens: 0 } }),
  )
    .ask("s", QUESTION)
    .catch((e: unknown) => e)) as JudgeError;

  expect(err).toBeInstanceOf(JudgeError);
  expect(err.message).toContain("kind");
});

test("an answer of an unrecognised type fails loudly instead of being coerced", async () => {
  // Unreachable against a conforming backend — and reachable against a non-conforming one, which
  // the configurable base URL makes possible.
  const err = (await judge(async () =>
    jsonResponse({
      model: MODEL,
      answers: { kind: { type: "rank", rank: 1 } },
      usage: { input_tokens: 1, output_tokens: 0 },
    }),
  )
    .ask("s", QUESTION)
    .catch((e: unknown) => e)) as JudgeError;

  expect(err).toBeInstanceOf(JudgeError);
  expect(err.message).toContain("unrecognised");
});

test("a response with no usage block prices at zero rather than throwing", async () => {
  const result = await judge(async () => jsonResponse(okBody({ usage: undefined }))).ask(
    "s",
    QUESTION,
  );
  expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  expect(result.costUsd).toBe(0);
});

// ── pricing ─────────────────────────────────────────────────────────────────────

test("input is billed and output is free", () => {
  expect(judgeCostUsd(1_000_000)).toBeCloseTo(JUDGE_INPUT_USD_PER_MTOK, 9);
  // A realistic classifier call is a couple of thousand tokens — a small fraction of a cent, which
  // is what makes the metered call admissible against the subscription-spawn doctrine at all.
  expect(judgeCostUsd(2_000)).toBeLessThan(0.001);
});
