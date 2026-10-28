import { expect, test } from "bun:test";
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexTranscriptLocator } from "../src/codex-activity";
import { CodexQuestionTracker } from "../src/codex-questions";
import { CodexQuestionAnswerService } from "../src/codex-question-answer";
import type { Session } from "../src/types";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/codex-questions/${name}`, import.meta.url), "utf8");

async function rig() {
  const dir = await mkdtemp(join(tmpdir(), "codex-answer-"));
  const path = join(dir, "rollout.jsonl");
  const rows = fixture("async-roundtrip.jsonl").trim().split("\n");
  await writeFile(path, rows.slice(0, 3).join("\n") + "\n");
  const session = {
    id: "s",
    agentProvider: "codex",
    providerSessionId: "thread",
    herdrAgentId: "terminal",
  } as Session;
  const tracker = new CodexQuestionTracker(
    new CodexTranscriptLocator({ find: () => path, now: () => 0 }),
  );
  let screen = "? 2 questions\n shift+← to answer";
  await tracker.refresh(session);
  tracker.observe(session, screen);
  const writes: string[] = [];
  const svc = new CodexQuestionAnswerService({
    tracker,
    session: () => session,
    withTerminal: async (_id, _thread, run) =>
      run({
        read: async () => screen,
        send: async (key) => {
          writes.push(key);
          if (key === "\x1b[1;2D") screen = fixture("color-screen.txt");
          if (key === "2") {
            await appendFile(path, rows[3] + "\n");
            screen = fixture("note-screen.txt");
          }
          if (key.startsWith("\x1b[200~"))
            screen = screen.replace("Type your answer", "QPROBE-TEXT");
          if (key === "\r") {
            await appendFile(path, rows[4] + "\n");
            screen = "› Ask Codex to do anything";
          }
          return true;
        },
      }),
    gapMs: 0,
    verifyMs: 30,
  });
  return {
    svc,
    writes,
    session,
    append: (record: unknown) => appendFile(path, JSON.stringify(record) + "\n"),
    changeScreen: (text: string) => {
      screen = text;
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test("Codex answer roundtrip verifies each async reply by original id", async () => {
  const r = await rig();
  try {
    const out = await r.svc.answer("s", "probe-async", [
      { blockId: "probe-async", questionId: "0", optionIndices: [1] },
      { blockId: "probe-async", questionId: "1", text: "QPROBE-TEXT" },
    ]);
    expect(out).toEqual({ ok: true, result: "verified" });
    expect(r.writes).toEqual(["\x1b[1;2D", "2", "\x1b[200~QPROBE-TEXT\x1b[201~", "\r"]);
  } finally {
    await r.cleanup();
  }
});

test("Codex answer never types into an unrelated or already dismissed pane", async () => {
  const r = await rig();
  try {
    r.changeScreen("› Ask Codex to do anything");
    const out = await r.svc.answer("s", "probe-async", [
      { blockId: "probe-async", questionId: "0", optionIndices: [0] },
      { blockId: "probe-async", questionId: "1", text: "hello" },
    ]);
    expect(out).toMatchObject({ ok: false, status: 409 });
    expect(r.writes).toEqual([]);
  } finally {
    await r.cleanup();
  }
});

test("Codex answer refuses an ambiguous live question rather than answering a namesake", async () => {
  const r = await rig();
  try {
    await r.append({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input_async",
        call_id: "duplicate",
        arguments: JSON.stringify({
          questions: [{ title: "QPROBE-COLOR", options: ["Red", "Blue"] }],
        }),
      },
    });
    r.changeScreen("? 3 questions\n shift+← to answer");
    expect(
      await r.svc.answer("s", "duplicate", [
        { blockId: "duplicate", questionId: "0", optionIndices: [1] },
      ]),
    ).toMatchObject({ ok: false, status: 409 });
    expect(r.writes).toEqual(["\x1b[1;2D"]);
  } finally {
    await r.cleanup();
  }
});

for (const result of ["verified", "mismatch", "unverified"] as const) {
  test(`Codex sync answer reports ${result} from native evidence without retrying`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-sync-answer-"));
    try {
      const path = join(dir, "rollout.jsonl");
      const rows = fixture("sync-roundtrip.jsonl").trim().split("\n");
      await writeFile(path, rows[0] + "\n");
      const session = {
        id: "s",
        agentProvider: "codex",
        providerSessionId: "thread",
        herdrAgentId: "terminal",
      } as Session;
      const tracker = new CodexQuestionTracker(
        new CodexTranscriptLocator({ find: () => path, now: () => 0 }),
      );
      const writes: string[] = [];
      let screen = fixture("sync-screen.txt");
      const svc = new CodexQuestionAnswerService({
        tracker,
        session: () => session,
        gapMs: 0,
        verifyMs: 10,
        withTerminal: async (_id, _thread, run) =>
          run({
            read: async () => screen,
            send: async (key) => {
              writes.push(key);
              screen = "› Ask Codex to do anything";
              if (result !== "unverified")
                await appendFile(
                  path,
                  (result === "verified" ? rows[1] : rows[1]!.replace("Blue", "Red")) + "\n",
                );
              return true;
            },
          }),
      });
      expect(
        await svc.answer("s", "probe-sync", [
          { blockId: "probe-sync", questionId: "0", optionIndices: [1] },
        ]),
      ).toEqual({ ok: true, result });
      expect(writes).toEqual(["2"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("Codex answer preserves an existing native free-text draft", async () => {
  const r = await rig();
  try {
    r.changeScreen(fixture("note-screen.txt").replace("Type your answer", "my unfinished draft"));
    expect(
      await r.svc.answer("s", "probe-async", [
        { blockId: "probe-async", questionId: "1", text: "replacement" },
      ]),
    ).toMatchObject({ ok: false, status: 409 });
    expect(r.writes).toEqual([]);
  } finally {
    await r.cleanup();
  }
});

test("Codex navigates to a selected request from another open queue page", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-queue-answer-"));
  const path = join(dir, "rollout.jsonl");
  try {
    const calls = ["First", "Second", "Third"].map((title, i) => ({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input_async",
        call_id: `call-${i}`,
        arguments: JSON.stringify({ questions: [{ title, options: ["Red", "Blue"] }] }),
      },
    }));
    await writeFile(path, calls.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const session = {
      id: "s",
      agentProvider: "codex",
      providerSessionId: "thread",
      herdrAgentId: "terminal",
    } as Session;
    const tracker = new CodexQuestionTracker(
      new CodexTranscriptLocator({ find: () => path, now: () => 0 }),
    );
    let index = 2;
    const writes: string[] = [];
    const svc = new CodexQuestionAnswerService({
      tracker,
      session: () => session,
      gapMs: 0,
      verifyMs: 10,
      withTerminal: async (_id, _thread, run) =>
        run({
          read: async () =>
            `• Queued follow-up inputs\n\n ${index + 1} of 3\n ${["First", "Second", "Third"][index]}\n\n › 1. Red\n 2. Blue\n 3. Other\n\n enter submit   ^] skip   shift+→ main prompt   shift+← next question`,
          send: async (key) => {
            writes.push(key);
            if (key === "\x1b[1;2C") index--;
            if (key === "2")
              await appendFile(
                path,
                JSON.stringify({
                  type: "response_item",
                  payload: {
                    type: "message",
                    role: "user",
                    content: [
                      {
                        type: "input_text",
                        text:
                          "<send_user_message_question_reply>\n" +
                          JSON.stringify([
                            {
                              answer: "Blue",
                              question: "Second",
                              questionItemId: JSON.stringify([
                                "request_user_input_async",
                                "call-1",
                                0,
                              ]),
                            },
                          ]) +
                          "\n</send_user_message_question_reply>",
                      },
                    ],
                  },
                }) + "\n",
              );
            return true;
          },
        }),
    });
    expect(
      await svc.answer("s", "call-1", [{ blockId: "call-1", questionId: "0", optionIndices: [1] }]),
    ).toEqual({ ok: true, result: "verified" });
    expect(writes).toEqual(["\x1b[1;2C", "2"]);
    await tracker.refresh(session);
    expect(tracker.answer(session, "call-0", 0)).toBeNull();
    expect(tracker.answer(session, "call-2", 0)).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const partial of [false, true]) {
  test(`Codex sync multi-question replies ${partial ? "preserve a manual partial answer" : "advance and verify all answers"}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-sync-multi-"));
    try {
      const path = join(dir, "rollout.jsonl");
      const rows = fixture("sync-multi-roundtrip.jsonl").trim().split("\n");
      await writeFile(path, rows[0] + "\n");
      const session = {
        id: "s",
        agentProvider: "codex",
        providerSessionId: "thread",
        herdrAgentId: "terminal",
      } as Session;
      const tracker = new CodexQuestionTracker(
        new CodexTranscriptLocator({ find: () => path, now: () => 0 }),
      );
      const writes: string[] = [];
      let index = 0;
      const screen = () =>
        `Question ${index + 1}/2 (${partial ? 1 : 2 - index} unanswered)\n${index ? "QPROBE-SHAPE" : "QPROBE-OTHER"}\n\n› 1. ${index ? "Round" : "Red"}\n 2. ${index ? "Square" : "Blue"}\n 3. None of the above\n\ntab to add notes | enter to submit answer | esc to interrupt`;
      const svc = new CodexQuestionAnswerService({
        tracker,
        session: () => session,
        gapMs: 0,
        verifyMs: 10,
        withTerminal: async (_id, _thread, run) =>
          run({
            read: async () => screen(),
            send: async (key) => {
              writes.push(key);
              if (++index === 2) {
                const result = JSON.parse(rows[1]!);
                result.payload.output = JSON.stringify({
                  answers: { color: { answers: ["Blue"] }, shape: { answers: ["Square"] } },
                });
                await appendFile(path, JSON.stringify(result) + "\n");
              }
              return true;
            },
          }),
      });
      const outcome = await svc.answer(
        "s",
        "probe-multi",
        [0, 1].map((i) => ({ blockId: "probe-multi", questionId: String(i), optionIndices: [1] })),
      );
      expect(outcome).toEqual(
        partial
          ? { ok: false, status: 409, error: "ask_not_open" }
          : { ok: true, result: "verified" },
      );
      expect(writes).toEqual(partial ? [] : ["2", "2"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
