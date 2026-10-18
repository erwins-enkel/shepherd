import { test, expect } from "bun:test";
import { AskAnswerService } from "../src/ask-answer-service";
import type { PendingAsk } from "../src/ask-user-question";

const ASK: PendingAsk = {
  toolUseId: "toolu_1",
  questions: [
    {
      question: "Color?",
      header: "Color",
      multiSelect: false,
      options: [
        { label: "Red", description: "" },
        { label: "Blue", description: "" },
      ],
    },
    {
      question: "Tops?",
      header: "Tops",
      multiSelect: true,
      options: [
        { label: "Cheese", description: "" },
        { label: "Ham", description: "" },
      ],
    },
  ],
};
const ANSWERS = [
  { blockId: "toolu_1", questionId: "0", optionIndices: [1] },
  { blockId: "toolu_1", questionId: "1", optionIndices: [0], text: "Kiwi" },
];

function rig(opts: { reply?: Record<string, string> | null; typed?: boolean } = {}) {
  let ask: PendingAsk | null = ASK;
  const typedCalls: { keys: string[]; valid: () => boolean }[] = [];
  const svc: AskAnswerService = new AskAnswerService({
    currentAsk: () => ask,
    typeKeys: async (_id, keys, _gap, valid) => {
      typedCalls.push({ keys, valid });
      if (opts.typed === false) return false;
      if (opts.reply !== undefined) {
        ask = null;
        svc.onPostToolUse("s", "toolu_other", { nope: "x" }); // a different tool: ignored
        if (opts.reply !== null) svc.onPostToolUse("s", "toolu_1", opts.reply);
      }
      return true;
    },
    verifyTimeoutMs: 20,
    gapMs: 0,
  });
  return { svc, typedCalls, closeAsk: () => (ask = null) };
}

test("verified: typed keys match the spike sequence and PostToolUse agrees", async () => {
  const r = rig({ reply: { "Color?": "Blue", "Tops?": "Cheese, Kiwi" } });
  expect(await r.svc.answer("s", "toolu_1", ANSWERS)).toEqual({ ok: true, result: "verified" });
  expect(r.typedCalls[0]!.keys).toEqual([
    "2",
    "1", "3", "\x1b[B", "\x1b[B", "Kiwi", "\x1b[B", "\r",
    "1",
  ]);
});

test("mismatch: PostToolUse disagrees → result mismatch, no retry", async () => {
  const r = rig({ reply: { "Color?": "Red", "Tops?": "Cheese, Kiwi" } });
  expect(await r.svc.answer("s", "toolu_1", ANSWERS)).toEqual({ ok: true, result: "mismatch" });
  expect(r.typedCalls).toHaveLength(1);
});

test("unverified: no PostToolUse within the timeout", async () => {
  const r = rig({ reply: null });
  expect(await r.svc.answer("s", "toolu_1", ANSWERS)).toEqual({ ok: true, result: "unverified" });
});

test("409 when the ask is not open, wrong id, or typing was cut short", async () => {
  const closed = rig();
  closed.closeAsk();
  expect(await closed.svc.answer("s", "toolu_1", ANSWERS)).toMatchObject({ status: 409, error: "ask_not_open" });
  expect(await rig().svc.answer("s", "toolu_x", ANSWERS)).toMatchObject({ status: 409 });
  expect(await rig({ typed: false }).svc.answer("s", "toolu_1", ANSWERS)).toMatchObject({
    status: 409,
    error: "ask_not_open",
  });
});

test("400 on invalid answers (resolved against the hooked questions)", async () => {
  expect(
    await rig().svc.answer("s", "toolu_1", [{ blockId: "toolu_1", questionId: "0", optionIndices: [5] }]),
  ).toMatchObject({ status: 400 });
});

test("409 ask_in_flight for a concurrent answer; stillValid tracks the open ask", async () => {
  const r = rig({ reply: null });
  const first = r.svc.answer("s", "toolu_1", ANSWERS);
  expect(await r.svc.answer("s", "toolu_1", ANSWERS)).toMatchObject({ status: 409, error: "ask_in_flight" });
  await first;
  expect(r.typedCalls[0]!.valid()).toBe(false); // the reply closed the ask
});
