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

function rig(
  opts: { reply?: Record<string, string> | null; sent?: number; typeThrows?: boolean } = {},
) {
  let ask: PendingAsk | null = ASK;
  const typedCalls: { keys: string[]; valid: () => boolean }[] = [];
  const holds: string[] = []; // "hold:<id>" / "release:<id>" in order
  const svc: AskAnswerService = new AskAnswerService({
    currentAsk: () => ask,
    askStillOpen: (_id, toolUseId) => ask?.toolUseId === toolUseId,
    holdAsk: (_id, toolUseId) => {
      holds.push(`hold:${toolUseId}`);
      return () => holds.push(`release:${toolUseId}`);
    },
    typeKeys: async (_id, keys, _gap, valid) => {
      typedCalls.push({ keys, valid });
      if (opts.typeThrows) throw new Error("terminal session");
      if (opts.sent !== undefined) return opts.sent;
      if (opts.reply !== undefined) {
        ask = null;
        svc.onPostToolUse("s", "toolu_other", { nope: "x" }); // a different tool: ignored
        if (opts.reply !== null) svc.onPostToolUse("s", "toolu_1", opts.reply);
      }
      return keys.length;
    },
    verifyTimeoutMs: 20,
    gapMs: 0,
  });
  return { svc, typedCalls, holds, closeAsk: () => (ask = null) };
}

/** Capture console.info/warn lines for the duration of `fn`. */
async function logged(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const info = console.info;
  const warn = console.warn;
  console.info = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  console.warn = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.info = info;
    console.warn = warn;
  }
  return lines;
}

test("verified: typed keys match the spike sequence and PostToolUse agrees", async () => {
  const r = rig({ reply: { "Color?": "Blue", "Tops?": "Cheese, Kiwi" } });
  expect(await r.svc.answer("s", "toolu_1", ANSWERS)).toEqual({ ok: true, result: "verified" });
  expect(r.typedCalls[0]!.keys).toEqual([
    "\x1b[B",
    "\r",
    "1",
    "3",
    "\x1b[B",
    "\x1b[B",
    "Kiwi",
    "\x1b[B",
    "\r",
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
  expect(await closed.svc.answer("s", "toolu_1", ANSWERS)).toMatchObject({
    status: 409,
    error: "ask_not_open",
  });
  expect(await rig().svc.answer("s", "toolu_x", ANSWERS)).toMatchObject({ status: 409 });
  expect(await rig({ sent: 0 }).svc.answer("s", "toolu_1", ANSWERS)).toMatchObject({
    status: 409,
    error: "ask_not_open",
  });
});

test("#4219: typing cut short after some keys → 409 ask_interrupted (outcome unknown)", async () => {
  expect(await rig({ sent: 3 }).svc.answer("s", "toolu_1", ANSWERS)).toEqual({
    ok: false,
    status: 409,
    error: "ask_interrupted",
  });
});

test("#4219: the ask is held across typing only, and released even when typing throws", async () => {
  const r = rig({ reply: null });
  await r.svc.answer("s", "toolu_1", ANSWERS);
  expect(r.holds).toEqual(["hold:toolu_1", "release:toolu_1"]);
  const t = rig({ typeThrows: true });
  await expect(t.svc.answer("s", "toolu_1", ANSWERS)).rejects.toThrow("terminal session");
  expect(t.holds).toEqual(["hold:toolu_1", "release:toolu_1"]);
  // A refused precheck never holds.
  const closed = rig();
  closed.closeAsk();
  await closed.svc.answer("s", "toolu_1", ANSWERS);
  expect(closed.holds).toEqual([]);
});

test("#4219: one redacted log line per request carries the ref, never answer text", async () => {
  const ok = await logged(() =>
    rig({ reply: { "Color?": "Blue", "Tops?": "Cheese, Kiwi" } }).svc.answer(
      "s",
      "toolu_1",
      ANSWERS,
      "ab12cd34",
    ),
  );
  expect(ok).toEqual([
    expect.stringMatching(
      /^\[ask\] answer req=ab12cd34 session=s tool_use=toolu_1 provider=claude outcome=verified keys=10\/10 ms=\d+$/,
    ),
  ]);
  const cut = await logged(() => rig({ sent: 3 }).svc.answer("s", "toolu_1", ANSWERS, "r2"));
  expect(cut).toEqual([expect.stringContaining("req=r2 ")]);
  expect(cut[0]).toContain("outcome=ask_interrupted keys=3/10");
  const evil = await logged(() => rig().svc.answer("s", "x\ny", ANSWERS));
  expect(evil[0]).toContain("req=- ");
  expect(evil[0]).toContain("tool_use=x?y provider");
  for (const line of [...ok, ...cut, ...evil]) expect(line).not.toMatch(/Blue|Kiwi|Cheese|Color/);
});

test("400 on invalid answers (resolved against the hooked questions)", async () => {
  expect(
    await rig().svc.answer("s", "toolu_1", [
      { blockId: "toolu_1", questionId: "0", optionIndices: [5] },
    ]),
  ).toMatchObject({ status: 400 });
});

test("409 ask_in_flight for a concurrent answer; stillValid tracks the open ask", async () => {
  const r = rig({ reply: null });
  const first = r.svc.answer("s", "toolu_1", ANSWERS);
  expect(await r.svc.answer("s", "toolu_1", ANSWERS)).toMatchObject({
    status: 409,
    error: "ask_in_flight",
  });
  await first;
  expect(r.typedCalls[0]!.valid()).toBe(false); // the reply closed the ask
});

test("Codex delegation shares the session in-flight guard", async () => {
  let finish!: (value: { ok: true; result: "verified" }) => void;
  let calls = 0;
  const svc = new AskAnswerService({
    currentAsk: () => null,
    askStillOpen: () => false,
    typeKeys: async () => {
      throw new Error("Claude path reached");
    },
    codex: {
      isSession: () => true,
      answer: async () => {
        calls++;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    },
  });
  const first = svc.answer("codex", "request", ANSWERS);
  expect(await svc.answer("codex", "request", ANSWERS)).toEqual({
    ok: false,
    status: 409,
    error: "ask_in_flight",
  });
  expect(calls).toBe(1);
  finish({ ok: true, result: "verified" });
  expect(await first).toEqual({ ok: true, result: "verified" });
});
