import type { Learning } from "../types";

/** Last non-empty path segment (repo display name). */
export function basename(p: string): string {
  return p.split("/").filter(Boolean).at(-1) ?? p;
}

/** Group learnings by repoPath, preserving first-seen order. */
export function groupByRepo(items: Learning[]): [string, Learning[]][] {
  const map = new Map<string, Learning[]>();
  for (const l of items) {
    const g = map.get(l.repoPath);
    if (g) g.push(l);
    else map.set(l.repoPath, [l]);
  }
  return [...map.entries()];
}
