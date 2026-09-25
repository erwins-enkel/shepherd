// Pre-fetch filing rules for one Sentry issue (#2464). Pure — the poller supplies state reads.
// The in-app-frame rule needs the event and runs later (see `frames.ts`).

import type { SentryIssue } from "./api";
import type { FiledRecord, Mapping } from "./state";

/** Auto-fix attempts (filings) per Sentry issue. */
const MAX_ATTEMPTS = 2;
/** Issues filed per repo per UTC day. */
export const DAILY_CAP = 3;

const SUBSTATUSES = new Set(["new", "escalating", "regressed"]);

export type SkipReason = "unmapped" | "substatus" | "assigned" | "filed" | "attempts" | "cap";

export type RuleVerdict =
  | {
      ok: true;
      repo: string;
      /** Re-triage marker for a regression (see `TriageCandidate.regressionKey`). */
      regressionKey: string | null;
      /** A re-filing: the poller must confirm the previous GitHub issue is closed first. */
      refile: boolean;
    }
  | { ok: false; reason: SkipReason };

export interface RuleContext {
  /** Sentry project slug → repo path, confirmed mappings only. */
  repoForProject: Map<string, string>;
  filed: FiledRecord | null;
  filedToday: (repo: string) => number;
}

/** Project slug → repo path. Two repos mapped to one project: the first (by path) wins. */
export function projectIndex(
  mappings: Record<string, Mapping>,
  usable: (repo: string) => boolean,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const repo of Object.keys(mappings).sort()) {
    const m = mappings[repo]!;
    if (usable(repo) && !out.has(m.project)) out.set(m.project, repo);
  }
  return out;
}

export function evaluateIssue(issue: SentryIssue, ctx: RuleContext): RuleVerdict {
  const repo = ctx.repoForProject.get(issue.projectSlug);
  if (!repo) return { ok: false, reason: "unmapped" };
  if (!issue.substatus || !SUBSTATUSES.has(issue.substatus))
    return { ok: false, reason: "substatus" };
  if (issue.assignee === "user") return { ok: false, reason: "assigned" };
  const regressed = issue.substatus === "regressed";
  const f = ctx.filed;
  if (f && !regressed) return { ok: false, reason: "filed" };
  if (f && f.attempts >= MAX_ATTEMPTS) return { ok: false, reason: "attempts" };
  if (ctx.filedToday(repo) >= DAILY_CAP) return { ok: false, reason: "cap" };
  return {
    ok: true,
    repo,
    regressionKey: regressed ? `r${f?.attempts ?? 0}` : null,
    refile: !!f,
  };
}
