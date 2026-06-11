/**
 * Manages a LOCAL-ONLY `.git/info/exclude` block that hides Shepherd's
 * per-session artifacts (`.shepherd-*`) from `git status`/diffs.
 *
 * INTENT: Write to the shared git common-dir so the exclusion covers the main
 * checkout AND every linked worktree with one write, without touching
 * `.gitignore` or any file that gets committed.
 *
 * NON-GOAL: This is NOT `.gitignore`. Nothing written here is ever committed,
 * shared with other clones, visible to CI, or propagated to teammates.
 * That is DELIBERATE — Shepherd artifacts are hidden uniformly on every repo
 * (including push-able ones) without surprise commits.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "./instrument";

// ── public constants ──────────────────────────────────────────────────────────

export const SHEPHERD_IGNORE_GLOB = ".shepherd-*";
export const SHEPHERD_EXCLUDE_START = "# shepherd:ignore:start";
export const SHEPHERD_EXCLUDE_END = "# shepherd:ignore:end";

// ── pure helpers ──────────────────────────────────────────────────────────────

/**
 * Insert or replace the managed shepherd:ignore block in gitignore-syntax
 * content. Idempotent: replaces an existing managed block's contents rather
 * than appending a duplicate; treats a pre-existing bare `.shepherd-*` line
 * (the glob already present outside the markers) as already-covered → no-op;
 * otherwise appends a fresh block.
 *
 * Generic over the target file — used for BOTH `.git/info/exclude` (via
 * `ensureShepherdExclude`) and a committed `.gitignore` (via `GitignoreAdopter`),
 * which share the same gitignore glob syntax + managed-block markers.
 *
 * Modelled on `upsertLearningsBlock` in `src/promote.ts`.
 */
export function upsertShepherdIgnoreBlock(existing: string): { content: string; changed: boolean } {
  const block = [SHEPHERD_EXCLUDE_START, SHEPHERD_IGNORE_GLOB, SHEPHERD_EXCLUDE_END].join("\n");

  const start = existing.indexOf(SHEPHERD_EXCLUDE_START);
  const end = existing.indexOf(SHEPHERD_EXCLUDE_END);
  if (start !== -1 && end !== -1 && end > start) {
    const content =
      existing.slice(0, start) + block + existing.slice(end + SHEPHERD_EXCLUDE_END.length);
    return { content, changed: content !== existing };
  }

  // No managed block. If the glob is already listed verbatim (e.g. a repo whose
  // committed .gitignore lists `.shepherd-*` by hand), the artifacts are already
  // ignored — don't append a redundant managed block. A commented-out line
  // (`# .shepherd-*`) does not match, so it isn't treated as covered.
  if (existing.split("\n").some((line) => line.trim() === SHEPHERD_IGNORE_GLOB)) {
    return { content: existing, changed: false };
  }

  const sep = existing.length === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  const content = existing + sep + block + "\n";
  return { content, changed: true };
}

// ── path resolver ─────────────────────────────────────────────────────────────

/**
 * Returns the path to `.git/info/exclude` for the repo rooted at `repoPath`,
 * resolved via the git common-dir so it covers the main checkout AND every
 * linked worktree (they all share the same common-dir).
 *
 * Synchronous. Throws on `git rev-parse` failure (no git repo, etc.).
 */
export function excludePath(repoPath: string): string {
  const raw = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: repoPath,
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
  // --git-common-dir may be relative to the queried path; resolve before using
  const commonDir = resolve(repoPath, raw);
  return join(commonDir, "info", "exclude");
}

// ── best-effort public entry point ────────────────────────────────────────────

/**
 * Ensure the managed `.shepherd-*` block is present in the repo's shared
 * `.git/info/exclude`. Synchronous, best-effort, NEVER throws.
 *
 * Fail-open rationale: a missing cosmetic exclude must never abort
 * worktree/session creation. This is distinct from fail-closed (which targets
 * faked success signals) — there are no success signals here.
 */
export function ensureShepherdExclude(repoPath: string): void {
  try {
    const p = excludePath(repoPath);
    const existing = existsSync(p) ? readFileSync(p, "utf8") : "";
    const { content, changed } = upsertShepherdIgnoreBlock(existing);
    if (changed) {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
    }
  } catch (e) {
    console.warn(`[shepherd-exclude] best-effort exclude failed for ${repoPath}:`, e);
  }
}
