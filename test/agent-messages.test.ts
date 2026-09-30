import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  looksLikeQuestion,
  parseClaudeMessages,
  parseCodexMessages,
  sessionMessages,
} from "../src/agent-messages";
import type { SessionStatus } from "../src/types";

const TS = "2026-09-29T10:00:00.000Z";
const jsonl = (...rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

function assistantText(text: string, id = "msg_1", extra: Record<string, unknown> = {}) {
  return {
    type: "assistant",
    timestamp: TS,
    ...extra,
    message: { id, role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] },
  };
}
function assistantToolUse(name: string, input: unknown, id = "tu_1") {
  return {
    type: "assistant",
    timestamp: TS,
    message: { id: "msg_t", role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  };
}
function userText(text: string, extra: Record<string, unknown> = {}) {
  return { type: "user", timestamp: TS, ...extra, message: { role: "user", content: text } };
}
function toolResult(id: string) {
  return {
    type: "user",
    timestamp: TS,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
  };
}
const noise = { type: "system", subtype: "turn_duration", timestamp: TS };
const attachment = { type: "attachment", timestamp: TS, attachment: { type: "hook_success" } };

describe("looksLikeQuestion", () => {
  test("a sentence-ending ? is a question", () => {
    expect(looksLikeQuestion("Alles fertig.\n\nSoll ich pushen und den PR aufmachen?")).toBe(true);
    expect(looksLikeQuestion("Shall I proceed? (yes/no)")).toBe(true);
    expect(looksLikeQuestion("**Soll ich mergen?**")).toBe(true);
  });
  test("no ? or only a URL query is not a question", () => {
    expect(looksLikeQuestion("Done. PR is open.")).toBe(false);
    expect(looksLikeQuestion("See https://x.test/a?b=1 for details.")).toBe(false);
  });
  test("a question followed by an option list within the last 3 paragraphs counts", () => {
    expect(looksLikeQuestion("Which variant?\n\n1. A\n2. B\n\nBoth are fine.")).toBe(true);
  });
  test("a question further back than 3 paragraphs does not", () => {
    expect(looksLikeQuestion("Why?\n\nOne.\n\nTwo.\n\nThree.")).toBe(false);
  });
});

describe("parseClaudeMessages", () => {
  test("turn ending on a question yields the full last message", () => {
    const text = jsonl(
      userText("Build it"),
      assistantText("Fertig umgesetzt.\n\nSoll ich pushen und den PR aufmachen?"),
      attachment,
      noise,
    );
    const r = parseClaudeMessages(text);
    expect(r.question).toBe("Fertig umgesetzt.\n\nSoll ich pushen und den PR aufmachen?");
    expect(r.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(r.messages[1]!.ts).toBe(Date.parse(TS));
  });
  test("a statement at turn end is no question", () => {
    expect(parseClaudeMessages(jsonl(assistantText("PR #66 is merged."))).question).toBeNull();
  });
  test("a user message after the question clears it", () => {
    const r = parseClaudeMessages(jsonl(assistantText("Push?"), userText("yes")));
    expect(r.question).toBeNull();
  });
  test("a tool call after the text clears it", () => {
    const r = parseClaudeMessages(
      jsonl(assistantText("Should I check?"), assistantToolUse("Bash", { command: "ls" })),
    );
    expect(r.question).toBeNull();
  });
  test("a pending AskUserQuestion is the question, with its options", () => {
    const r = parseClaudeMessages(
      jsonl(
        assistantText("Some context."),
        assistantToolUse("AskUserQuestion", {
          questions: [
            { question: "Which scope?", options: [{ label: "full" }, { label: "read" }] },
            { question: "Codex too?", options: [] },
          ],
        }),
      ),
    );
    expect(r.question).toBe("Which scope? (full / read)\nCodex too?");
  });
  test("an answered AskUserQuestion is not pending", () => {
    const r = parseClaudeMessages(
      jsonl(
        assistantToolUse("AskUserQuestion", { questions: [{ question: "Which?" }] }, "tu_q"),
        toolResult("tu_q"),
        assistantText("Thanks, proceeding."),
      ),
    );
    expect(r.question).toBeNull();
  });
  test("meta, sidechain, API-error and tool_result records are not messages", () => {
    const r = parseClaudeMessages(
      jsonl(
        userText("<system-reminder>x</system-reminder>", { isMeta: true }),
        assistantText("sub-agent talk?", "msg_s", { isSidechain: true }),
        toolResult("tu_x"),
        assistantText("Real answer."),
        assistantText("API Error: 500?", "msg_e", { isApiErrorMessage: true }),
      ),
    );
    expect(r.messages.map((m) => m.text)).toEqual(["Real answer."]);
    expect(r.question).toBeNull();
  });
  test("text blocks of one message id are merged", () => {
    const r = parseClaudeMessages(
      jsonl(assistantText("Part one.", "msg_a"), assistantText("Part two?", "msg_a")),
    );
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]!.text).toBe("Part one.\n\nPart two?");
    expect(r.question).toBe("Part one.\n\nPart two?");
  });
  test("user text blocks are messages; malformed and non-object lines are skipped", () => {
    const text =
      "{not json\nnull\n42\n" +
      jsonl({
        type: "user",
        timestamp: TS,
        message: { role: "user", content: [{ type: "text", text: "steer me" }] },
      });
    expect(parseClaudeMessages(text).messages).toEqual([
      { role: "user", text: "steer me", ts: Date.parse(TS) },
    ]);
  });
});

function codexEvent(type: string, payload: Record<string, unknown> = {}) {
  return { timestamp: TS, type: "event_msg", payload: { type, ...payload } };
}
function codexMessage(role: string, text: string) {
  const kind = role === "assistant" ? "output_text" : "input_text";
  return {
    timestamp: TS,
    type: "response_item",
    payload: { type: "message", role, content: [{ type: kind, text }] },
  };
}

describe("parseCodexMessages", () => {
  test("task_complete after an assistant question yields it", () => {
    const r = parseCodexMessages(
      jsonl(
        codexEvent("task_started"),
        codexMessage("user", "<environment_context>…</environment_context>"),
        codexMessage("user", "Build it"),
        codexEvent("user_message", { message: "Build it" }),
        codexMessage("assistant", ""),
        codexMessage("assistant", "Done. Shall I open the PR?"),
        codexEvent("task_complete", { last_agent_message: "Done. Shall I open the PR?" }),
      ),
    );
    expect(r.question).toBe("Done. Shall I open the PR?");
    expect(r.messages).toEqual([
      { role: "user", text: "Build it", ts: Date.parse(TS) },
      { role: "assistant", text: "Done. Shall I open the PR?", ts: Date.parse(TS) },
    ]);
  });
  test("an aborted turn is no question", () => {
    const r = parseCodexMessages(
      jsonl(codexMessage("assistant", "Continue?"), codexEvent("turn_aborted")),
    );
    expect(r.question).toBeNull();
  });
  test("a turn still running is no question", () => {
    const r = parseCodexMessages(
      jsonl(
        codexMessage("assistant", "Continue?"),
        codexEvent("task_complete"),
        codexEvent("task_started"),
      ),
    );
    expect(r.question).toBeNull();
  });
  test("a user message after the question clears it", () => {
    const r = parseCodexMessages(
      jsonl(
        codexMessage("assistant", "Continue?"),
        codexEvent("task_complete"),
        codexEvent("user_message", { message: "yes" }),
      ),
    );
    expect(r.question).toBeNull();
  });
});

describe("sessionMessages", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-messages-"));
  const path = join(dir, "t.jsonl");
  writeFileSync(
    path,
    jsonl(
      userText("one"),
      assistantText("two", "m2"),
      userText("three"),
      assistantText("four", "m4"),
      assistantText("Push now?", "m5"),
    ),
  );
  const at = (status: SessionStatus) => ({ status, agentProvider: "claude" as const });

  test("at rest with a question → awaitingInput, last N assistant messages", async () => {
    const r = await sessionMessages(at("done"), path, { limit: 2, includeUser: false });
    expect(r.awaitingInput).toBe(true);
    expect(r.pendingQuestion).toBe("Push now?");
    expect(r.messages.map((m) => m.text)).toEqual(["four", "Push now?"]);
    expect(r.unavailable).toBeNull();
  });
  test("includeUser keeps user messages", async () => {
    const r = await sessionMessages(at("idle"), path, { limit: 3, includeUser: true });
    expect(r.messages.map((m) => m.text)).toEqual(["three", "four", "Push now?"]);
  });
  test("limit 0 returns only the flags", async () => {
    const r = await sessionMessages(at("blocked"), path, { limit: 0, includeUser: true });
    expect(r.messages).toEqual([]);
    expect(r.awaitingInput).toBe(true);
  });
  test("a running or archived session is not awaiting input", async () => {
    for (const status of ["running", "archived"] as const) {
      const r = await sessionMessages(at(status), path, { limit: 5, includeUser: false });
      expect(r.awaitingInput).toBe(false);
      expect(r.pendingQuestion).toBeNull();
    }
  });
  test("codex sessions use the rollout parser", async () => {
    const p = join(dir, "rollout.jsonl");
    writeFileSync(p, jsonl(codexMessage("assistant", "Ok?"), codexEvent("task_complete")));
    const r = await sessionMessages({ status: "done", agentProvider: "codex" }, p, {
      limit: 5,
      includeUser: false,
    });
    expect(r.pendingQuestion).toBe("Ok?");
  });
  test("no path → no-transcript; missing file → file-missing", async () => {
    const none = await sessionMessages(at("done"), null, { limit: 5, includeUser: false });
    expect(none).toEqual({
      messages: [],
      awaitingInput: false,
      pendingQuestion: null,
      unavailable: "no-transcript",
    });
    const gone = await sessionMessages(at("done"), join(dir, "gone.jsonl"), {
      limit: 5,
      includeUser: false,
    });
    expect(gone.unavailable).toBe("file-missing");
  });
  test("cleanup", () => rmSync(dir, { recursive: true, force: true }));
});
