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
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  const cursor: LineCursor = { oldNo: 0, newNo: 0 };
  let lineCount = 0; // add/del/ctx lines accumulated for cur
  let totalLines = 0; // global tally across all files
  let capped = false; // true once MAX_TOTAL_LINES is reached

  const finishFile = () => {
    if (!cur) return;
    if (lineCount > MAX_FILE_LINES) {
      cur.truncated = true;
      cur.hunks = [];
    }
    files.push(cur);
  };

  for (const raw of text.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      finishFile();
      hunk = null;
      lineCount = 0;
      cur = startFile(raw);
      continue;
    }
    if (!cur) continue;

    // Always process file-header and hunk-header lines — they are O(files), bounded
    // by the 64 MiB input cap, and keep metadata (status/path/rename) accurate even
    // for files beyond the global cap.
    if (applyFileHeader(cur, raw)) continue;

    if (raw.startsWith("@@")) {
      const start = parseHunkHeader(raw);
      cursor.oldNo = start.oldNo;
      cursor.newNo = start.newNo;
      // Under the cap: accumulate normally. Over the cap: hunk slot is not needed
      // (body lines will be skipped), so don't push to cur.hunks.
      if (!capped) {
        hunk = { header: raw, lines: [] };
        cur.hunks.push(hunk);
      }
      continue;
    }

    // Skip body-line accumulation once globally capped.
    if (capped) {
      // Mark this file truncated once, at the point of transition or on first visit.
      if (!cur.truncated) {
        cur.truncated = true;
        cur.hunks = [];
      }
      continue;
    }

    if (!hunk) continue;
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"

    if (appendBodyLine(cur, hunk, cursor, raw)) {
      lineCount++;
      totalLines++;
      // Transition: cap hit on this line — mark current file and set flag.
      if (totalLines >= MAX_TOTAL_LINES) {
        capped = true;
        cur.truncated = true;
        cur.hunks = [];
      }
    }
  }
  finishFile();
  return files;
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
