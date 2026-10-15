/**
 * PRD + design import for a new project (#3112): the "Bootstrap from PRD + design" kickoff sends
 * the operator's files with the create, and they land in `docs/prd/` and `docs/design/` of the
 * initial commit — where the bootstrap directives (src/bootstrap-directive.ts) look for them.
 *
 * The browser-supplied relative paths are untrusted: every one is re-validated segment by segment
 * and only ever joined under its area's directory. Bounded in count and total size.
 */

export type ProjectDocArea = "prd" | "design";

export interface ProjectDoc {
  area: ProjectDocArea;
  /** POSIX path relative to `docs/<area>/`, validated by {@link safeDocPath}. */
  relPath: string;
  data: Uint8Array;
}

export const PROJECT_DOCS_MAX_FILES = 500;
const PROJECT_DOCS_MAX_BYTES = 50 * 1024 * 1024;

const AREAS: readonly ProjectDocArea[] = ["prd", "design"];

/** A safe relative POSIX path, or null: no absolute/backslash/NUL/control chars, no empty, `.`,
 *  `..` or `.git` segment, at most 16 segments of ≤255 chars. */
export function safeDocPath(raw: string): string | null {
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (!raw || raw.length > 1024 || /[\\\u0000-\u001f]/.test(raw) || raw.startsWith("/"))
    return null;
  const segs = raw.split("/");
  if (segs.length > 16) return null;
  for (const s of segs)
    if (!s || s === "." || s === ".." || s.toLowerCase() === ".git" || s.length > 255) return null;
  return segs.join("/");
}

/**
 * Read the `prd` / `design` file entries of a create form. The file NAME carries the relative path
 * (FormData's third argument). Returns the docs, or an error code: `newproject_failed_docs` (a bad
 * path) / `newproject_failed_docs_size` (over the caps).
 */
export async function parseProjectDocs(
  form: FormData,
): Promise<{ ok: true; docs: ProjectDoc[] } | { ok: false; error: string }> {
  const docs: ProjectDoc[] = [];
  let total = 0;
  for (const area of AREAS) {
    for (const entry of form.getAll(area)) {
      if (!(entry instanceof File)) return { ok: false, error: "newproject_failed_docs" };
      const relPath = safeDocPath(entry.name);
      if (!relPath) return { ok: false, error: "newproject_failed_docs" };
      total += entry.size;
      if (docs.length >= PROJECT_DOCS_MAX_FILES || total > PROJECT_DOCS_MAX_BYTES)
        return { ok: false, error: "newproject_failed_docs_size" };
      docs.push({ area, relPath, data: new Uint8Array(await entry.arrayBuffer()) });
    }
  }
  return { ok: true, docs };
}
