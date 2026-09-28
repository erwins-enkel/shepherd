// Deterministic ci-watch rules (#2540). Pure — the poller supplies state reads.

import type { PluginRun } from "../../types";
import type { KeyRecord, RepoConfig } from "./state";

/** Candidates filed per repo per UTC day (separate from Sentry's cap). */
export const DAILY_CAP = 3;

/** Default-branch events in scope; PR runs belong to autopilot + critic. */
const EVENTS = new Set(["schedule", "push", "workflow_dispatch"]);
/** Run conclusions that say nothing about the code. */
const DROPPED = new Set(["cancelled", "startup_failure"]);
const RED = new Set(["failure", "timed_out"]);
/** Pseudo-job for a failed run that lists no failed job. */
export const RUN_JOB = "(run)";

export type RunSkip = "event" | "cancelled" | "startup_failure";

/** Why a whole run is ignored, or null when its jobs count. */
export function runSkip(run: Pick<PluginRun, "event" | "conclusion">): RunSkip | null {
  if (!EVENTS.has(run.event)) return "event";
  if (run.conclusion && DROPPED.has(run.conclusion)) return run.conclusion as RunSkip;
  return null;
}

/** Matrix jobs share a base name: `test (ubuntu, 20)` → `test`. */
export function collapseMatrix(name: string): string {
  return name.replace(/\s*\([^()]*\)\s*$/, "").trim() || name.trim();
}

/** Job observations of one run, matrix-collapsed: a base job is red if any leg is red. Jobs
 *  that are neither red nor `success` (skipped, cancelled, unfinished) are not observations. */
export function observe(
  run: Pick<PluginRun, "conclusion" | "jobs">,
): Map<string, "failure" | "success"> {
  const out = new Map<string, "failure" | "success">();
  for (const j of run.jobs) {
    const base = collapseMatrix(j.name);
    if (j.conclusion && RED.has(j.conclusion)) out.set(base, "failure");
    else if (j.conclusion === "success" && !out.has(base)) out.set(base, "success");
  }
  if (run.conclusion && RED.has(run.conclusion) && ![...out.values()].includes("failure"))
    out.set(RUN_JOB, "failure");
  return out;
}

/** Anchored, case-insensitive glob with `*` and `?`. */
export function globMatch(glob: string, s: string): boolean {
  const re = glob
    .split("")
    .map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${re}$`, "i").test(s);
}

/** First override matching the workflow name, else the repo threshold. */
export function thresholdFor(cfg: RepoConfig, workflowName: string): number {
  return cfg.overrides.find((o) => globMatch(o.glob, workflowName))?.threshold ?? cfg.threshold;
}

export type KeySkip = "fixed" | "filed" | "threshold" | "cap";

/** Decide one key that went red in this batch; null = forward it. */
export function evaluateKey(
  rec: KeyRecord,
  c: { threshold: number; filedToday: number },
): KeySkip | null {
  if (rec.lastConclusion === "success") return "fixed";
  if (rec.filed?.sync === "open") return "filed";
  if (rec.streak < c.threshold) return "threshold";
  if (c.filedToday >= DAILY_CAP) return "cap";
  return null;
}
