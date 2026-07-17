/**
 * The Codex `-o` last-message fallback — the filename helpers and the shared read helper.
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
 * resolves against the spawn's cwd.
 *
 * ── UNTRUSTED-CHECKOUT SAFETY ────────────────────────────────────────────────────────────────────
 * The PR critics (review.ts, standalone-critic.ts) run in a worktree checked out from the UNTRUSTED
 * PR head. If the `-o` fallback had a fixed, guessable name, a malicious PR could commit a strict-JSON
 * `.shepherd-last-message.txt` into its branch; the read finalizes a strict parse on the first tick
 * and is provider-agnostic, so that pre-seed would short-circuit the real reviewer — a Claude reviewer
 * included, which never writes an `-o` file at all. So this helper NEVER reads a hardcoded name: the
 * caller passes the exact fallback filename, and reviewer-kind spawns use a PER-SPAWN UNGUESSABLE name
 * keyed on the spawn's session id ({@link codexLastMessageFile}) — a name a PR author cannot know at
 * authoring time, so a committed copy can never match the name the real run writes and reads. The
 * disposable-tmpdir roles (recap, autopilot, rundown, distiller, optimizer, merge-suggest) run in a
 * fresh empty dir nothing else can write, so they use the fixed {@link CODEX_LAST_MESSAGE_FILE} — safe
 * there because there is no untrusted checkout to pre-seed.
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

/** The FIXED last-message filename, used ONLY by the disposable-tmpdir roles (recap, autopilot,
 *  rundown, distiller, optimizer, merge-suggest) whose cwd is a fresh empty dir no untrusted party
 *  can write. Reviewer-kind spawns MUST NOT use this — they use {@link codexLastMessageFile}. */
export const CODEX_LAST_MESSAGE_FILE = ".shepherd-last-message.txt";

/** The PER-SPAWN last-message filename for a role that runs in an UNTRUSTED checkout (the PR critics).
 *  Keyed on the spawn's session id — an unguessable `randomUUID()` minted per spawn — so a file a PR
 *  commits into its head can never match the name the real run writes and later reads. The read side
 *  reconstructs the same name from the session id it recorded for the spawn. */
export function codexLastMessageFile(spawnSessionId: string): string {
  return `.shepherd-last-message-${spawnSessionId}.txt`;
}

/**
 * Read a role's result text: the role's own `resultFile` first, falling back to the Codex `-o`
 * last-message file — read from the caller-provided `lastMessageFile` — when the result file is
 * absent. Returns null when neither exists (or is unreadable mid-write — treat as not-yet-written and
 * retry next tick). Callers apply their existing parser/validator to the returned text, so behavior is
 * unchanged whenever the result file is present.
 *
 * The fallback is read ONLY from the exact `lastMessageFile` the caller names; when it is omitted
 * there is NO fallback. The helper hardcodes no fallback name, so a fixed guessable file a PR commits
 * into an untrusted reviewer checkout is never read — reviewer-kind callers pass a per-spawn
 * unguessable name ({@link codexLastMessageFile}); tmpdir roles pass {@link CODEX_LAST_MESSAGE_FILE}.
 */
export function readRoleResultText(
  cwd: string,
  resultFile: string,
  lastMessageFile?: string,
): string | null {
  const primary = join(cwd, resultFile);
  if (existsSync(primary)) {
    try {
      return readFileSync(primary, "utf8");
    } catch {
      return null; // unreadable mid-write — retry next tick
    }
  }
  if (!lastMessageFile) return null; // no fallback requested
  const fallback = join(cwd, lastMessageFile);
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
 * Delete a pre-existing verdict RESULT file from a reviewer/critic worktree BEFORE launching the
 * role. REQUIRED for roles that spawn in a worktree checked out from UNTRUSTED PR contents (the PR
 * critics `review.ts` + `standalone-critic.ts` detach at the PR head): the result file has a FIXED
 * name (the prompt tells the agent to write exactly `<resultFile>`), so a malicious PR can commit a
 * strict-JSON `<resultFile>` into its branch, and because the read finalizes a strict parse on the
 * first tick that pre-seed would short-circuit the real reviewer. A detached reviewer worktree exists
 * solely to inspect committed code; the reviewer writes its verdict FRESH during the run, so a
 * `<resultFile>` present at launch is a pre-seed, never a real verdict — removing it is safe and
 * closes the hole. (The `-o` fallback needs no scrub: reviewer-kind spawns use a per-spawn unguessable
 * name a PR can't pre-commit — see {@link codexLastMessageFile}.) Best-effort (a missing file / unlink
 * race must not block the spawn). Harmless for base-checkout reviewers (the plan reviewer detaches at
 * the trusted base) — a defense-in-depth no-op there.
 */
export function scrubStaleVerdictArtifacts(worktreePath: string, resultFile: string): void {
  try {
    rmSync(join(worktreePath, resultFile), { force: true });
  } catch {
    /* best-effort — a pre-seed we can't remove still fails closed via the read path's validators */
  }
}
