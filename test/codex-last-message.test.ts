import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readRoleResultText,
  scrubStaleVerdictArtifacts,
  codexLastMessageFile,
  CODEX_LAST_MESSAGE_FILE,
} from "../src/codex-last-message";

// readRoleResultText recovers a Codex role's verdict when the agent ANSWERS in chat instead of
// writing the result file: the CLI's `-o` last-message file captures that final message. The helper
// hardcodes NO fallback name — it reads only the caller-provided `lastMessageFile`, so a fixed-name
// file a PR commits into an untrusted reviewer checkout is never read (reviewer-kind callers pass a
// per-spawn unguessable name; tmpdir roles pass the fixed name, safe in their disposable cwd).

const RESULT = ".shepherd-recap.json";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "codex-lastmsg-"));
}

test("no lastMessageFile → NO fallback (helper hardcodes no fallback name)", () => {
  const dir = freshDir();
  // A file with the fixed name exists, but the caller didn't ask for a fallback → it is ignored.
  writeFileSync(join(dir, CODEX_LAST_MESSAGE_FILE), '{"from":"chat-answer"}');
  expect(readRoleResultText(dir, RESULT)).toBeNull();
});

test("result file present → returned verbatim (fallback ignored even when requested)", () => {
  const dir = freshDir();
  writeFileSync(join(dir, RESULT), '{"from":"result-file"}');
  // In the success case BOTH files exist (agent writes the result, CLI writes the ack at exit);
  // the result file must win.
  writeFileSync(join(dir, CODEX_LAST_MESSAGE_FILE), "Created .shepherd-recap.json.");
  expect(readRoleResultText(dir, RESULT, CODEX_LAST_MESSAGE_FILE)).toBe('{"from":"result-file"}');
});

test("result absent + named last-message present → last-message returned (the chat-only recovery)", () => {
  const dir = freshDir();
  const name = codexLastMessageFile("abc-123"); // a per-spawn reviewer name
  writeFileSync(join(dir, name), '{"from":"chat-answer"}');
  expect(readRoleResultText(dir, RESULT, name)).toBe('{"from":"chat-answer"}');
});

test("named last-message absent → null even though a DIFFERENT-named file exists (pre-seed defense)", () => {
  const dir = freshDir();
  // A PR pre-committed the fixed name; the reviewer reads its per-spawn name → the pre-seed is ignored.
  writeFileSync(join(dir, CODEX_LAST_MESSAGE_FILE), '{"decision":"comment","findings":[]}');
  expect(readRoleResultText(dir, RESULT, codexLastMessageFile("unguessable-uuid"))).toBeNull();
});

test("both files absent → null (nothing to read yet)", () => {
  const dir = freshDir();
  expect(readRoleResultText(dir, RESULT, CODEX_LAST_MESSAGE_FILE)).toBeNull();
});

test("last-message may carry prose — helper returns it raw; the caller's parser fails it closed", () => {
  const dir = freshDir();
  writeFileSync(join(dir, CODEX_LAST_MESSAGE_FILE), "Sorry, I could not complete the recap.");
  // The helper does not validate — it hands the text back; a shape validator rejects non-JSON prose,
  // so a bad fallback fails closed exactly as an absent verdict would (proven per-role elsewhere).
  expect(readRoleResultText(dir, RESULT, CODEX_LAST_MESSAGE_FILE)).toBe(
    "Sorry, I could not complete the recap.",
  );
});

// ── codexLastMessageFile: per-spawn unguessable name ─────────────────────────────

test("codexLastMessageFile is keyed on the spawn id and differs per spawn", () => {
  expect(codexLastMessageFile("s1")).toBe(".shepherd-last-message-s1.txt");
  expect(codexLastMessageFile("s1")).not.toBe(codexLastMessageFile("s2"));
  // It never collides with the fixed tmpdir name a PR could guess and pre-commit.
  expect(codexLastMessageFile("s1")).not.toBe(CODEX_LAST_MESSAGE_FILE);
});

// ── scrubStaleVerdictArtifacts (result-file pre-seed defense for PR-critic worktrees) ────
// A PR critic runs in a checkout of the untrusted PR head. The RESULT file has a fixed name (the
// prompt dictates it), so it must be scrubbed pre-launch. (The `-o` fallback needs no scrub — it uses
// a per-spawn unguessable name a PR can't pre-commit.)

const REVIEW_RESULT = ".shepherd-review.json";

test("pre-seeded result file → scrub removes it → the read starts clean", () => {
  const dir = freshDir();
  writeFileSync(join(dir, REVIEW_RESULT), '{"decision":"comment","findings":[]}');
  // Pre-condition: absent the scrub, the pre-seeded result file WOULD short-circuit the critic.
  expect(readRoleResultText(dir, REVIEW_RESULT)).toBe('{"decision":"comment","findings":[]}');

  scrubStaleVerdictArtifacts(dir, REVIEW_RESULT);

  expect(existsSync(join(dir, REVIEW_RESULT))).toBe(false);
  expect(readRoleResultText(dir, REVIEW_RESULT)).toBeNull();
});

test("scrub is best-effort — no throw when the artifact is absent", () => {
  const dir = freshDir();
  expect(() => scrubStaleVerdictArtifacts(dir, REVIEW_RESULT)).not.toThrow();
});

test("scrub touches ONLY the result file, never unrelated files", () => {
  const dir = freshDir();
  writeFileSync(join(dir, REVIEW_RESULT), "{}");
  writeFileSync(join(dir, "src.ts"), "export const x = 1;"); // real reviewed content
  writeFileSync(join(dir, ".shepherd-plan.md"), "# plan"); // another shepherd artifact, not a verdict

  scrubStaleVerdictArtifacts(dir, REVIEW_RESULT);

  expect(existsSync(join(dir, REVIEW_RESULT))).toBe(false);
  expect(existsSync(join(dir, "src.ts"))).toBe(true);
  expect(existsSync(join(dir, ".shepherd-plan.md"))).toBe(true);
});
