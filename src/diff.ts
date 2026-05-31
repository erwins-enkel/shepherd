import { execFileSync } from "node:child_process";
import type { DiffFile, DiffHunk, DiffResult } from "./types";

/** Files with more than this many diff lines render as a stub ("view in terminal"). */
const MAX_FILE_LINES = 2000;

/** Strip git's a//b/ prefix; map /dev/null to "". */
function stripPrefix(p: string): string {
  if (p === "/dev/null") return "";
  return p.replace(/^[ab]\//, "");
}

/**
 * Parse `git diff --no-color` unified output into structured files.
 * Handles added / modified / deleted / renamed / binary, computes +/- counts,
 * and assigns 1-based old/new line numbers. Files over MAX_FILE_LINES keep their
 * counts but drop hunk bodies (truncated=true).
 */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let lineCount = 0; // add/del/ctx lines accumulated for cur

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
      const m = raw.match(/^diff --git a\/(.+) b\/(.+)$/);
      cur = {
        path: m ? m[2]! : "",
        status: "modified",
        additions: 0,
        deletions: 0,
        binary: false,
        hunks: [],
      };
      continue;
    }
    if (!cur) continue;

    if (raw.startsWith("new file mode")) {
      cur.status = "added";
      continue;
    }
    if (raw.startsWith("deleted file mode")) {
      cur.status = "deleted";
      continue;
    }
    if (raw.startsWith("rename from ")) {
      cur.status = "renamed";
      cur.oldPath = raw.slice("rename from ".length);
      continue;
    }
    if (raw.startsWith("rename to ")) {
      cur.status = "renamed";
      cur.path = raw.slice("rename to ".length);
      continue;
    }
    if (raw.startsWith("Binary files")) {
      cur.binary = true;
      continue;
    }
    if (raw.startsWith("--- ")) {
      const p = stripPrefix(raw.slice(4));
      if (p) cur.oldPath = cur.status === "renamed" ? cur.oldPath : p;
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const p = stripPrefix(raw.slice(4));
      if (p) cur.path = p;
      continue;
    }
    if (raw.startsWith("@@")) {
      const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      oldNo = m ? parseInt(m[1]!, 10) : 0;
      newNo = m ? parseInt(m[2]!, 10) : 0;
      hunk = { header: raw, lines: [] };
      cur.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;

    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"

    const marker = raw[0];
    const content = raw.slice(1);
    if (marker === "+") {
      cur.additions++;
      lineCount++;
      hunk.lines.push({ kind: "add", content, newNo: newNo++ });
    } else if (marker === "-") {
      cur.deletions++;
      lineCount++;
      hunk.lines.push({ kind: "del", content, oldNo: oldNo++ });
    } else if (marker === " ") {
      lineCount++;
      hunk.lines.push({ kind: "ctx", content, oldNo: oldNo++, newNo: newNo++ });
    }
  }
  finishFile();
  return files;
}

const REMOTE = "origin";
const MAX_BUFFER = 64 * 1024 * 1024; // 64 MiB — large diffs exceed the 1 MiB default

function refExists(cwd: string, ref: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd, stdio: "pipe" });
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
function resolveBaseRef(cwd: string, base: string): { ref: string; fetchFailed: boolean } {
  let fetchFailed = false;
  try {
    execFileSync("git", ["fetch", REMOTE, base], { cwd, stdio: "pipe" });
  } catch {
    fetchFailed = true;
  }
  const remoteRef = `${REMOTE}/${base}`;
  if (refExists(cwd, remoteRef)) return { ref: remoteRef, fetchFailed };
  return { ref: base, fetchFailed: true }; // no remote-tracking ref → local base
}

/**
 * Structured diff of a session's branch against its (freshly fetched) base.
 * Uses three-dot `<baseRef>...HEAD` = merge-base→HEAD = "what would merge".
 * Non-isolated sessions (no branch) return an empty result for the empty state.
 */
export function computeDiff(worktreePath: string, base: string, branch: string | null): DiffResult {
  if (!branch) {
    return { base, baseRef: base, head: null, fetchFailed: false, truncated: false, files: [] };
  }
  const { ref, fetchFailed } = resolveBaseRef(worktreePath, base);
  const out = execFileSync("git", ["diff", "--no-color", `${ref}...HEAD`], {
    cwd: worktreePath,
    stdio: "pipe",
    maxBuffer: MAX_BUFFER,
  }).toString();
  const files = parseUnifiedDiff(out);
  return {
    base,
    baseRef: ref,
    head: branch,
    fetchFailed,
    truncated: files.some((f) => f.truncated),
    files,
  };
}
