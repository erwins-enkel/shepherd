// Path collapsing for the Diff-tab file rail (DiffFileSidebar). Splits a
// repo-relative path into a collapsed directory label + the full filename, so
// the sidebar can render the filename in a non-shrinking span (never truncated)
// beside a muted, ellipsis-able directory prefix. Purely structural — no width
// or character-count heuristics.

export type PathPart = { dir: string; name: string };

/**
 * Split a repo-relative path into a collapsed directory label + full filename.
 * Keeps the top-level dir + the file's immediate parent (`root/…/parent/`) when
 * there are more than two directory segments; shows the full directory prefix
 * otherwise; empty dir for a top-level file. The filename is always whole.
 */
export function collapsePath(p: string): PathPart {
  const segs = p.split("/");
  const name = segs.pop() ?? p; // filename — always kept whole
  if (segs.length === 0) return { dir: "", name };
  if (segs.length <= 2) return { dir: segs.join("/") + "/", name };
  return { dir: `${segs[0]}/…/${segs[segs.length - 1]}/`, name };
}

/** One part normally; two (old → new) for a rename, each collapsed independently. */
export function pathParts(file: { path: string; oldPath?: string; status: string }): PathPart[] {
  return file.status === "renamed" && file.oldPath
    ? [collapsePath(file.oldPath), collapsePath(file.path)]
    : [collapsePath(file.path)];
}
