/**
 * Migration-awareness detection (#645 learning #5).
 *
 * Epic child PRs often add DB migrations, but the harness never runs them (the critic is
 * read-only and has no DB). So a landed epic may carry unrun migrations with no signal. This
 * module is the PURE detection half: given the changed paths of the landing PR, it returns the
 * subset that look like migration files, so the band can ask the operator to acknowledge them
 * before clearing the row. NO I/O — the forge supplies the paths.
 *
 * Conservative + repo-agnostic on purpose: a tight glob set avoids false positives (a stray
 * "migrations" mention in a code path would be worse than a missed one — this is an advisory
 * nudge, not a gate that blocks completion).
 */

/**
 * Single source of truth for what counts as a migration path. Kept deliberately tight:
 * directory-scoped (`**\/migrations/**`, `**\/drizzle/**`, `**\/neo4j/**`, `**\/alembic/**`)
 * plus the Cypher file extension. Add a family here (and nowhere else) to widen detection.
 */
export const MIGRATION_GLOBS: readonly string[] = [
  "**/migrations/**",
  "**/drizzle/**",
  "**/*.cypher",
  "**/neo4j/**",
  "**/alembic/**",
];

/** Compile one glob to an anchored RegExp. Supports the only two wildcards we use:
 *  `**` (any chars incl. `/`) and `*` (any chars except `/`). Every other char is literal. */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` → zero or more leading path segments (the trailing `/` is optional, so a
        // root-level `drizzle/…` still matches `**/drizzle/**`); a bare `**` → any chars.
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*"; // `**` → any chars, including `/`
          i++;
        }
      } else {
        re += "[^/]*"; // `*` → any chars except `/`
      }
    } else if (".+?^${}()|[]\\".includes(c)) {
      re += "\\" + c; // escape regex metachars
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

const MIGRATION_MATCHERS: readonly RegExp[] = MIGRATION_GLOBS.map(globToRegExp);

/**
 * Return the subset of `paths` that match any {@link MIGRATION_GLOBS} pattern — deduped and
 * order-preserving (first occurrence wins). Pure; no I/O. Empty input → empty output.
 */
export function detectMigrationPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    if (seen.has(path)) continue;
    if (MIGRATION_MATCHERS.some((re) => re.test(path))) {
      seen.add(path);
      out.push(path);
    }
  }
  return out;
}
