/**
 * #3221: which workflow files actually check a PR head. The no-CI gate (checks-gate.ts) used to
 * count every file under `.github/workflows`, so a repo whose only workflow runs on `schedule` /
 * `workflow_dispatch` read as "has CI" and its PRs' permanent `checks:"none"` waited forever.
 *
 * Biased toward "checks PRs": an unreadable or unparseable file, or a `push` filter we can't rule
 * out, counts — a false "has CI" only keeps waiting (the stale-checks fallback surfaces it),
 * while a false "no CI" would treat an unchecked PR as cleared.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Events whose runs report checks on the PR head. */
const PR_EVENTS = new Set(["pull_request", "pull_request_target", "merge_group"]);

/** A `push` trigger fires on a PR's head branch unless it is tag-only or its `branches` list is
 *  nothing but literal names (e.g. `[main]`), which a feature branch can't match. */
function pushChecksPrs(cfg: unknown): boolean {
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return true;
  const c = cfg as Record<string, unknown>;
  const branchKeyed = "branches" in c || "branches-ignore" in c;
  if (!branchKeyed) return !("tags" in c || "tags-ignore" in c);
  if (!("branches" in c)) return true;
  const list = Array.isArray(c.branches) ? c.branches : [c.branches];
  return list.some((p) => typeof p !== "string" || /[*?[!+]/.test(p));
}

function eventChecksPrs(event: unknown, cfg?: unknown): boolean {
  if (typeof event !== "string") return false;
  if (PR_EVENTS.has(event)) return true;
  return event === "push" && pushChecksPrs(cfg);
}

/** Whether a workflow file's `on:` (string / list / map) runs on a PR head. */
export function workflowChecksPrs(yamlText: string): boolean {
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(yamlText);
  } catch {
    return true;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return true;
  const d = doc as Record<string, unknown>;
  // YAML 1.1 parsers read a bare `on` key as boolean true.
  const on = "on" in d ? d.on : d.true;
  if (on === undefined || on === null) return true;
  if (typeof on === "string") return eventChecksPrs(on);
  if (Array.isArray(on)) return on.some((e) => eventChecksPrs(e));
  if (typeof on === "object") return Object.entries(on).some(([e, cfg]) => eventChecksPrs(e, cfg));
  return true;
}

/** Number of workflow files under `.github/workflows` that run on a PR head (same file filter
 *  as `countDefinedWorkflows`). Missing dir → 0; an unreadable file counts. */
export function countPrCiWorkflows(repoDir: string): number {
  const dir = join(repoDir, ".github", "workflows");
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.ya?ml$/i.test(e.name))
      .map((e) => e.name);
  } catch {
    return 0;
  }
  return names.filter((n) => {
    try {
      return workflowChecksPrs(readFileSync(join(dir, n), "utf8"));
    } catch {
      return true;
    }
  }).length;
}
