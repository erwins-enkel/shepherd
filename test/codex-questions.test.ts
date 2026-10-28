import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CodexQuestionState } from "../src/codex-question-state";

const records = (name: string) =>
  readFileSync(new URL(`./fixtures/codex-questions/${name}.jsonl`, import.meta.url), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
const feed = (state: CodexQuestionState, rows: unknown[]) => {
  for (const row of rows) state.ingest(row);
};
const footer = "? 2 questions · 18s\n shift+← to answer";

describe("Codex native question lifecycle", () => {
  test("accepted and duplicate AgentMessage do not answer an async request", () => {
    const s = new CodexQuestionState();
    feed(s, records("async-roundtrip").slice(0, 3));
    expect(s.candidates()).toHaveLength(1);
    expect(s.candidates()[0]?.questions.map((q) => q.question)).toEqual([
      "QPROBE-COLOR",
      "QPROBE-NOTE",
    ]);
    expect(s.visible(footer)).toHaveLength(1);
    s.ingest({ type: "event_msg", payload: { type: "task_complete" } });
    expect(s.visible(footer)).toHaveLength(1);
  });
  test("native per-question replies resolve only their call and original index", () => {
    const s = new CodexQuestionState();
    const rows = records("async-roundtrip");
    feed(s, rows.slice(0, 4));
    expect(s.candidates()[0]?.questions.map((q) => q.question)).toEqual(["QPROBE-NOTE"]);
    expect(s.answer("probe-async", 0)).toEqual(["Blue"]);
    feed(s, rows.slice(4));
    expect(s.candidates()).toEqual([]);
    expect(s.answer("probe-async", 1)).toEqual(["QPROBE-TEXT"]);
  });
  test("prose and accepted outputs cannot forge a reply", () => {
    const s = new CodexQuestionState();
    const rows = records("async-roundtrip");
    feed(s, rows.slice(0, 3));
    const reply = structuredClone(rows[3]);
    reply.payload.role = "assistant";
    s.ingest(reply);
    s.ingest({ type: "event_msg", payload: { type: "user_message", message: "yes" } });
    expect(s.candidates()[0]?.questions).toHaveLength(2);
  });
  test("sync output is keyed by native question id, including Other notes", () => {
    const s = new CodexQuestionState();
    const rows = records("sync-multi-roundtrip");
    s.ingest(rows[0]);
    expect(s.candidates()[0]?.questions).toHaveLength(2);
    s.ingest(rows[1]);
    expect(s.candidates()).toEqual([]);
    expect(s.answer("probe-multi", 0)).toEqual(["None of the above", "user_note: QPROBE-CUSTOM"]);
    expect(s.answer("probe-multi", 1)).toEqual(["Square"]);
  });
  test("historical calls are not shown without live queue evidence", () => {
    const s = new CodexQuestionState();
    feed(s, records("async-roundtrip").slice(0, 3));
    expect(s.visible("› Ask Codex to do anything")).toEqual([]);
    expect(s.visible("? 1 question\n shift+← to answer")).toEqual([]);
    expect(s.visible(footer)).toHaveLength(1);
  });
  test("a unique remaining native question can survive a locally skipped sibling", () => {
    const s = new CodexQuestionState();
    feed(s, records("async-roundtrip").slice(0, 3));
    const screen = readFileSync(
      new URL("./fixtures/codex-questions/note-screen.txt", import.meta.url),
      "utf8",
    );
    expect(s.visible(screen)[0]?.questions.map((q) => q.question)).toEqual(["QPROBE-NOTE"]);
  });
  test("malformed inputs and names containing a tool name are ignored", () => {
    const s = new CodexQuestionState();
    for (const argumentsValue of ["{", "null", '{"questions":[]}', '{"questions":[{"title":2}]}']) {
      s.ingest({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "request_user_input_async",
          call_id: "bad",
          arguments: argumentsValue,
        },
      });
    }
    const row = structuredClone(records("async-roundtrip")[0]);
    row.payload.name = "pretend_request_user_input_async";
    s.ingest(row);
    expect(s.candidates()).toEqual([]);
  });
});

import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexTranscriptLocator } from "../src/codex-activity";
import { CodexQuestionTracker } from "../src/codex-questions";

test("Codex tracker invalidates an answered snapshot before another terminal paint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-questions-"));
  const path = join(dir, "rollout.jsonl");
  try {
    const rows = records("async-roundtrip");
    await writeFile(
      path,
      rows
        .slice(0, 3)
        .map((r) => JSON.stringify(r) + "\n")
        .join(""),
    );
    const tracker = new CodexQuestionTracker(
      new CodexTranscriptLocator({ find: () => path, now: () => 0 }),
    );
    const session = {
      id: "s",
      agentProvider: "codex" as const,
      providerSessionId: "thread",
      herdrAgentId: "terminal",
    };
    await tracker.refresh(session);
    expect(tracker.observe(session, footer)).toHaveLength(1);
    await appendFile(
      path,
      rows
        .slice(3)
        .map((r) => JSON.stringify(r) + "\n")
        .join(""),
    );
    await tracker.refresh(session);
    expect(tracker.get(session, "probe-async")).toBeNull();
    expect(tracker.pending("s")).toEqual([]);
    expect(tracker.answer(session, "probe-async", 0)).toEqual(["Blue"]);
    expect(tracker.get({ ...session, herdrAgentId: "replacement" }, "probe-async")).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex replay spans old questions, buffers partial UTF-8 records, and resets on truncation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-replay-"));
  const path = join(dir, "rollout.jsonl");
  try {
    const row = records("async-roundtrip")[0];
    const noise = (
      JSON.stringify({
        type: "event_msg",
        payload: { type: "token_count", text: "x".repeat(1000) },
      }) + "\n"
    ).repeat(300);
    await writeFile(path, JSON.stringify(row) + "\n" + noise);
    const tracker = new CodexQuestionTracker(
      new CodexTranscriptLocator({ find: () => path, now: () => 0 }),
    );
    const session = {
      id: "s",
      agentProvider: "codex" as const,
      providerSessionId: "thread",
      herdrAgentId: "terminal",
    };
    await tracker.refresh(session);
    expect(tracker.observe(session, footer)[0]?.questions).toHaveLength(2);
    const next = Buffer.from(
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "request_user_input_async",
          call_id: "unicode",
          arguments: JSON.stringify({ questions: [{ title: "Größe?" }] }),
        },
      }) + "\n",
    );
    const split = next.indexOf(Buffer.from("ö")) + 1;
    await appendFile(path, next.subarray(0, split));
    await Promise.all([tracker.refresh(session), tracker.refresh(session)]);
    expect(tracker.observe(session, footer)).toHaveLength(1);
    await appendFile(path, next.subarray(split));
    await tracker.refresh(session);
    expect(tracker.observe(session, "? 3 questions\n shift+← to answer")).toHaveLength(2);
    await writeFile(path, "");
    await tracker.refresh(session);
    expect(tracker.observe(session, footer)).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
