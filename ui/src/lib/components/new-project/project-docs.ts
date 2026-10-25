// Pure logic behind the New Project PRD/design attachments (#3112, #3420).

// Mirror src/project-docs.ts PROJECT_DOCS_MAX_FILES / PROJECT_DOCS_MAX_BYTES (keep in sync).
const MAX_FILES = 500;
const MAX_BYTES = 50 * 1024 * 1024;

export type DocArea = "prd" | "design";

/** A file bound for `docs/<area>/<path>`. `folder`: the dropped/picked folder it came from
 *  (its top name, already stripped from `path`), or null for a loose file. */
export interface AttachedDoc {
  file: File;
  path: string;
  folder: string | null;
}
export interface AttachedDocs {
  prd: AttachedDoc[];
  design: AttachedDoc[];
}

export function emptyDocs(): AttachedDocs {
  return { prd: [], design: [] };
}

/** "export/a/b.png" → { path: "a/b.png", folder: "export" }; "prd.md" → { path: "prd.md", folder: null }.
 *  Null on an empty or dot-prefixed segment (`.DS_Store`, `.git/…`) or a folder with nothing under
 *  it. The server re-validates every path. */
export function docPath(rel: string): { path: string; folder: string | null } | null {
  const segs = rel.split("/");
  if (segs.some((s) => !s || s.startsWith("."))) return null;
  if (segs.length === 1) return { path: rel, folder: null };
  return { path: segs.slice(1).join("/"), folder: segs[0] };
}

const PRD_EXT = /\.(md|markdown|txt|pdf)$/i;

/** Whether a loose dropped file belongs under `docs/prd/` rather than `docs/design/`. */
export function isPrdFile(name: string): boolean {
  return PRD_EXT.test(name);
}

function toDoc(file: File, rel: string): AttachedDoc | null {
  const p = docPath(rel);
  return p && { file, ...p };
}

/** Files from an `<input type=file>`, hidden ones skipped. */
export function pickedDocs(files: FileList | File[] | null): AttachedDoc[] {
  const out: AttachedDoc[] = [];
  for (const file of files ?? []) {
    const d = toDoc(file, file.webkitRelativePath || file.name);
    if (d) out.push(d);
  }
  return out;
}

/** A dropped file with its path relative to the drop ("prd.md" loose, "export/a.png" in a folder). */
export interface DroppedFile {
  file: File;
  rel: string;
}

/** Loose PRD-type files → prd; every other file (loose or in a folder) → design. */
export function sortDropped(items: DroppedFile[]): AttachedDocs {
  const out = emptyDocs();
  for (const { file, rel } of items) {
    const d = toDoc(file, rel);
    if (!d) continue;
    (d.folder === null && isPrdFile(d.path) ? out.prd : out.design).push(d);
  }
  return out;
}

const isHidden = (e: FileSystemEntry): boolean => e.name.startsWith(".");

const readBatch = (reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> =>
  new Promise((ok, bad) => reader.readEntries(ok, bad));

/** Browsers return a directory's entries in batches (Chromium ≤100): read until an empty one. */
async function readAllEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  for (let batch = await readBatch(reader); batch.length; batch = await readBatch(reader)) {
    all.push(...batch);
  }
  return all;
}

/** Recursively read one drop entry; hidden entries are skipped without descending. A read error
 *  rejects. */
export async function walkDropEntry(entry: FileSystemEntry): Promise<DroppedFile[]> {
  if (isHidden(entry)) return [];
  if (entry.isFile) {
    const file = await new Promise<File>((ok, bad) => (entry as FileSystemFileEntry).file(ok, bad));
    return [{ file, rel: entry.fullPath.replace(/^\//, "") }];
  }
  const children = await readAllEntries(entry as FileSystemDirectoryEntry);
  return (await Promise.all(children.map(walkDropEntry))).flat();
}

/** All files of a drop. Entries are captured synchronously — DataTransfer items are invalid once
 *  the drop event returns — and only then walked. */
export function filesFromDrop(dt: DataTransfer): Promise<DroppedFile[]> {
  const jobs: Promise<DroppedFile[]>[] = [];
  for (const item of Array.from(dt.items)) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry();
    const file = entry ? null : item.getAsFile();
    if (entry) jobs.push(walkDropEntry(entry));
    else if (file) jobs.push(Promise.resolve([{ file, rel: file.name }]));
  }
  return Promise.all(jobs).then((r) => r.flat());
}

/** Later wins per `path`; survivors of `cur` keep their order, then `add`. */
function mergeArea(cur: AttachedDoc[], add: AttachedDoc[]): AttachedDoc[] {
  const byPath = new Map<string, AttachedDoc>();
  for (const d of add) byPath.set(d.path, d);
  return [...cur.filter((d) => !byPath.has(d.path)), ...byPath.values()];
}

/** Append `add` to `cur`; within one area a file with the same `path` replaces the earlier one. */
export function mergeDocs(cur: AttachedDocs, add: AttachedDocs): AttachedDocs {
  return { prd: mergeArea(cur.prd, add.prd), design: mergeArea(cur.design, add.design) };
}

export interface DocChip {
  area: DocArea;
  /** Stable, unique within its area: distinguishes a folder chip from a loose file of the same name. */
  key: string;
  /** The loose file's path, or the folder's name. */
  name: string;
  /** "docs/prd/prd.md" for a file; "docs/design/" for a folder. */
  target: string;
  /** Files the chip stands for (1 for a loose file). */
  count: number;
  folder: boolean;
}

const chipKey = (d: AttachedDoc): string =>
  d.folder === null ? `file:${d.path}` : `dir:${d.folder}`;

/** PRD chips first, then design: one per source folder (with a file count) and one per loose file,
 *  in first-seen order. */
export function docChips(docs: AttachedDocs): DocChip[] {
  const chips: DocChip[] = [];
  for (const area of ["prd", "design"] as const) {
    const seen = new Map<string, DocChip>();
    for (const d of docs[area]) {
      const key = chipKey(d);
      const chip = seen.get(key);
      if (chip) {
        chip.count++;
        continue;
      }
      const folder = d.folder !== null;
      const next: DocChip = {
        area,
        key,
        name: folder ? d.folder! : d.path,
        target: folder ? `docs/${area}/` : `docs/${area}/${d.path}`,
        count: 1,
        folder,
      };
      seen.set(key, next);
      chips.push(next);
    }
  }
  return chips;
}

/** Drop exactly the files the chip stands for. */
export function removeDocChip(docs: AttachedDocs, chip: DocChip): AttachedDocs {
  return { ...docs, [chip.area]: docs[chip.area].filter((d) => chipKey(d) !== chip.key) };
}

/** True when the docs exceed the server's caps: > 500 files or > 50 MB total, across both areas. */
export function docsOverCap(docs: AttachedDocs): boolean {
  const all = [...docs.prd, ...docs.design];
  return all.length > MAX_FILES || all.reduce((n, d) => n + d.file.size, 0) > MAX_BYTES;
}
