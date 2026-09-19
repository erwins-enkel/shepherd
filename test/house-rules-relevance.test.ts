import { test, expect } from "bun:test";
import {
  MAX_JUDGED_RULES,
  RELEVANCE_DROP_BELOW,
  interpretRelevance,
  isRelevanceMode,
  judgeHouseRuleRelevance,
  normalizeRelevanceMode,
  relevanceQuestion,
  relevanceState,
  type RelevanceDeps,
} from "../src/house-rules-relevance";
import type { Judge, JudgeQuestion, JudgeResult } from "../src/judge";
import { JudgeError } from "../src/judge";
import type { Learning } from "../src/types";

function rule(id: string, text = `rule ${id}`): Learning {
  return {
    id,
    repoPath: "/repo",
    rule: text,
    rationale: "",
    evidence: [],
    status: "active",
    evidenceCount: 0,
    ineffectiveCount: 0,
    helpfulCount: 0,
    injectedCount: 0,
    lastUsedAt: null,
    retiredAt: null,
    retiredReason: null,
    scopeGlobs: [],
    createdAt: 0,
    updatedAt: 0,
    lastEvidenceAt: null,
    promotedPrUrl: null,
    mergedIntoId: null,
    trialedAt: null,
    reTrialBlockedAt: null,
    distinctKinds: 0,
    distinctSessions: 0,
  };
}

const CTX = { prompt: "rewrite the settings panel", targetPaths: ["ui/src/lib/x.svelte"] };

/** A judge that answers every question with `p`, recording what it was asked. */
function stubJudge(p: number | ((key: string, i: number) => number), costUsd = 0.000_02) {
  const seen: { state: unknown; questions: Record<string, JudgeQuestion> }[] = [];
  const judge: Judge = {
    async ask(state, questions) {
      seen.push({ state, questions: questions as Record<string, JudgeQuestion> });
      const answers: Record<string, { type: "noul"; p: number }> = {};
      Object.keys(questions).forEach((key, i) => {
        answers[key] = { type: "noul", p: typeof p === "number" ? p : p(key, i) };
      });
      return {
        answers,
        model: "jev-test",
        usage: { inputTokens: 100, outputTokens: 0 },
        costUsd,
      } as unknown as JudgeResult<typeof questions>;
    },
  };
  return { judge, seen };
}

function deps(over: Partial<RelevanceDeps> = {}): RelevanceDeps {
  return { judge: null, mode: "enforce", warn: () => {}, ...over };
}

// ── the question and the state ──────────────────────────────────────────────────

test("the state leads with the operator's request and ends with the paths", () => {
  const state = relevanceState({
    prompt: "THE REQUEST",
    issueTitle: "THE TITLE",
    issueBody: "THE BODY",
    targetPaths: ["src/a.ts"],
  });
  // Order is a tunable, not cosmetics — the model anchors on what it reads first.
  expect(state.indexOf("THE REQUEST")).toBeLessThan(state.indexOf("THE TITLE"));
  expect(state.indexOf("THE TITLE")).toBeLessThan(state.indexOf("THE BODY"));
  expect(state.indexOf("THE BODY")).toBeLessThan(state.indexOf("src/a.ts"));
});

test("absent issue/paths contribute no empty sections", () => {
  expect(relevanceState({ prompt: "just this", targetPaths: [] })).toBe(
    "The operator asked a coding agent to do this, in this repository:\njust this",
  );
  // A whitespace-only issue title is as absent as a missing one.
  expect(relevanceState({ prompt: "p", issueTitle: "   ", targetPaths: [] })).not.toContain(
    "attached to this issue",
  );
});

test("the question carries the rule line and both criteria branches", () => {
  const q = relevanceQuestion(rule("a", "column added by ALTER missing from update()"));
  expect(q.type).toBe("noul");
  expect(q.instructions).toContain("column added by ALTER missing from update()");
  // criteria.false is the anti-overreach slot for the vendor's "literal reading" failure mode.
  expect(q.criteria?.true).toBeTruthy();
  expect(q.criteria?.false).toContain("not itself a reason to answer no");
});

test("isRelevanceMode accepts exactly the three modes", () => {
  expect(["off", "shadow", "enforce"].every(isRelevanceMode)).toBe(true);
  expect(isRelevanceMode("Enforce")).toBe(false);
  expect(isRelevanceMode(undefined)).toBe(false);
  expect(isRelevanceMode(1)).toBe(false);
});

// ── interpretation ──────────────────────────────────────────────────────────────

test("a defective answer counts as RELEVANT — the gate can only subtract", () => {
  const rules = [rule("a"), rule("b"), rule("c"), rule("d"), rule("e")];
  const verdicts = interpretRelevance(rules, {
    r0: undefined, // missing key
    r1: { type: "choice" } as never, // wrong shape
    r2: { type: "noul", p: Number.NaN },
    r3: { type: "noul", p: 1.5 }, // out of range
    r4: { type: "noul", p: -0.1 },
  });
  expect(verdicts.every((v) => v.relevant)).toBe(true);
  expect(verdicts.map((v) => v.p)).toEqual([1, 1, 1, 1, 1]);
});

test("the threshold is a floor, not a midpoint: only confident irrelevance drops", () => {
  const rules = [rule("a"), rule("b"), rule("c")];
  const verdicts = interpretRelevance(
    rules,
    {
      r0: { type: "noul", p: 0.34 },
      r1: { type: "noul", p: 0.35 },
      r2: { type: "noul", p: 0.49 },
    },
    0.35,
  );
  expect(verdicts.map((v) => v.relevant)).toEqual([false, true, true]);
  // Raw `p` survives unrounded so a later sweep sees what the model actually said.
  expect(verdicts[0]!.p).toBe(0.34);
});

test("the shipped default drops only well below even odds", () => {
  expect(RELEVANCE_DROP_BELOW).toBeLessThan(0.5);
});

// ── orchestration: the enforcing path ───────────────────────────────────────────

test("enforce gates the rules judged irrelevant and nothing else", async () => {
  const rules = [rule("a"), rule("b"), rule("c")];
  const { judge, seen } = stubJudge((_k, i) => (i === 1 ? 0.02 : 0.9));
  const out = await judgeHouseRuleRelevance(rules, CTX, deps({ judge, mode: "enforce" }));

  expect([...out.judgedOutIds]).toEqual(["b"]);
  expect(out.verdicts.map((v) => v.learningId)).toEqual(["a", "b", "c"]);
  expect(out.costUsd).toBeGreaterThan(0);
  // One call for every rule, keyed by position so no rule id crosses the wire.
  expect(seen).toHaveLength(1);
  expect(Object.keys(seen[0]!.questions)).toEqual(["r0", "r1", "r2"]);
  expect(JSON.stringify(seen[0]!.questions)).not.toContain('"b"');
});

test("shadow records the same verdicts but gates nothing", async () => {
  const rules = [rule("a"), rule("b")];
  const { judge } = stubJudge(0.01);
  const out = await judgeHouseRuleRelevance(rules, CTX, deps({ judge, mode: "shadow" }));

  expect(out.verdicts.map((v) => v.relevant)).toEqual([false, false]);
  expect(out.judgedOutIds.size).toBe(0);
});

test("the cap bounds the payload, and overflow is kept rather than dropped", async () => {
  const rules = Array.from({ length: MAX_JUDGED_RULES + 5 }, (_, i) => rule(`r${i}`));
  const { judge, seen } = stubJudge(0); // everything judged irrelevant
  const out = await judgeHouseRuleRelevance(rules, CTX, deps({ judge, mode: "enforce" }));

  expect(Object.keys(seen[0]!.questions)).toHaveLength(MAX_JUDGED_RULES);
  expect(out.verdicts).toHaveLength(MAX_JUDGED_RULES);
  // The 5 unjudged rules are absent from judgedOutIds, so they inject on the pre-#2376 rules.
  expect(out.judgedOutIds.size).toBe(MAX_JUDGED_RULES);
  expect(out.judgedOutIds.has(`r${MAX_JUDGED_RULES}`)).toBe(false);
});

// ── orchestration: every fail-open branch ───────────────────────────────────────

test("off never calls the judge", async () => {
  const { judge, seen } = stubJudge(0);
  const out = await judgeHouseRuleRelevance([rule("a")], CTX, deps({ judge, mode: "off" }));
  expect(seen).toHaveLength(0);
  expect(out).toEqual({ verdicts: [], judgedOutIds: new Set(), costUsd: 0 });
});

test("an unarmed judge, and an empty candidate set, both fail open", async () => {
  expect(await judgeHouseRuleRelevance([rule("a")], CTX, deps({ judge: null }))).toMatchObject({
    verdicts: [],
    costUsd: 0,
  });
  const { judge, seen } = stubJudge(0);
  expect(await judgeHouseRuleRelevance([], CTX, deps({ judge }))).toMatchObject({ verdicts: [] });
  expect(seen).toHaveLength(0);
});

test("a refused ceiling fails open without calling", async () => {
  const { judge, seen } = stubJudge(0);
  const out = await judgeHouseRuleRelevance(
    [rule("a")],
    CTX,
    deps({ judge, spend: { allow: () => false, record: () => {} } }),
  );
  expect(seen).toHaveLength(0);
  expect(out.judgedOutIds.size).toBe(0);
});

test("a locked ledger degrades to today's injection rather than escaping to the caller", async () => {
  const { judge, seen } = stubJudge(0);
  const out = await judgeHouseRuleRelevance(
    [rule("a")],
    CTX,
    deps({
      judge,
      spend: {
        allow: () => {
          throw new Error("database is locked");
        },
        record: () => {},
      },
    }),
  );
  expect(seen).toHaveLength(0);
  expect(out.judgedOutIds.size).toBe(0);
});

test("a transport failure fails open", async () => {
  const judge: Judge = {
    ask: () => Promise.reject(new JudgeError("judge: 429 rate limited", 429)),
  };
  const out = await judgeHouseRuleRelevance([rule("a")], CTX, deps({ judge }));
  expect(out).toEqual({ verdicts: [], judgedOutIds: new Set(), costUsd: 0 });
});

test("the call is billed before the answers are inspected", async () => {
  // A ceiling that only counted answers it liked would not be a ceiling: an unusable answer was
  // still paid for.
  const recorded: number[] = [];
  const judge = {
    async ask() {
      return {
        answers: {}, // every answer missing ⇒ every rule reads as relevant
        model: "jev-test",
        usage: { inputTokens: 10, outputTokens: 0 },
        costUsd: 0.5,
      };
    },
  } as unknown as Judge;
  const out = await judgeHouseRuleRelevance(
    [rule("a")],
    CTX,
    deps({ judge, spend: { allow: () => true, record: (usd) => void recorded.push(usd) } }),
  );
  expect(recorded).toEqual([0.5]);
  expect(out.judgedOutIds.size).toBe(0);
});

test("a ledger write that throws does not lose the verdict it was billed for", async () => {
  const { judge } = stubJudge(0);
  const out = await judgeHouseRuleRelevance(
    [rule("a")],
    CTX,
    deps({
      judge,
      spend: {
        allow: () => true,
        record: () => {
          throw new Error("database is locked");
        },
      },
    }),
  );
  expect([...out.judgedOutIds]).toEqual(["a"]);
});

test("normalizeRelevanceMode is forgiving where isRelevanceMode is strict", () => {
  // The env seed must never arm a mode nobody asked for; the PUT handler rejects instead.
  expect(normalizeRelevanceMode(" enforce ")).toBe("enforce");
  expect(normalizeRelevanceMode("Enforce")).toBe("off");
  expect(normalizeRelevanceMode("")).toBe("off");
  expect(normalizeRelevanceMode(undefined)).toBe("off");
});
