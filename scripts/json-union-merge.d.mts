// Types for the node-run merge driver (scripts/json-union-merge.mjs). The driver
// stays plain .mjs so git can invoke it via node in any context; this declaration
// only exists so the TypeScript test (test/json-union-merge.test.ts) can import it.

export interface CatalogMergeResult {
  /** Union of both sides, ours' key order preserved, theirs-only keys appended. */
  merged: Record<string, string>;
  /** Keys both sides changed differently (or one edited while the other deleted). */
  conflicts: string[];
}

/** Three-way union of two flat string→string i18n catalogs. */
export function mergeCatalogs(
  base: Record<string, string>,
  ours: Record<string, string>,
  theirs: Record<string, string>,
): CatalogMergeResult;
