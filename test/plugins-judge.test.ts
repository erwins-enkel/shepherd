// ctx.judge (#2541): armed gate, spend ceiling, fencing, error mapping.

import { test, expect } from "bun:test";
import type { Judge } from "../src/judge";
import { makePluginJudge, pluginJudgeState } from "../src/plugins/judge";
import { PluginJudgeError, type PluginJudgeChoiceOptions } from "../src/plugins/types";

const OPTS: PluginJudgeChoiceOptions = {
  instructions: "Which?",
  options: { a: "first", b: "second" },
  context: "facts",
  untrusted: [{ label: "log", content: "boom" }],
};

function fakeJudge(onAsk?: (state: unknown, q: unknown) => void, fail?: Error): Judge {
  return {
    ask: (async (state: unknown, q: unknown) => {
      onAsk?.(state, q);
      if (fail) throw fail;
      return {
        answers: {
          answer: {
            type: "choice",
            choice: "b",
            probabilities: { a: 0.2, b: 0.8 },
            vendorConfidence: 0.9,
          },
        },
        model: "m",
        usage: { inputTokens: 10, outputTokens: 0 },
        costUsd: 0.001,
      };
    }) as Judge["ask"],
  };
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "resolved";
  } catch (e) {
    return (e as PluginJudgeError).name === "PluginJudgeError"
      ? (e as PluginJudgeError).code
      : "other";
  }
}

test("unarmed or unwired → unavailable", async () => {
  expect(await code(makePluginJudge(undefined).choice(OPTS))).toBe("unavailable");
  const j = makePluginJudge({ judge: () => null, spend: () => null });
  expect(await code(j.choice(OPTS))).toBe("unavailable");
});

test("ceiling refusal → ceiling, judge not asked", async () => {
  let asked = 0;
  const j = makePluginJudge({
    judge: () => fakeJudge(() => asked++),
    spend: () => ({ allow: () => false, record: () => {} }),
  });
  expect(await code(j.choice(OPTS))).toBe("ceiling");
  expect(asked).toBe(0);
});

test("answers with choice + probabilities and books the cost", async () => {
  const booked: number[] = [];
  let seen: { state: unknown; q: unknown } | null = null;
  const j = makePluginJudge({
    judge: () => fakeJudge((state, q) => (seen = { state, q })),
    spend: () => ({ allow: () => true, record: (c) => void booked.push(c) }),
  });
  const a = await j.choice(OPTS);
  expect(a).toEqual({ choice: "b", probabilities: { a: 0.2, b: 0.8 } });
  expect(a).not.toHaveProperty("vendorConfidence");
  expect(booked).toEqual([0.001]);
  expect(seen!.q).toEqual({
    answer: { type: "choice", instructions: "Which?", criteria: { a: "first", b: "second" } },
  });
  expect(String(seen!.state)).toContain("⟦UNTRUSTED:log:");
});

test("transport failure → error", async () => {
  const j = makePluginJudge({
    judge: () => fakeJudge(undefined, new Error("judge: 429")),
    spend: () => null,
  });
  expect(await code(j.choice(OPTS))).toBe("error");
});

test("invalid options → invalid-args", async () => {
  const j = makePluginJudge({ judge: () => fakeJudge(), spend: () => null });
  expect(await code(j.choice({ ...OPTS, options: { a: "only" } }))).toBe("invalid-args");
  expect(await code(j.choice({ ...OPTS, instructions: " " }))).toBe("invalid-args");
  expect(
    await code(j.choice({ ...OPTS, untrusted: [{ label: "x", content: "y".repeat(40_000) }] })),
  ).toBe("invalid-args");
});

test("state fences untrusted and states the directive once", () => {
  const s = pluginJudgeState("ctx", [
    { label: "a", content: "1" },
    { label: "b", content: "2" },
  ]);
  expect(s.match(/EXTERNAL and UNTRUSTED/g)?.length).toBe(1);
  expect(s).toContain("⟦UNTRUSTED:a:");
  expect(s).toContain("⟦UNTRUSTED:b:");
  expect(pluginJudgeState("ctx", [])).toBe("ctx");
});
