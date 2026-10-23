import { ACTIVE_LABEL } from "./drain-core";
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
