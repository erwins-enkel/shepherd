/**
 * Readiness greenfield profile (#3107, epic #3114) — pure core. Scores a repo's bootstrap
 * progress as a checklist of must-haves (the bootstrap exit predicate) and nice-to-haves, from
 * an ecosystem scan plus forge facts. Works with or without a manifest: an empty repo is the
 * start of the bar, not "unsupported". I/O lives in `greenfield.ts`; this file only decides.
 */
import type { ForgeRun } from "./forge/types";
import type { EcosystemScan, Ecosystem, GuardrailId } from "./readiness";
import type { ForgeReadiness } from "./readiness-forge-core";

/** The bootstrap exit's must-haves (epic #3114): every one green, or the drain stays held. */
export const GREENFIELD_MUST = [
  "stack_pinned",
  "scaffold_builds",
  "ci_on_main",
  "hooks_pre_push",
  "dead_code_audit",
  "forge_settings",
] as const;
/** Nice-to-haves: scored, never blocking. */
type GreenfieldNiceId =
  | "prd"
  | "design_export"
  | "foundation_decisions"
  | "issue_templates"
  | "env_schema"
  | "dependency_automation";

export type GreenfieldItemId = (typeof GREENFIELD_MUST)[number] | GreenfieldNiceId;
export type GreenfieldTier = "must" | "nice";

export interface GreenfieldItem {
  id: GreenfieldItemId;
  tier: GreenfieldTier;
  present: boolean;
  /** Matched markers (files, runs, settings) — verbatim data, not translated. */
  evidence: string[];
}

export interface GreenfieldReport {
  /** Ecosystem of the scaffold once one exists; null while the repo has no manifest. */
  ecosystem: Ecosystem | null;
  /** Weighted 0–100 (must-have 3, nice-to-have 1), derived from `items`. */
  score: number;
  items: GreenfieldItem[];
  /** The red must-haves — what the bootstrap gate still waits for (phases come from the store). */
  mustHavesMissing: GreenfieldItemId[];
  /** Epoch ms of the scan. */
  checkedAt: number;
}

export interface GreenfieldInputs {
  scan: EcosystemScan;
  /** Where the agent instructions carry the `## Pinned stack` section (house-stack.ts contract). */
  pinnedStackDoc: string[];
  /** Non-empty input/decision docs found (`docs/prd`, `docs/design`, `docs/decisions`). */
  docs: { prd: string[]; design: string[]; decisions: string[] };
  /** Forge settings checks (#3106); "error" when the read failed. `supported:false` omits the item. */
  forge: ForgeReadiness | "error";
  /** Default-branch CI runs; null when the forge can't list them (files alone then decide). */
  runs: ForgeRun[] | null;
  now: number;
}

const WEIGHT: Record<GreenfieldTier, number> = { must: 3, nice: 1 };

const item = (
  id: GreenfieldItemId,
  tier: GreenfieldTier,
  evidence: string[],
  present = evidence.length > 0,
): GreenfieldItem => ({ id, tier, present, evidence: present ? evidence : [] });

function check(scan: EcosystemScan, id: GuardrailId) {
  return scan.checks.find((c) => c.id === id);
}

/** Newest finished default-branch run, or null. */
function latestCompleted(runs: ForgeRun[]): ForgeRun | null {
  let best: ForgeRun | null = null;
  for (const r of runs)
    if (r.status === "completed" && (!best || r.createdAt > best.createdAt)) best = r;
  return best;
}

function stackPinned(i: GreenfieldInputs): GreenfieldItem {
  const ok = i.scan.ecosystem != null && i.pinnedStackDoc.length > 0;
  const pins = i.scan.toolchainPins;
  return item("stack_pinned", "must", [...i.pinnedStackDoc, ...pins], ok && pins.length > 0);
}

function scaffoldBuilds(i: GreenfieldInputs): GreenfieldItem {
  const eco = i.scan.ecosystem;
  if (eco == null) return item("scaffold_builds", "must", []);
  if (i.runs == null) return item("scaffold_builds", "must", [`${eco} manifest`, "unverified"]);
  const last = latestCompleted(i.runs);
  const ok = last?.conclusion === "success";
  return item("scaffold_builds", "must", [`${eco} manifest`, `${last?.workflowName} ✓`], ok);
}

function ciOnMain(i: GreenfieldInputs): GreenfieldItem {
  const ci = check(i.scan, "ci");
  const runsOk = i.runs == null || i.runs.length > 0;
  const runEv = i.runs?.length ? [`${i.runs.length} run(s) on default branch`] : [];
  return item("ci_on_main", "must", [...(ci?.evidence ?? []), ...runEv], !!ci?.present && runsOk);
}

function hooksPrePush(i: GreenfieldInputs): GreenfieldItem {
  const hooks = check(i.scan, "git_hooks");
  const prePush = check(i.scan, "pre_push_ci");
  const ev = [...new Set([...(hooks?.evidence ?? []), ...(prePush?.evidence ?? [])])];
  return item("hooks_pre_push", "must", ev, !!hooks?.present && !!prePush?.present);
}

/** The forge-settings item, or null when the forge has no settings API (local repo, fork). */
function forgeSettings(i: GreenfieldInputs): GreenfieldItem | null {
  if (i.forge === "error") return item("forge_settings", "must", []);
  if (!i.forge.supported) return null;
  const ok = i.forge.checks.every((c) => c.state === "ok");
  return item("forge_settings", "must", [`${i.forge.checks.length} forge checks ok`], ok);
}

/** A scan-derived guardrail as a greenfield item; null when the check doesn't apply. */
function fromCheck(i: GreenfieldInputs, id: GreenfieldItemId & GuardrailId, tier: GreenfieldTier) {
  const c = check(i.scan, id);
  return c ? item(id, tier, c.evidence, c.present) : null;
}

export function buildGreenfieldReport(i: GreenfieldInputs): GreenfieldReport {
  const items = [
    stackPinned(i),
    scaffoldBuilds(i),
    ciOnMain(i),
    hooksPrePush(i),
    fromCheck(i, "dead_code_audit", "must") ?? item("dead_code_audit", "must", []),
    forgeSettings(i),
    item("prd", "nice", i.docs.prd),
    item("design_export", "nice", i.docs.design),
    item("foundation_decisions", "nice", i.docs.decisions),
    fromCheck(i, "issue_templates", "nice"),
    fromCheck(i, "env_schema", "nice"),
    fromCheck(i, "dependency_automation", "nice"),
  ].filter((x): x is GreenfieldItem => x != null);

  const total = items.reduce((s, x) => s + WEIGHT[x.tier], 0);
  const got = items.reduce((s, x) => s + (x.present ? WEIGHT[x.tier] : 0), 0);
  return {
    ecosystem: i.scan.ecosystem,
    score: total === 0 ? 0 : Math.round((100 * got) / total),
    items,
    mustHavesMissing: items.filter((x) => x.tier === "must" && !x.present).map((x) => x.id),
    checkedAt: i.now,
  };
}
