import { describe, expect, test } from "bun:test";
import type { Judge } from "../src/judge";
import { promptHintViaJudge } from "../src/prompt-coach";
import {
  HINT_MIN_CHARS,
  PRESCRIBING_AT,
  interpretPrescribing,
  promptHintState,
} from "../src/prompt-coach-core";

const LONG = "Change parseConfig() in src/config.ts to cache the result in a module-level Map.";

describe("promptHintState", () => {
  test("skips prompts shorter than the minimum", () => {
    expect(promptHintState("x".repeat(HINT_MIN_CHARS - 1))).toBeNull();
    expect(promptHintState(`   ${"x".repeat(HINT_MIN_CHARS - 1)}   `)).toBeNull();
  });
  test("trims and clips", () => {
    const s = promptHintState(`  ${"y".repeat(5000)}  `)!;
    expect(s.startsWith("Task prompt:\ny")).toBe(true);
    expect(s.length).toBe("Task prompt:\n".length + 4000);
  });
});

describe("interpretPrescribing", () => {
  test("threshold is inclusive", () => {
    expect(interpretPrescribing({ type: "noul", p: PRESCRIBING_AT })).toBe("prescribing");
    expect(interpretPrescribing({ type: "noul", p: PRESCRIBING_AT - 0.01 })).toBeNull();
  });
  test("off-shape answers read as no hint", () => {
    expect(interpretPrescribing(undefined)).toBeNull();
    expect(interpretPrescribing({ type: "choice", p: 0.9 })).toBeNull();
    expect(interpretPrescribing({ type: "noul", p: Number.NaN })).toBeNull();
    expect(interpretPrescribing({ type: "noul", p: 1.5 })).toBeNull();
    expect(interpretPrescribing({ type: "noul", p: "0.9" })).toBeNull();
  });
});

describe("promptHintViaJudge", () => {
  const judgeAnswering = (p: number, asked: unknown[] = []): Judge => ({
    ask: (async (state: unknown, questions: unknown) => {
      asked.push({ state, questions });
      return {
        answers: { prescribing: { type: "noul", p } },
        model: "jev-test",
        usage: { inputTokens: 10, outputTokens: 0 },
        costUsd: 0.002,
      };
    }) as Judge["ask"],
  });
  const ledger = (allow = true) => {
    const booked: number[] = [];
    return { spend: { allow: () => allow, record: (usd: number) => booked.push(usd) }, booked };
  };
  const quiet = () => {};

  test("a prescribing answer hints and books the call", async () => {
    const asked: unknown[] = [];
    const { spend, booked } = ledger();
    expect(await promptHintViaJudge(LONG, judgeAnswering(0.9, asked), spend, quiet)).toBe(
      "prescribing",
    );
    expect(booked).toEqual([0.002]);
    expect(asked).toHaveLength(1);
  });

  test("a low answer gives no hint", async () => {
    expect(await promptHintViaJudge(LONG, judgeAnswering(0.2), null, quiet)).toBeNull();
  });

  test("a short prompt never asks", async () => {
    const asked: unknown[] = [];
    expect(await promptHintViaJudge("fix it", judgeAnswering(0.9, asked), null, quiet)).toBeNull();
    expect(asked).toHaveLength(0);
  });

  test("a refused ceiling never asks", async () => {
    const asked: unknown[] = [];
    const { spend } = ledger(false);
    expect(await promptHintViaJudge(LONG, judgeAnswering(0.9, asked), spend, quiet)).toBeNull();
    expect(asked).toHaveLength(0);
  });

  test("a judge failure is no hint, warned", async () => {
    const warned: string[] = [];
    const judge: Judge = {
      ask: (async () => {
        throw new Error("503");
      }) as Judge["ask"],
    };
    expect(await promptHintViaJudge(LONG, judge, null, (m) => warned.push(m))).toBeNull();
    expect(warned).toHaveLength(1);
  });
});
