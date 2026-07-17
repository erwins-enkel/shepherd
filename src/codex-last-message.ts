/**
 * The Codex `-o` last-message fallback — one home for the file name and the shared read helper.
 *
 * A headless `codex exec` role is told to WRITE its result as JSON to a role-specific file
 * (`.shepherd-recap.json`, `.shepherd-review.json`, …). Codex occasionally treats "write the
 * result" as "respond with the result": it produces a complete, correct verdict as its final chat
 * message and never calls a write tool (observed live — TASK-737's recap, and `6b24a73a`). The role
 * service only reads the result file, so a correct verdict was silently discarded and the row failed
 * with `no-result`.
 *
 * `codex exec -o <FILE>` makes the CLI ITSELF write the agent's final message to a file, with no
 * dependence on the model choosing to call a tool — so it captures exactly that chat-only case. The
 * flag is emitted for every Codex role (see codex-role-argv.ts) with a RELATIVE path, which Codex
 * resolves against the spawn's cwd (verified: the file lands in the disposable tmpdir).
 *
 * The result file stays the PRIMARY contract; the last-message file is a FALLBACK read only when the
 * result file is absent. In the normal success case BOTH files exist — the agent writes the result
 * file mid-run and the CLI writes the last-message file (usually a "Created …" acknowledgement) at
 * exit — so preferring the result file is essential, and there is no race: `-o` is written at exit,
 * so a present last-message file means the agent has finished.
 *
 * The helper returns raw TEXT; each caller keeps its own parse + shape validation. A prose
 * last-message that isn't a valid verdict fails that validation and fails closed exactly as before —
 * the fallback can never invent a verdict.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/** The file `codex exec -o <FILE>` writes the agent's final message to. Relative → resolved against
 *  the spawn's cwd. Shared across every Codex role's result-read path + emitted by codexRoleArgv. */
export const CODEX_LAST_MESSAGE_FILE = ".shepherd-last-message.txt";

/**
 * Read a role's result text: the role's own `resultFile` first, falling back to the Codex `-o`
 * last-message file when the result file is absent. Returns null when neither exists (or is
 * unreadable mid-write — treat as not-yet-written and retry next tick). Callers apply their existing
 * parser/validator to the returned text, so behavior is unchanged whenever the result file is present.
 */
export function readRoleResultText(cwd: string, resultFile: string): string | null {
  const primary = join(cwd, resultFile);
  if (existsSync(primary)) {
    try {
      return readFileSync(primary, "utf8");
    } catch {
      return null; // unreadable mid-write — retry next tick
    }
  }
  const fallback = join(cwd, CODEX_LAST_MESSAGE_FILE);
  if (existsSync(fallback)) {
    try {
      return readFileSync(fallback, "utf8");
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Delete any pre-existing verdict artifacts from a reviewer/critic worktree BEFORE launching the
 * role. REQUIRED for roles that spawn in a worktree checked out from UNTRUSTED PR contents (the PR
 * critics `review.ts` + `standalone-critic.ts` detach at the PR head): a malicious PR can commit a
 * strict-JSON `<resultFile>` or `.shepherd-last-message.txt` (the `-o` fallback) into its branch, and
 * because the read path finalizes a strict parse on the first tick AND is provider-agnostic, that
 * pre-seed would short-circuit the real reviewer — a Claude reviewer included, which never
 * legitimately writes an `-o` file at all. A detached reviewer worktree exists solely to inspect
 * committed code; the reviewer writes its verdict FRESH during the run, so any such artifact present
 * at launch is a pre-seed, never a real verdict — removing it is safe and closes the hole. Both the
 * role's own `resultFile` and the shared `-o` fallback file are scrubbed. Best-effort per file (a
 * missing file / unlink race must not block the spawn). Harmless for base-checkout reviewers (the
 * plan reviewer detaches at the trusted base) — a defense-in-depth no-op there.
 */
export function scrubStaleVerdictArtifacts(worktreePath: string, resultFile: string): void {
  for (const name of [resultFile, CODEX_LAST_MESSAGE_FILE]) {
    try {
      rmSync(join(worktreePath, name), { force: true });
    } catch {
      /* best-effort — a pre-seed we can't remove still fails closed via the read path's validators */
    }
  }
}
