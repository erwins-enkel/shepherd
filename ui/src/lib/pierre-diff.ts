// Client-side substrate for the Pierre-powered diff renderer (Task 3/4 build on
// this). All `@pierre/diffs` runtime imports are DYNAMIC so merely importing this
// module (e.g. from a node test exercising the pure helpers below) never touches
// Pierre's DOM-dependent runtime. `import type` is side-effect free and fine at
// top level.
import type { DiffFile } from "./types";
import type { FileDiffMetadata } from "@pierre/diffs";

let registered = false;

/**
 * Register the Shepherd Shiki themes with Pierre's theme resolver, so
 * `FileDiff` can render with `theme: "shepherd-dark" | "shepherd-light"`.
 * Idempotent — safe to call from multiple wrappers/mounts; only the first
 * call does any work.
 */
export async function registerShepherdThemes(): Promise<void> {
  if (registered) return;
  registered = true;
  const { registerCustomTheme } = await import("@pierre/diffs");
  const { SHEPHERD_DARK, SHEPHERD_LIGHT } = await import("./highlight");
  registerCustomTheme("shepherd-dark", async () => SHEPHERD_DARK);
  registerCustomTheme("shepherd-light", async () => SHEPHERD_LIGHT);
}

/**
 * Parse a single-file unified diff patch into Pierre's `FileDiffMetadata`
 * (the shape `FileDiff.render({ fileDiff })` expects). Returns `null` when
 * parsing yields no file (empty/invalid patch).
 */
export async function parseFilePatch(patch: string): Promise<FileDiffMetadata | null> {
  const { parsePatchFiles } = await import("@pierre/diffs");
  return parsePatchFiles(patch)[0]?.files[0] ?? null;
}

/**
 * Cheap deterministic djb2 hash → base36 string. Not cryptographic — only used
 * to detect whether a file's diff content changed between 15s polls.
 */
function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (h * 33) ^ s.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

/**
 * A deterministic signature for a `DiffFile`, used to skip re-rendering a
 * file whose content hasn't changed since the last poll. Hashes the exact
 * patch text plus the summary fields (status/additions/deletions/binary/
 * truncated), so binary/truncated files (no `patch`) still get a signature
 * that changes when their summary changes.
 */
export function fileSignature(file: DiffFile): string {
  const basis = `${file.patch ?? ""}|${file.status}|${file.additions}|${file.deletions}|${file.binary}|${file.truncated ?? false}`;
  return hashString(basis);
}

const ROW_HEIGHT_PX = 20; // rough per-rendered-line height (font + line-height); estimate only
const HEADER_PADDING_PX = 44; // file header row + top/bottom padding; estimate only

/**
 * Rough pixel height for a placeholder rendered before Pierre mounts the real
 * `FileDiff`, so lazy-rendered files don't jump the scroll position. Estimates
 * row count from the patch's line count when present, else falls back to
 * additions + deletions (binary/truncated files).
 */
export function estimateHeight(file: DiffFile): number {
  const rows =
    file.patch !== undefined ? file.patch.split("\n").length : file.additions + file.deletions;
  return rows * ROW_HEIGHT_PX + HEADER_PADDING_PX;
}
