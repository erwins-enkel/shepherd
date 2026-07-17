import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRoleResultText, CODEX_LAST_MESSAGE_FILE } from "../src/codex-last-message";

// readRoleResultText is the shared seam that recovers a Codex role's verdict when the agent ANSWERS
// in chat instead of writing the result file: the CLI's `-o` last-message file captures that final
// message, read only when the role's own result file is absent. These pin the four contract cases.

const RESULT = ".shepherd-recap.json";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "codex-lastmsg-"));
}

test("result file present → returned verbatim (last-message ignored)", () => {
  const dir = freshDir();
  writeFileSync(join(dir, RESULT), '{"from":"result-file"}');
  // In the success case BOTH files exist (agent writes the result, CLI writes the ack at exit);
  // the result file must win.
  writeFileSync(join(dir, CODEX_LAST_MESSAGE_FILE), "Created .shepherd-recap.json.");

  expect(readRoleResultText(dir, RESULT)).toBe('{"from":"result-file"}');
});

test("result file absent + last-message present → last-message returned (the chat-only recovery)", () => {
  const dir = freshDir();
  // Codex answered the verdict in chat and never wrote the result file; the -o file holds it.
  writeFileSync(join(dir, CODEX_LAST_MESSAGE_FILE), '{"from":"chat-answer"}');

  expect(readRoleResultText(dir, RESULT)).toBe('{"from":"chat-answer"}');
});

test("both files absent → null (nothing to read yet)", () => {
  const dir = freshDir();
  expect(readRoleResultText(dir, RESULT)).toBeNull();
});

test("last-message may carry prose — helper returns it raw; the caller's parser fails it closed", () => {
  const dir = freshDir();
  writeFileSync(join(dir, CODEX_LAST_MESSAGE_FILE), "Sorry, I could not complete the recap.");
  // The helper does not validate — it hands the text back; a shape validator rejects non-JSON prose,
  // so a bad fallback fails closed exactly as an absent verdict would (proven per-role elsewhere).
  expect(readRoleResultText(dir, RESULT)).toBe("Sorry, I could not complete the recap.");
});
