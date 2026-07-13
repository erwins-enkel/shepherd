import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { timedAsync } from "./instrument";
import type { DiffFile, DiffHunk, DiffResult } from "./types";

const execFileAsync = promisify(execFile);

/** Files with more than this many diff lines render as a stub ("view in terminal"). */
const MAX_FILE_LINES = 2000;

/**
 * Global cap on total add/del/ctx lines parsed across all files in one diff.
 * Bounds CPU time on pathological diffs (e.g. 64 MiB of generated code).
 * ~100k lines covers the vast majority of real PRs while limiting worst-case parse time.
 */
const MAX_TOTAL_LINES = 100_000;

/** Strip git's a//b/ prefix; map /dev/null to "". */
function stripPrefix(p: string): string {
  if (p === "/dev/null") return "";
  return p.replace(/^[ab]\//, "");
}

/** Start a fresh DiffFile from a `diff --git a/… b/…` header line. */
function startFile(raw: string): DiffFile {
  const m = raw.match(/^diff --git a\/(.+) b\/(.+)$/);
  return {
    path: m ? m[2]! : "",
    status: "modified",
    additions: 0,
    deletions: 0,
    binary: false,
    hunks: [],
  };
}

/**
 * Apply a file-metadata header line (mode/rename/binary/---/+++ ) to `cur`.
 * Returns true when the line was a recognized header and consumed.
 */
function applyFileHeader(cur: DiffFile, raw: string): boolean {
  if (raw.startsWith("new file mode")) {
    cur.status = "added";
  } else if (raw.startsWith("deleted file mode")) {
    cur.status = "deleted";
  } else if (raw.startsWith("rename from ")) {
    cur.status = "renamed";
    cur.oldPath = raw.slice("rename from ".length);
  } else if (raw.startsWith("rename to ")) {
    cur.status = "renamed";
    cur.path = raw.slice("rename to ".length);
  } else if (raw.startsWith("Binary files")) {
    cur.binary = true;
  } else if (raw.startsWith("--- ")) {
    const p = stripPrefix(raw.slice(4));
    if (p) cur.oldPath = cur.status === "renamed" ? cur.oldPath : p;
  } else if (raw.startsWith("+++ ")) {
    const p = stripPrefix(raw.slice(4));
    if (p) cur.path = p;
  } else {
    return false;
  }
  return true;
}

/** Parse a `@@ -a,b +c,d @@` hunk header into 1-based old/new starting line numbers. */
function parseHunkHeader(raw: string): { oldNo: number; newNo: number } {
  const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  return {
    oldNo: m ? parseInt(m[1]!, 10) : 0,
    newNo: m ? parseInt(m[2]!, 10) : 0,
  };
}

/** Cursor over old/new line numbers, mutated as hunk body lines are classified. */
interface LineCursor {
  oldNo: number;
  newNo: number;
}

/**
 * Classify one hunk body line and append it to `hunk`, advancing line numbers and
 * file counts. Returns true when the line counted toward MAX_FILE_LINES (add/del/ctx).
 */
function appendBodyLine(cur: DiffFile, hunk: DiffHunk, cursor: LineCursor, raw: string): boolean {
  const marker = raw[0];
  const content = raw.slice(1);
  if (marker === "+") {
    cur.additions++;
    hunk.lines.push({ kind: "add", content, newNo: cursor.newNo++ });
    return true;
  }
  if (marker === "-") {
    cur.deletions++;
    hunk.lines.push({ kind: "del", content, oldNo: cursor.oldNo++ });
    return true;
  }
  if (marker === " ") {
    hunk.lines.push({ kind: "ctx", content, oldNo: cursor.oldNo++, newNo: cursor.newNo++ });
    return true;
  }
  return false;
}

/** Mutable parse state threaded through handleDiffLine. */
interface ParseState {
  files: DiffFile[];
  cur: DiffFile | null;
  hunk: DiffHunk | null;
  cursor: LineCursor;
  lineCount: number; // add/del/ctx lines accumulated for cur
  totalLines: number; // global tally across all files
  capped: boolean; // true once MAX_TOTAL_LINES is reached
  rawBuf: string[]; // raw lines for cur, from its "diff --git" header on; feeds cur.patch
}

/**
 * Seal cur into files, marking truncated when over per-file cap. Sets `patch` to the
 * losslessly-buffered raw diff block, but only for files a client can actually use it
 * for (not truncated, not binary, has at least one body line) — binary/truncated files
 * skip Pierre rendering downstream, so there's no point shipping their raw bytes.
 */
function finishFile(state: ParseState): void {
  if (!state.cur) return;
  if (state.lineCount > MAX_FILE_LINES) {
    state.cur.truncated = true;
    state.cur.hunks = [];
  }
  if (!state.cur.truncated && !state.cur.binary && state.lineCount > 0) {
    state.cur.patch = state.rawBuf.join("\n");
  }
  state.files.push(state.cur);
}

/**
 * Dispatch one raw diff line against the current parse state.
 * Always processes file-header and hunk-header lines — O(files), not O(body-lines) —
 * so over-cap files still carry correct status/path/rename metadata.
 */
function handleDiffLine(state: ParseState, raw: string): void {
  if (raw.startsWith("diff --git ")) {
    finishFile(state);
    state.hunk = null;
    state.lineCount = 0;
    state.cur = startFile(raw);
    state.rawBuf = [raw];
    return;
  }
  if (!state.cur) return;
  // Buffer the raw line for cur.patch. Skipped once globally capped — those files are
  // truncated anyway, so there's no point holding onto their (large) raw text.
  if (!state.capped) state.rawBuf.push(raw);
  if (applyFileHeader(state.cur, raw)) return;

  if (raw.startsWith("@@")) {
    const start = parseHunkHeader(raw);
    state.cursor.oldNo = start.oldNo;
    state.cursor.newNo = start.newNo;
    // Under cap: accumulate. Over cap: body lines are skipped, no hunk slot needed.
    if (!state.capped) {
      state.hunk = { header: raw, lines: [] };
      state.cur.hunks.push(state.hunk);
    }
    return;
  }

  // Skip body-line work once globally capped; mark file truncated on first visit.
  if (state.capped) {
    if (!state.cur.truncated) {
      state.cur.truncated = true;
      state.cur.hunks = [];
    }
    return;
  }

  if (!state.hunk) return;
  if (raw.startsWith("\\")) return; // "\ No newline at end of file"

  if (appendBodyLine(state.cur, state.hunk, state.cursor, raw)) {
    state.lineCount++;
    state.totalLines++;
    // Transition: cap hit — mark current file and set flag.
    if (state.totalLines >= MAX_TOTAL_LINES) {
      state.capped = true;
      state.cur.truncated = true;
      state.cur.hunks = [];
    }
  }
}

/**
 * Parse `git diff --no-color` unified output into structured files.
 * Handles added / modified / deleted / renamed / binary, computes +/- counts,
 * and assigns 1-based old/new line numbers. Files over MAX_FILE_LINES keep their
 * counts but drop hunk bodies (truncated=true). Once total lines across all files
 * exceeds MAX_TOTAL_LINES, further body-line accumulation is skipped; file-header
 * and hunk-header lines are still processed so over-cap files carry correct
 * status/path/rename metadata (O(files), not O(body-lines)).
 */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const state: ParseState = {
    files: [],
    cur: null,
    hunk: null,
    cursor: { oldNo: 0, newNo: 0 },
    lineCount: 0,
    totalLines: 0,
    capped: false,
    rawBuf: [],
  };
  for (const raw of text.split("\n")) handleDiffLine(state, raw);
  finishFile(state);
  return state.files;
}

/** Session-wire shape: send raw `patch`, drop the redundant structured `hunks`. */
export function toSessionDiff(result: DiffResult): DiffResult {
  return {
    ...result,
    files: result.files.map(({ hunks, ...f }) => {
      void hunks; // intentionally dropped from the wire shape; see doc comment above
      return f as DiffFile;
    }),
  };
}

const REMOTE = "origin";
const MAX_BUFFER = 64 * 1024 * 1024; // 64 MiB — large diffs exceed the 1 MiB default

async function refExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await timedAsync("git rev-parse", () =>
      execFileAsync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd, encoding: "utf8" }),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort fetch the base from origin, then choose the ref to diff against:
 * prefer origin/<base>; fall back to local <base> when the fetch fails or the
 * remote-tracking ref doesn't resolve. Returns the chosen ref + whether fetch failed.
 */
async function resolveBaseRef(
  cwd: string,
  base: string,
): Promise<{ ref: string; fetchFailed: boolean }> {
  let fetchFailed = false;
  try {
    await timedAsync("git fetch", () =>
      execFileAsync("git", ["fetch", REMOTE, base], { cwd, encoding: "utf8" }),
    );
  } catch {
    fetchFailed = true;
  }
  const remoteRef = `${REMOTE}/${base}`;
  if (await refExists(cwd, remoteRef)) return { ref: remoteRef, fetchFailed };
  return { ref: base, fetchFailed: true }; // no remote-tracking ref → local base
}

/**
 * Cheap, no-network check: does this branch have any committed changes vs base?
 *
 * Ref resolution: prefers `origin/<base>` when the local remote-tracking ref
 * exists (avoids a fetch — three-dot merge-base diff means a stale local base
 * can never produce a *false* diff, so no fetch is needed for correctness).
 * Falls back to `<base>` when no remote-tracking ref is present.
 *
 * Exit-code semantics: `git diff --quiet` exits 0 (no diff → false) or 1 (diff
 * exists → true). Any other non-zero exit is a real error and is rethrown so the
 * caller can log it and fail open — never swallow unexpected git errors.
 *
 * Non-isolated sessions (branch == null) have no branch and return false
 * immediately without invoking git.
 */
export async function hasCommittedChanges(
  worktreePath: string,
  base: string,
  branch: string | null,
): Promise<boolean> {
  if (branch === null) return false;

  const remoteRef = `${REMOTE}/${base}`;
  const ref = (await refExists(worktreePath, remoteRef)) ? remoteRef : base;

  try {
    await timedAsync("git diff --quiet", () =>
      execFileAsync("git", ["diff", "--quiet", `${ref}...HEAD`], {
        cwd: worktreePath,
        encoding: "utf8",
      }),
    );
    return false; // exit 0 → no diff
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === 1) return true; // exit 1 → diff exists
    throw err; // unexpected error (e.g. not a repo, git missing)
  }
}

/**
 * Structured diff of a session's branch against its (freshly fetched) base.
 * Uses three-dot `<baseRef>...HEAD` = merge-base→HEAD = "what would merge".
 * Non-isolated sessions (no branch) return an empty result for the empty state.
 */
export async function computeDiff(
  worktreePath: string,
  base: string,
  branch: string | null,
): Promise<DiffResult> {
  if (!branch) {
    return { base, baseRef: base, head: null, fetchFailed: false, truncated: false, files: [] };
  }
  const { ref, fetchFailed } = await resolveBaseRef(worktreePath, base);
  const { stdout } = await timedAsync("git diff", () =>
    execFileAsync("git", ["diff", "--no-color", `${ref}...HEAD`], {
      cwd: worktreePath,
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
    }),
  );
  const files = parseUnifiedDiff(stdout);
  return {
    base,
    baseRef: ref,
    head: branch,
    fetchFailed,
    truncated: files.some((f) => f.truncated),
    files,
  };
}
