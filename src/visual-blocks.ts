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
    }
  | {
      type: "code";
      id: string;
      filename: string;
      /** Server-populated from DiffFile — never from LLM input. */
      code?: string;
      truncated?: boolean;
    }
  | {
      type: "annotated-code";
      id: string;
      filename: string;
      /** Prose-only annotations — no line anchors (decision #4). */
      annotations?: DiffAnnotation[];
      /** Server-populated from DiffFile — never from LLM input. */
      code?: string;
      truncated?: boolean;
    }
  | {
      type: "data-model";
      id: string;
      /** Server-forced to true — never trusted from LLM input. */
      inferred?: boolean;
      entities: {
        id: string;
        name: string;
        fields: {
          name: string;
          type: string;
          pk?: boolean;
          fk?: string;
          nullable?: boolean;
          change?: FileTreeChange;
          was?: string;
        }[];
      }[];
      relations?: { from: string; to: string; kind: string }[];
    }
  | {
      type: "api-endpoint";
      id: string;
      method: string;
      path: string;
      summary?: string;
      change?: string;
      deprecated?: boolean;
      /** Server-forced to true — never trusted from LLM input. */
      inferred?: boolean;
      params?: { name: string; in: string; type: string; required?: boolean; note?: string }[];
      responses?: { status: number; description?: string; example?: string }[];
    }
  | { type: "table"; id: string; columns: string[]; rows: string[][] }
  | {
      type: "checklist";
      id: string;
      items: { id: string; label: string; note?: string; checked?: boolean }[];
    }
  | { type: "mermaid"; id: string; source: string; caption?: string; inferred?: boolean }
  | {
      type: "wireframe";
      id: string;
      surface: "browser" | "desktop" | "mobile" | "popover" | "panel";
      html: string;
      caption?: string;
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
export const MERMAID_SOURCE_MAX_CHARS = 8000;
export const WIREFRAME_HTML_MAX_CHARS = 20000;

export const WIREFRAME_SURFACES: readonly (
  | "browser"
  | "desktop"
  | "mobile"
  | "popover"
  | "panel"
)[] = ["browser", "desktop", "mobile", "popover", "panel"];

// ── parseVisualBlocks ─────────────────────────────────────────────────────────

function validateRichText(r: Record<string, unknown>, id: string): VisualBlock | null {
  if (typeof r.markdown !== "string") return null;
  return { type: "rich-text", id, markdown: r.markdown };
}

function validateCallout(r: Record<string, unknown>, id: string): VisualBlock | null {
  if (typeof r.markdown !== "string") return null;
  if (!CALLOUT_TONES.includes(r.tone as CalloutTone)) return null;
  return { type: "callout", id, tone: r.tone as CalloutTone, markdown: r.markdown };
}

function validateFileTreeEntry(raw: unknown): FileTreeEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const er = raw as Record<string, unknown>;
  if (typeof er.path !== "string" || er.path === "") return null;
  if (!FILE_TREE_CHANGES.includes(er.change as FileTreeChange)) return null;
  const entry: FileTreeEntry = { path: er.path, change: er.change as FileTreeChange };
  if (typeof er.note === "string") entry.note = er.note;
  return entry;
}

function validateFileTree(r: Record<string, unknown>, id: string): VisualBlock | null {
  const entries: FileTreeEntry[] = [];
  if (Array.isArray(r.entries)) {
    for (const e of r.entries) {
      const entry = validateFileTreeEntry(e);
      if (entry) entries.push(entry);
    }
  }
  if (entries.length === 0) return null;
  const block: VisualBlock & { type: "file-tree" } = { type: "file-tree", id, entries };
  if (typeof r.title === "string") block.title = r.title;
  return block;
}

function validateDiffAnnotation(raw: unknown): DiffAnnotation | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const ar = raw as Record<string, unknown>;
  if (typeof ar.note !== "string") return null;
  // strip lines/side (Phase-1 prose-only annotations)
  const ann: DiffAnnotation = { note: ar.note };
  if (typeof ar.label === "string") ann.label = ar.label;
  return ann;
}

function validateDiff(r: Record<string, unknown>, id: string): VisualBlock | null {
  if (typeof r.path !== "string" || r.path === "") return null;
  if (typeof r.summary !== "string") return null;
  const block: VisualBlock & { type: "diff" } = {
    type: "diff",
    id,
    path: r.path,
    summary: r.summary,
    // strip any incoming `file` field — server populates it via joinDiffBlocks
  };
  if (Array.isArray(r.annotations)) {
    const annotations: DiffAnnotation[] = [];
    for (const a of r.annotations) {
      const ann = validateDiffAnnotation(a);
      if (ann) annotations.push(ann);
    }
    if (annotations.length > 0) block.annotations = annotations;
  }
  return block;
}

function validateCode(r: Record<string, unknown>, id: string): VisualBlock | null {
  if (typeof r.filename !== "string" || r.filename === "") return null;
  // strip server-populated fields
  const block: VisualBlock & { type: "code" } = { type: "code", id, filename: r.filename };
  // code/truncated intentionally NOT copied — server-populated
  return block;
}

function validateAnnotatedCode(r: Record<string, unknown>, id: string): VisualBlock | null {
  if (typeof r.filename !== "string" || r.filename === "") return null;
  const block: VisualBlock & { type: "annotated-code" } = {
    type: "annotated-code",
    id,
    filename: r.filename,
  };
  if (Array.isArray(r.annotations)) {
    const annotations: DiffAnnotation[] = [];
    for (const a of r.annotations) {
      const ann = validateDiffAnnotation(a); // reuse — drops lines/side
      if (ann) annotations.push(ann);
    }
    if (annotations.length > 0) block.annotations = annotations;
  }
  // code/truncated intentionally NOT copied — server-populated
  return block;
}

function validateDataModelField(raw: unknown): {
  name: string;
  type: string;
  pk?: boolean;
  fk?: string;
  nullable?: boolean;
  change?: FileTreeChange;
  was?: string;
} | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const fr = raw as Record<string, unknown>;
  if (typeof fr.name !== "string" || typeof fr.type !== "string") return null;
  const field: {
    name: string;
    type: string;
    pk?: boolean;
    fk?: string;
    nullable?: boolean;
    change?: FileTreeChange;
    was?: string;
  } = {
    name: fr.name,
    type: fr.type,
  };
  if (fr.pk === true) field.pk = true;
  if (typeof fr.fk === "string") field.fk = fr.fk;
  if (fr.nullable === false) field.nullable = false;
  else if (fr.nullable === true) field.nullable = true;
  if (FILE_TREE_CHANGES.includes(fr.change as FileTreeChange))
    field.change = fr.change as FileTreeChange;
  if (typeof fr.was === "string") field.was = fr.was;
  return field;
}

type DataModelEntity = {
  id: string;
  name: string;
  fields: {
    name: string;
    type: string;
    pk?: boolean;
    fk?: string;
    nullable?: boolean;
    change?: FileTreeChange;
    was?: string;
  }[];
};

function validateEntity(raw: unknown): DataModelEntity | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const er = raw as Record<string, unknown>;
  if (typeof er.id !== "string" || typeof er.name !== "string") return null;
  if (!Array.isArray(er.fields)) return null;
  const fields = er.fields
    .map(validateDataModelField)
    .filter((f): f is NonNullable<typeof f> => f !== null);
  if (fields.length === 0) return null;
  return { id: er.id, name: er.name, fields };
}

function validateRelation(raw: unknown): { from: string; to: string; kind: string } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rr = raw as Record<string, unknown>;
  if (typeof rr.from !== "string" || typeof rr.to !== "string" || typeof rr.kind !== "string")
    return null;
  return { from: rr.from, to: rr.to, kind: rr.kind };
}

function validateDataModel(r: Record<string, unknown>, id: string): VisualBlock | null {
  if (!Array.isArray(r.entities) || r.entities.length === 0) return null;
  const entities: DataModelEntity[] = [];
  const seenEntityIds = new Set<string>();
  for (const e of r.entities.map(validateEntity)) {
    if (!e || seenEntityIds.has(e.id)) continue; // drop invalid + duplicate ids (keyed-each)
    seenEntityIds.add(e.id);
    entities.push(e);
  }
  if (entities.length === 0) return null;
  const block: VisualBlock & { type: "data-model" } = { type: "data-model", id, entities };
  // inferred intentionally NOT copied — server forces it
  if (Array.isArray(r.relations)) {
    const relations = r.relations
      .map(validateRelation)
      .filter((rel): rel is { from: string; to: string; kind: string } => rel !== null);
    if (relations.length > 0) block.relations = relations;
  }
  return block;
}

function validateApiParam(
  raw: unknown,
): { name: string; in: string; type: string; required?: boolean; note?: string } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const pr = raw as Record<string, unknown>;
  if (typeof pr.name !== "string" || typeof pr.in !== "string" || typeof pr.type !== "string")
    return null;
  const param: { name: string; in: string; type: string; required?: boolean; note?: string } = {
    name: pr.name,
    in: pr.in,
    type: pr.type,
  };
  if (pr.required === true) param.required = true;
  if (typeof pr.note === "string") param.note = pr.note;
  return param;
}

function validateApiResponse(
  raw: unknown,
): { status: number; description?: string; example?: string } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rr = raw as Record<string, unknown>;
  if (typeof rr.status !== "number") return null;
  const response: { status: number; description?: string; example?: string } = {
    status: rr.status,
  };
  if (typeof rr.description === "string") response.description = rr.description;
  if (typeof rr.example === "string") response.example = rr.example;
  return response;
}

function validateApiEndpoint(r: Record<string, unknown>, id: string): VisualBlock | null {
  if (typeof r.method !== "string" || r.method === "") return null;
  if (typeof r.path !== "string" || r.path === "") return null;
  const block: VisualBlock & { type: "api-endpoint" } = {
    type: "api-endpoint",
    id,
    method: r.method,
    path: r.path,
  };
  // inferred intentionally NOT copied — server forces it
  if (typeof r.summary === "string") block.summary = r.summary;
  if (typeof r.change === "string") block.change = r.change;
  if (r.deprecated === true) block.deprecated = true;
  if (Array.isArray(r.params)) {
    const params = r.params
      .map(validateApiParam)
      .filter(
        (p): p is { name: string; in: string; type: string; required?: boolean; note?: string } =>
          p !== null,
      );
    if (params.length > 0) block.params = params;
  }
  if (Array.isArray(r.responses)) {
    const responses = r.responses
      .map(validateApiResponse)
      .filter(
        (resp): resp is { status: number; description?: string; example?: string } => resp !== null,
      );
    if (responses.length > 0) block.responses = responses;
  }
  return block;
}

function validateTable(r: Record<string, unknown>, id: string): VisualBlock | null {
  if (!Array.isArray(r.columns) || r.columns.length === 0) return null;
  const columns: string[] = r.columns.filter((c): c is string => typeof c === "string");
  if (columns.length === 0) return null;
  const ncols = columns.length;
  const rows: string[][] = [];
  if (Array.isArray(r.rows)) {
    for (const row of r.rows) {
      if (!Array.isArray(row)) continue;
      const coerced: string[] = row.map((cell) => (typeof cell === "string" ? cell : String(cell)));
      // pad short / truncate long rows to match column count
      while (coerced.length < ncols) coerced.push("");
      rows.push(coerced.slice(0, ncols));
    }
  }
  return { type: "table", id, columns, rows };
}

type ChecklistItem = { id: string; label: string; note?: string; checked?: boolean };

function validateChecklistItem(raw: unknown): ChecklistItem | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const ir = raw as Record<string, unknown>;
  if (typeof ir.id !== "string" || typeof ir.label !== "string") return null;
  const item: ChecklistItem = { id: ir.id, label: ir.label };
  if (typeof ir.note === "string") item.note = ir.note;
  if (typeof ir.checked === "boolean") item.checked = ir.checked;
  return item;
}

function validateChecklist(r: Record<string, unknown>, id: string): VisualBlock | null {
  if (!Array.isArray(r.items)) return null;
  const items: ChecklistItem[] = [];
  const seenItemIds = new Set<string>();
  for (const item of r.items.map(validateChecklistItem)) {
    if (!item || seenItemIds.has(item.id)) continue; // drop invalid + duplicate ids (keyed-each)
    seenItemIds.add(item.id);
    items.push(item);
  }
  if (items.length === 0) return null;
  return { type: "checklist", id, items };
}

function validateMermaid(r: Record<string, unknown>, id: string): VisualBlock | null {
  if (typeof r.source !== "string" || r.source === "") return null;
  if (r.source.length > MERMAID_SOURCE_MAX_CHARS) return null; // DROP — truncating breaks diagram grammar
  const block: VisualBlock & { type: "mermaid" } = { type: "mermaid", id, source: r.source };
  // inferred intentionally NOT copied — server forces it
  if (typeof r.caption === "string") block.caption = r.caption;
  return block;
}

/** Returns true when the html contains structural elements that must be rejected. */
function wireframeHtmlHasUnsafeStructure(html: string): boolean {
  if (/<script/i.test(html)) return true;
  if (/<style/i.test(html)) return true;
  if (/\son[a-z]+\s*=/i.test(html)) return true;
  if (/href\s*=/i.test(html)) return true;
  return false;
}

/** Returns true when any style= attribute value contains raw colors or disallowed properties. */
function wireframeStylesImpure(html: string): boolean {
  const styleAttr = /style\s*=\s*("([^"]*)"|'([^']*)')/gi;
  let match: RegExpExecArray | null;
  while ((match = styleAttr.exec(html)) !== null) {
    const value = match[2] ?? match[3] ?? "";
    if (/#[0-9a-fA-F]{3,8}/.test(value)) return true;
    if (/\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|color)\s*\(/i.test(value)) return true;
    if (/font-family/i.test(value)) return true;
    if (/box-shadow/i.test(value)) return true;
  }
  return false;
}

function validateWireframe(r: Record<string, unknown>, id: string): VisualBlock | null {
  if (!WIREFRAME_SURFACES.includes(r.surface as "browser")) return null;
  if (typeof r.html !== "string" || r.html === "") return null;
  if (r.html.length > WIREFRAME_HTML_MAX_CHARS) return null; // DROP — truncated HTML is malformed
  if (wireframeHtmlHasUnsafeStructure(r.html)) return null;
  if (wireframeStylesImpure(r.html)) return null;
  const block: VisualBlock & { type: "wireframe" } = {
    type: "wireframe",
    id,
    surface: r.surface as "browser" | "desktop" | "mobile" | "popover" | "panel",
    html: r.html,
  };
  if (typeof r.caption === "string") block.caption = r.caption;
  return block;
}

type BlockValidator = (r: Record<string, unknown>, id: string) => VisualBlock | null;

const VALIDATORS: Record<string, BlockValidator> = {
  "rich-text": validateRichText,
  callout: validateCallout,
  "file-tree": validateFileTree,
  diff: validateDiff,
  code: validateCode,
  "annotated-code": validateAnnotatedCode,
  "data-model": validateDataModel,
  "api-endpoint": validateApiEndpoint,
  table: validateTable,
  checklist: validateChecklist,
  mermaid: validateMermaid,
  wireframe: validateWireframe,
};

/** Validate a single raw element into a typed VisualBlock, or null when malformed. */
function parseBlock(item: unknown): VisualBlock | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const r = item as Record<string, unknown>;

  const id = r.id;
  if (typeof id !== "string" || id === "") return null;

  const type = r.type;
  if (typeof type !== "string") return null;

  const validate = VALIDATORS[type]; // unknown type → undefined → drop
  return validate ? validate(r, id) : null;
}

/** Parse + validate LLM-emitted JSON into typed VisualBlock[]. Never throws.
 *  Drops malformed blocks and returns only valid ones ([] on non-array input).
 *  Enforces unique block ids (a later duplicate is dropped) — the renderer keys its
 *  `{#each}` by `block.id`, so a duplicate id would break the keyed-each.
 *  This is the trust boundary — be defensive, drop on any doubt. */
export function parseVisualBlocks(raw: unknown): VisualBlock[] {
  if (!Array.isArray(raw)) return [];

  const result: VisualBlock[] = [];
  const seenIds = new Set<string>();

  for (const item of raw) {
    const block = parseBlock(item);
    if (!block) continue;
    if (seenIds.has(block.id)) continue; // duplicate id → drop (keyed-each requires unique ids)
    seenIds.add(block.id);
    result.push(block);
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

// ── joinCodeBlocks ────────────────────────────────────────────────────────────

/** Reconstruct post-image code from an added DiffFile's hunks.
 *  Returns { code } when reconstruction fits within the cap, or { truncated: true } otherwise.
 *  Returns { truncated: true } when hunks are absent (pre-truncated or binary). */
function reconstructAddedFileCode(file: DiffFile): { code?: string; truncated?: true } {
  if (file.hunks.length === 0) return { truncated: true };
  const lines: string[] = [];
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add" || line.kind === "ctx") {
        lines.push(line.content);
      }
    }
  }
  if (lines.length > DIFF_BLOCK_MAX_LINES) return { truncated: true };
  return { code: lines.join("\n") };
}

/** Reconstruct code bodies for `code`/`annotated-code` blocks from real added DiffFiles.
 *  - Path missing or status !== "added" → drop.
 *  - hunks.length === 0 (pre-truncated or binary) → emit with code omitted + truncated:true.
 *  - Over DIFF_BLOCK_MAX_LINES → truncated:true + code omitted.
 *  - Otherwise reconstruct code from add+ctx lines.
 *  Non-code blocks pass through. Returns a new array; inputs not mutated. */
export function joinCodeBlocks(blocks: VisualBlock[], diffFiles: DiffFile[]): VisualBlock[] {
  const byPath = new Map<string, DiffFile>(diffFiles.map((f) => [f.path, f]));
  const result: VisualBlock[] = [];

  for (const block of blocks) {
    if (block.type !== "code" && block.type !== "annotated-code") {
      result.push(block);
      continue;
    }
    const file = byPath.get(block.filename);
    if (!file || file.status !== "added") continue; // drop
    result.push({ ...block, ...reconstructAddedFileCode(file) });
  }

  return result;
}

// ── markInferred ──────────────────────────────────────────────────────────────

/** Force inferred:true on every data-model/api-endpoint/mermaid block.
 *  Other block types are returned as-is. Returns a new array; inputs not mutated. */
export function markInferred(blocks: VisualBlock[]): VisualBlock[] {
  return blocks.map((blk) => {
    if (blk.type === "data-model" || blk.type === "api-endpoint" || blk.type === "mermaid") {
      return { ...blk, inferred: true };
    }
    return blk;
  });
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
    b = reconcileFileTree(b, pendingDiff);
    b = joinCodeBlocks(b, pendingDiff); // code/annotated-code → reconstruct or drop
    return markInferred(b); // data-model/api-endpoint → inferred:true
  }
  // carrier miss — fail closed
  const paths = new Set(changedFiles);
  const out: VisualBlock[] = [];
  for (const blk of blocks) {
    if (blk.type === "diff") continue; // no real hunks → drop
    if (blk.type === "code" || blk.type === "annotated-code") continue; // no real content → drop
    if (blk.type === "file-tree") {
      const entries = blk.entries.filter((e) => paths.has(e.path));
      if (entries.length > 0) out.push({ ...blk, entries });
      continue;
    }
    out.push(blk);
  }
  return markInferred(out); // data-model/api-endpoint → inferred:true even without carrier
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
