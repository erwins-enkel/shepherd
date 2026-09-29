/**
 * Which herdr socket names does Shepherd's own code reference? Feeds the consumer-aware half of
 * the S2 schema diff (schema-diff.ts `isConsumed`): a removed method or result variant that
 * Shepherd references must stop the bump, one it never touches is triage work, not a blocker.
 *
 * "Referenced" = the exact name appears as a double- or single-quoted literal — the form every
 * call site takes (`request("pane.report_agent", …)`, `r.type === "tab_list"`). Deliberately
 * conservative: a quoted mention in a comment counts too. The vendored `src/generated/` is
 * excluded (it lists every method herdr has, used or not); a name built at runtime is invisible
 * here, but the socket client's `request()` is typed against the regenerated `HerdrMethod` union,
 * so calling a removed method still fails typecheck.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SourceFile {
  /** Repo-relative, `/`-separated. */
  path: string;
  text: string;
}

/** The directories whose `.ts` files count as Shepherd consuming herdr. */
const SCANNED_DIRS = ["src", "scripts", "deploy"] as const;
const EXCLUDED_PREFIX = "src/generated/";

/** Every `.ts` file under {@link SCANNED_DIRS}, minus the vendored protocol. */
export function shepherdSources(repoRoot: string): SourceFile[] {
  const out: SourceFile[] = [];
  for (const dir of SCANNED_DIRS) {
    for (const entry of readdirSync(join(repoRoot, dir), { recursive: true, encoding: "utf8" })) {
      const path = `${dir}/${entry.split("\\").join("/")}`;
      if (!path.endsWith(".ts") || path.startsWith(EXCLUDED_PREFIX)) continue;
      out.push({ path, text: readFileSync(join(repoRoot, path), "utf8") });
    }
  }
  return out;
}

/** True when `name` appears as a `"…"` or `'…'` literal in any of `sources`. */
export function referencedIn(name: string, sources: readonly SourceFile[]): boolean {
  const quoted = [`"${name}"`, `'${name}'`];
  return sources.some((s) => quoted.some((q) => s.text.includes(q)));
}
