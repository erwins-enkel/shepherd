import type { ProjectDocFiles } from "#lib/api.js";

/** A picked file's path under `docs/<area>/` (#3112): a folder pick drops its top folder (the
 *  export's own name), a file pick keeps the bare name. Hidden files (`.DS_Store`, `.git/…`) are
 *  skipped — null. The server re-validates every path. */
export function docPath(file: File): string | null {
  const rel = file.webkitRelativePath || "";
  const segs = rel ? rel.split("/").slice(1) : [file.name];
  if (segs.length === 0 || segs.some((s) => !s || s.startsWith("."))) return null;
  return segs.join("/");
}

/** The importable files of a picker, each with its path. */
export function toDocs(files: FileList | File[] | null): ProjectDocFiles["prd"] {
  const out: ProjectDocFiles["prd"] = [];
  for (const file of files ?? []) {
    const path = docPath(file);
    if (path) out.push({ file, path });
  }
  return out;
}
