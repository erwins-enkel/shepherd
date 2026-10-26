/**
 * Readiness "Forge settings" checks (#3106) — pure core. Compares a repo's host settings
 * (merge methods, auto-merge, branch cleanup, required checks, drain label) with what Shepherd
 * expects and says, per check, whether a one-click Apply can fix it. I/O lives in
 * `readiness-forge.ts`; this file only decides.
 */
import type { MergeMethod, RepoForgeSettings } from "./forge/types";

const FORGE_CHECK_IDS = [
  "merge_methods",
  "auto_merge",
  "delete_branch_on_merge",
  "required_checks",
  "auto_label",
] as const;
export type ForgeCheckId = (typeof FORGE_CHECK_IDS)[number];

/** ok = matches; fix = Apply offered; hint = mismatch without Apply; unknown = host withheld it. */
export type ForgeCheckState = "ok" | "fix" | "hint" | "unknown";
/** Why a mismatch is only a hint. `plan`: the repo's plan lacks the feature (private repo on
 *  GitHub Free). */
export type ForgeCheckReason = "no_admin" | "no_push" | "no_ci" | "plan";

export interface ForgeCheck {
  id: ForgeCheckId;
  state: ForgeCheckState;
  /** Current value: enabled merge methods, a boolean, or the required check contexts. */
  current: MergeMethod[] | boolean | string[] | null;
  /** Target value, same shape as `current`. */
  target: MergeMethod[] | boolean | string[];
  reason?: ForgeCheckReason;
}

export type ForgeReadiness =
  | { supported: false }
  | { supported: true; defaultBranch: string; autoLabel: string; checks: ForgeCheck[] };

export function isForgeCheckId(v: unknown): v is ForgeCheckId {
  return typeof v === "string" && (FORGE_CHECK_IDS as readonly string[]).includes(v);
}

const PR_EVENTS = new Set(["pull_request", "pull_request_target"]);

/** Path filters make a PR workflow skip some PRs; a check it reports would then stay Pending
 *  forever on those PRs once required. */
const PATH_FILTERS = ["paths", "paths-ignore"];

/** GitHub branch-filter glob → RegExp: `**` any, `*` any but `/`, `?` one char. */
function globRe(pattern: string): RegExp {
  const re = pattern
    .split(/(\*\*|\*|\?)/)
    .map((t) =>
      t === "**"
        ? ".*"
        : t === "*"
          ? "[^/]*"
          : t === "?"
            ? "."
            : t.replace(/[.+^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${re}$`);
}

/** Whether a `branches` list (later `!pattern` entries negate) matches `branch`. */
function branchListMatches(list: unknown, branch: string): boolean {
  const items = Array.isArray(list) ? list : [list];
  let hit = false;
  for (const p of items) {
    if (typeof p !== "string") continue;
    const neg = p.startsWith("!");
    if (globRe(neg ? p.slice(1) : p).test(branch)) hit = !neg;
  }
  return hit;
}

/** True when a PR-event config (`pull_request:` value) runs on every PR into `branch`: no path
 *  filter, a branch filter that admits `branch`, and `types` (if set) covering both `opened`
 *  and `synchronize`. The ruleset only gates PRs into the default branch, so that's the base
 *  the filter is matched against. */
function runsOnEveryPr(cfg: unknown, branch: string): boolean {
  if (cfg === null || cfg === undefined) return true;
  if (typeof cfg !== "object" || Array.isArray(cfg)) return false;
  const c = cfg as Record<string, unknown>;
  if (PATH_FILTERS.some((k) => k in c)) return false;
  if ("branches" in c && !branchListMatches(c.branches, branch)) return false;
  if ("branches-ignore" in c && branchListMatches(c["branches-ignore"], branch)) return false;
  if (c.types === undefined) return true;
  const types = Array.isArray(c.types) ? c.types : [c.types];
  return types.includes("opened") && types.includes("synchronize");
}

/** True when a workflow's `on:` (string / list / map) runs on every pull request into `branch`. */
function triggersOnEveryPr(on: unknown, branch: string): boolean {
  if (typeof on === "string") return PR_EVENTS.has(on);
  if (Array.isArray(on)) return on.some((e) => typeof e === "string" && PR_EVENTS.has(e));
  if (on && typeof on === "object")
    return Object.entries(on).some(([e, cfg]) => PR_EVENTS.has(e) && runsOnEveryPr(cfg, branch));
  return false;
}

/** The status-check context a job reports, or null when it can't be predicted: matrix jobs
 *  (one context per cell), templated names, and reusable-workflow calls (`caller / callee`). */
function jobContext(id: string, job: unknown): string | null {
  if (!job || typeof job !== "object") return null;
  const j = job as { name?: unknown; strategy?: { matrix?: unknown }; uses?: unknown };
  if (j.strategy?.matrix !== undefined || j.uses !== undefined) return null;
  const name = j.name === undefined ? id : j.name;
  if (typeof name !== "string" || !name.trim() || name.includes("${{")) return null;
  return name;
}

/** Required-check contexts derived from the repo's workflow files: every predictable job of a
 *  workflow that runs on every pull request into `defaultBranch` (path-filtered, branch-excluded
 *  or type-restricted PR triggers are skipped). Deduped, sorted; unparseable files are skipped. */
export function deriveRequiredChecks(workflowTexts: string[], defaultBranch: string): string[] {
  const out = new Set<string>();
  for (const text of workflowTexts) {
    let doc: unknown;
    try {
      doc = Bun.YAML.parse(text);
    } catch {
      continue;
    }
    if (!doc || typeof doc !== "object") continue;
    const wf = doc as { on?: unknown; jobs?: unknown };
    if (!triggersOnEveryPr(wf.on, defaultBranch) || !wf.jobs || typeof wf.jobs !== "object")
      continue;
    for (const [id, job] of Object.entries(wf.jobs)) {
      const ctx = jobContext(id, job);
      if (ctx) out.add(ctx);
    }
  }
  return [...out].sort();
}

const METHODS: MergeMethod[] = ["merge", "squash", "rebase"];

function adminCheck(id: ForgeCheckId, current: boolean | null, canAdminister: boolean): ForgeCheck {
  if (current === null) return { id, state: "unknown", current, target: true };
  if (current) return { id, state: "ok", current, target: true };
  return canAdminister
    ? { id, state: "fix", current, target: true }
    : { id, state: "hint", current, target: true, reason: "no_admin" };
}

/** GitHub Free keeps auto-merge off on private repos (a PATCH is accepted but ignored). */
function autoMergeCheck(s: RepoForgeSettings): ForgeCheck {
  if (s.planLimited && s.autoMergeAllowed === false)
    return { id: "auto_merge", state: "hint", current: false, target: true, reason: "plan" };
  return adminCheck("auto_merge", s.autoMergeAllowed, s.canAdminister);
}

function mergeMethodsCheck(s: RepoForgeSettings, mergeMethod: MergeMethod): ForgeCheck {
  const target = [mergeMethod];
  if (!s.mergeMethods) return { id: "merge_methods", state: "unknown", current: null, target };
  const current = METHODS.filter((m) => s.mergeMethods![m]);
  if (current.length === 1 && current[0] === mergeMethod)
    return { id: "merge_methods", state: "ok", current, target };
  return s.canAdminister
    ? { id: "merge_methods", state: "fix", current, target }
    : { id: "merge_methods", state: "hint", current, target, reason: "no_admin" };
}

function requiredChecksCheck(s: RepoForgeSettings, derived: string[]): ForgeCheck {
  if (s.planLimited)
    return { id: "required_checks", state: "hint", current: [], target: derived, reason: "plan" };
  const current = s.requiredChecks;
  if (current === null)
    return { id: "required_checks", state: "unknown", current, target: derived };
  if (current.length) return { id: "required_checks", state: "ok", current, target: current };
  if (!derived.length)
    return { id: "required_checks", state: "hint", current, target: derived, reason: "no_ci" };
  return s.canAdminister
    ? { id: "required_checks", state: "fix", current, target: derived }
    : { id: "required_checks", state: "hint", current, target: derived, reason: "no_admin" };
}

function labelCheck(s: RepoForgeSettings): ForgeCheck {
  if (s.labelExists) return { id: "auto_label", state: "ok", current: true, target: true };
  return s.canPush
    ? { id: "auto_label", state: "fix", current: false, target: true }
    : { id: "auto_label", state: "hint", current: false, target: true, reason: "no_push" };
}

/** Every Forge-settings check, in display order. */
export function forgeChecks(
  s: RepoForgeSettings,
  o: { mergeMethod: MergeMethod; derivedChecks: string[] },
): ForgeCheck[] {
  return [
    mergeMethodsCheck(s, o.mergeMethod),
    autoMergeCheck(s),
    adminCheck("delete_branch_on_merge", s.deleteBranchOnMerge, s.canAdminister),
    requiredChecksCheck(s, o.derivedChecks),
    labelCheck(s),
  ];
}
