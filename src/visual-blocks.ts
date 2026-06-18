/**
 * Pure helpers for native visual recap blocks — no I/O, no DB, no spawn.
 * Provides the VisualBlock discriminated union, a fail-closed LLM-JSON parser,
 * and diff-join / file-tree-reconcile / hunk-cap helpers.
 */
import type { DiffFile, DiffFileStatus } from "./types";

// ── Types ─────────────────────────────────────────────────────────────────────

export type CalloutTone = "info" | "decision" | "risk" | "warning" | "success";
export type FileTreeChange = "added" | "modified" | "removed" | "renamed";

export interface FileTreeEntry {
  path: string;
  change: FileTreeChange;
  note?: string;
}

/** Prose-only annotation — no line numbers (Phase 1). */
export interface DiffAnnotation {
  label?: string;
  note: string;
}

export type VisualBlock =
  | { type: "rich-text"; id: string; markdown: string }
  | { type: "callout"; id: string; tone: CalloutTone; markdown: string }
  | { type: "file-tree"; id: string; title?: string; entries: FileTreeEntry[] }
  | {
      type: "diff";
      id: string;
      path: string;
      summary: string;
      annotations?: DiffAnnotation[];
      /** Server-joined real diff; populated by joinDiffBlocks — never from LLM input. */
      file?: DiffFile;
    };

// ── Constants ─────────────────────────────────────────────────────────────────

export const CALLOUT_TONES: readonly CalloutTone[] = [
  "info",
  "decision",
  "risk",
  "warning",
  "success",
];

export const FILE_TREE_CHANGES: readonly FileTreeChange[] = [
  "added",
  "modified",
  "removed",
  "renamed",
];

export const DIFF_BLOCK_MAX_LINES = 600;

// ── parseVisualBlocks ─────────────────────────────────────────────────────────

/** Parse + validate LLM-emitted JSON into typed VisualBlock[]. Never throws.
 *  Drops malformed blocks and returns only valid ones ([] on non-array input).
 *  This is the trust boundary — be defensive, drop on any doubt. */
export function parseVisualBlocks(raw: unknown): VisualBlock[] {
  if (!Array.isArray(raw)) return [];

  const result: VisualBlock[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const r = item as Record<string, unknown>;

    const id = r.id;
    if (typeof id !== "string" || id === "") continue;

    const type = r.type;
    if (typeof type !== "string") continue;

    switch (type) {
      case "rich-text": {
        if (typeof r.markdown !== "string") continue;
        result.push({ type: "rich-text", id, markdown: r.markdown });
        break;
      }
      case "callout": {
        if (typeof r.markdown !== "string") continue;
        if (!CALLOUT_TONES.includes(r.tone as CalloutTone)) continue;
        result.push({ type: "callout", id, tone: r.tone as CalloutTone, markdown: r.markdown });
        break;
      }
      case "file-tree": {
        const rawEntries = r.entries;
        const entries: FileTreeEntry[] = [];
        if (Array.isArray(rawEntries)) {
          for (const e of rawEntries) {
            if (!e || typeof e !== "object" || Array.isArray(e)) continue;
            const er = e as Record<string, unknown>;
            if (typeof er.path !== "string" || er.path === "") continue;
            if (!FILE_TREE_CHANGES.includes(er.change as FileTreeChange)) continue;
            const entry: FileTreeEntry = {
              path: er.path,
              change: er.change as FileTreeChange,
            };
            if (typeof er.note === "string") entry.note = er.note;
            entries.push(entry);
          }
        }
        if (entries.length === 0) continue;
        const block: VisualBlock & { type: "file-tree" } = { type: "file-tree", id, entries };
        if (typeof r.title === "string") block.title = r.title;
        result.push(block);
        break;
      }
      case "diff": {
        if (typeof r.path !== "string" || r.path === "") continue;
        if (typeof r.summary !== "string") continue;
        const block: VisualBlock & { type: "diff" } = {
          type: "diff",
          id,
          path: r.path,
          summary: r.summary,
          // strip any incoming `file` field — server populates it via joinDiffBlocks
        };
        const rawAnnotations = r.annotations;
        if (Array.isArray(rawAnnotations)) {
          const annotations: DiffAnnotation[] = [];
          for (const a of rawAnnotations) {
            if (!a || typeof a !== "object" || Array.isArray(a)) continue;
            const ar = a as Record<string, unknown>;
            if (typeof ar.note !== "string") continue;
            // strip lines/side (Phase-1 prose-only annotations)
            const ann: DiffAnnotation = { note: ar.note };
            if (typeof ar.label === "string") ann.label = ar.label;
            annotations.push(ann);
          }
          if (annotations.length > 0) block.annotations = annotations;
        }
        result.push(block);
        break;
      }
      default:
        // unknown type — drop
        continue;
    }
  }

  return result;
}

// ── joinDiffBlocks ────────────────────────────────────────────────────────────

/** For each `diff` block, attach the matching DiffFile (exact path match).
 *  Drops diff blocks with no match (enforces true-by-construction).
 *  Non-diff blocks pass through. Returns a new array; inputs not mutated. */
export function joinDiffBlocks(blocks: VisualBlock[], diffFiles: DiffFile[]): VisualBlock[] {
  const byPath = new Map<string, DiffFile>(diffFiles.map((f) => [f.path, f]));
  const result: VisualBlock[] = [];

  for (const block of blocks) {
    if (block.type !== "diff") {
      result.push(block);
      continue;
    }
    const file = byPath.get(block.path);
    if (!file) continue; // unmatched — drop
    result.push({ ...block, file });
  }

  return result;
}

// ── reconcileFileTree ─────────────────────────────────────────────────────────

/** Map DiffFileStatus to FileTreeChange. "deleted" → "removed"; others are identical strings. */
function statusToChange(status: DiffFileStatus): FileTreeChange {
  return status === "deleted" ? "removed" : (status as FileTreeChange);
}

/** For each `file-tree` block, override entry changes with real diff statuses and drop invented paths.
 *  Drops whole block when all entries are invented. Non-file-tree blocks pass through.
 *  Returns a new array; inputs not mutated. */
export function reconcileFileTree(blocks: VisualBlock[], diffFiles: DiffFile[]): VisualBlock[] {
  const byPath = new Map<string, DiffFileStatus>(diffFiles.map((f) => [f.path, f.status]));
  const result: VisualBlock[] = [];

  for (const block of blocks) {
    if (block.type !== "file-tree") {
      result.push(block);
      continue;
    }
    const entries: FileTreeEntry[] = [];
    for (const entry of block.entries) {
      const status = byPath.get(entry.path);
      if (status === undefined) continue; // invented path — drop
      entries.push({ ...entry, change: statusToChange(status) });
    }
    if (entries.length === 0) continue; // all entries were invented — drop whole block
    result.push({ ...block, entries });
  }

  return result;
}

// ── groundBlocks ──────────────────────────────────────────────────────────────

/**
 * Ground LLM-emitted blocks against the real diff.
 *  - Carrier present (pendingDiff non-empty): join diff blocks to real DiffFiles (drop unmatched),
 *    cap each joined file's hunks, and reconcile file-tree entries against the real diff.
 *  - Carrier empty (e.g. a server bounce lost it before finalize): FAIL CLOSED — drop all `diff`
 *    blocks (no real hunks to show), keep `file-tree` entries whose path is in `changedFiles`
 *    (paths survive teardown; status does not, so the authored `change` is kept as-is), and pass
 *    `rich-text`/`callout` through untouched.
 */
export function groundBlocks(
  blocks: VisualBlock[],
  pendingDiff: DiffFile[],
  changedFiles: string[],
): VisualBlock[] {
  if (pendingDiff.length > 0) {
    let b = joinDiffBlocks(blocks, pendingDiff); // diff blocks → .file set, unmatched dropped
    b = b.map((blk) =>
      blk.type === "diff" && blk.file ? { ...blk, file: capDiffBlock(blk.file) } : blk,
    );
    return reconcileFileTree(b, pendingDiff);
  }
  // carrier miss — fail closed
  const paths = new Set(changedFiles);
  const out: VisualBlock[] = [];
  for (const blk of blocks) {
    if (blk.type === "diff") continue; // no real hunks → drop
    if (blk.type === "file-tree") {
      const entries = blk.entries.filter((e) => paths.has(e.path));
      if (entries.length > 0) out.push({ ...blk, entries });
      continue;
    }
    out.push(blk);
  }
  return out;
}

// ── capDiffBlock ──────────────────────────────────────────────────────────────

/** Bounds a DiffFile so persisted blocks JSON can't balloon.
 *  If total hunk line count exceeds maxLines, returns a copy with truncated=true and hunks=[].
 *  Otherwise returns the same object (no allocation). Pure, no mutation. */
export function capDiffBlock(file: DiffFile, maxLines = DIFF_BLOCK_MAX_LINES): DiffFile {
  const total = file.hunks.reduce((sum, h) => sum + h.lines.length, 0);
  if (total <= maxLines) return file;
  return { ...file, truncated: true, hunks: [] };
}
