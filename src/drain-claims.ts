import { ACTIVE_LABEL } from "./drain-core";
import { selectEpicCandidates, type EpicChild, type EpicStackContext } from "./epic-core";
import type { Issue, IssuePullRequestReference } from "./forge/types";

export interface ClaimDiagnostic {
  number: number;
  title: string;
  url: string;
  /** ACTIVE_LABEL carries no instance identity, so local absence cannot prove ownership. */
  ownership: "unknown";
  evidence: "complete" | "unknown";
  mergedPrs: IssuePullRequestReference[];
}

export function classifyClaim(
  issue: Issue,
  live: boolean,
  references: IssuePullRequestReference[] | null,
): ClaimDiagnostic | null {
  if (!issue.labels.includes(ACTIVE_LABEL) || live || references?.some((p) => p.state === "open"))
    return null;
  return {
    number: issue.number,
    title: issue.title,
    url: issue.url,
    ownership: "unknown",
    evidence: references === null ? "unknown" : "complete",
    mergedPrs: references?.filter((p) => p.state === "merged") ?? [],
  };
}

/** #4025: the running epic's children held back ONLY by an orphaned claim — each would be a spawn
 *  candidate unclaimed (open, not integrated, no session, deps met), is not mapped (local session,
 *  remote dispatch), and its claim was diagnosed orphaned on complete evidence. Epic order. */
export function epicClaimBlockers(
  children: EpicChild[],
  stack: EpicStackContext | undefined,
  claims: ClaimDiagnostic[],
  mapped: ReadonlySet<number>,
): number[] {
  const claimed = new Set(children.filter((c) => c.claimed).map((c) => c.number));
  const orphaned = new Set(claims.filter((c) => c.evidence === "complete").map((c) => c.number));
  return selectEpicCandidates(
    children.map((c) => ({ ...c, claimed: false })),
    stack,
  )
    .map((c) => c.number)
    .filter((n) => claimed.has(n) && !mapped.has(n) && orphaned.has(n));
}

export type ClaimAction = "claim" | "release" | "retain";

/** #4025: one line per claim stamp/release/retain, so an orphaned `shepherd:active` can be traced
 *  back to the path (and session) that left it. */
export function logClaim(
  action: ClaimAction,
  repoPath: string,
  number: number,
  ctx: { via: string; desig?: string | null; reason?: string },
): void {
  const reason = ctx.reason ? ` reason=${ctx.reason}` : "";
  console.warn(
    `[claim] ${action} ${repoPath}#${number} via=${ctx.via} desig=${ctx.desig || "-"}${reason}`,
  );
}
