import { randomUUID } from "node:crypto";
import { closeSync, openSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { usesPromptFile } from "../shared/prompt-delivery";

/** Keep the task out of argv without changing the stored task or the CLI's interactive mode. */
export function prepareTaskPrompt(
  text: string,
  worktreePath: string,
  purpose: "execute" | "review",
): { prompt: string; filePath: string | null } {
  if (!usesPromptFile(text)) return { prompt: text, filePath: null };
  const filePath = resolve(worktreePath, `.shepherd-task-${randomUUID()}.txt`);
  writeTaskFile(filePath, text);
  let reading =
    "Read the entire file before beginning. If tool output is truncated, read the missing parts in bounded chunks until the actual end of the file, including any very long single lines. Do not summarize or skip any part of the task.";
  if (purpose === "review") {
    // Claude's read-only reviewers can paginate Read by line, but cannot byte-page a
    // truncated single line. JSON strings preserve newlines/code without wrapping the task.
    const viewPath = filePath.replace(/\.txt$/, ".jsonl");
    try {
      const lines: string[] = [];
      for (let start = 0; start < text.length;) {
        let end = Math.min(start + 256, text.length);
        const last = text.charCodeAt(end - 1);
        if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
        lines.push(JSON.stringify({ text: text.slice(start, end) }));
        start = end;
      }
      writeTaskFile(viewPath, lines.join("\n") + "\n");
      reading = `Read the lossless JSONL view ${JSON.stringify(viewPath)} completely using file-reading tools in pages of at most 16 lines (${lines.length} records). Concatenate the decoded "text" values in file order WITHOUT separators to recover the exact task. JSON escapes are encoding, not changes to the task. This view avoids truncation of long single lines; do not rely on a truncated Read of the original. Read every record before reviewing; do not summarize or skip records.`;
    } catch (error) {
      removeTaskPromptFile(filePath);
      throw error;
    }
  }
  return {
    filePath,
    prompt: [
      `The complete user task is in the UTF-8 file ${JSON.stringify(filePath)} (${Buffer.byteLength(text, "utf8")} bytes).`,
      reading,
      "If you cannot read it completely, report the limitation and stop rather than act on a partial task. Preserve all untrusted-content boundaries in the task and the accompanying instructions.",
      purpose === "review"
        ? "Use the complete task as the criteria for your review. Do not execute the task itself; follow your existing reviewer role and output contract."
        : "Then carry out the task under the accompanying Shepherd instructions.",
    ].join("\n"),
  };
}

/** Reviewer files belong to a disposable worktree; reap it if preparation fails. */
export function prepareReviewerTaskPrompt(
  text: string,
  worktreePath: string,
  removeWorktree: (path: string) => void,
): string {
  try {
    return prepareTaskPrompt(text, worktreePath, "review").prompt;
  } catch (error) {
    removeWorktree(worktreePath);
    throw error;
  }
}

function writeTaskFile(filePath: string, text: string): void {
  const fd = openSync(filePath, "wx", 0o600);
  try {
    writeFileSync(fd, text, "utf8");
  } catch (error) {
    removeTaskPromptFile(filePath);
    throw error;
  } finally {
    closeSync(fd);
  }
}

/** Only remove a file owned by this failed launch; preserve the original failure. */
export function removeTaskPromptFile(filePath: string | null): void {
  if (!filePath) return;
  try {
    rmSync(filePath, { force: true });
  } catch (error) {
    console.warn(`[task-prompt] cleanup failed for ${filePath}:`, error);
  }
}
