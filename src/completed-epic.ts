import type { EpicChild } from "./epic-core";

export interface CompletedEpicChild {
  number: number;
  title: string;
  url: string;
  prNumber: number | null;
  prUrl: string | null;
  mergedAt: number | null;
  integrated: boolean;
}

/** Landing-PR lifecycle state — pending=not yet resolved, open=PR opened/reused,
 *  merged=landing PR has merged (epic landed; band about to be dismissed on parent close),
 *  none=nothing to land / human-closed, error=last open attempt failed/retrying. */
export type EpicLandingState = "pending" | "open" | "merged" | "none" | "error";

export interface CompletedEpic {
  repoPath: string;
  parentIssueNumber: number;
  parentTitle: string;
  completedAt: number;
  children: CompletedEpicChild[];
  // Stage B (#635) landing-PR carried on the band; null/'pending' until the aggregate PR opens.
  landingPrNumber: number | null;
  landingPrUrl: string | null;
  landingState: EpicLandingState;
  // Migration-awareness checkpoint (#645): migration file paths detected in the landing PR
  // (empty when none / detection unavailable) + the epoch the operator acknowledged them (null
  // until acknowledged). A non-empty `migrationPaths` with a null `migrationsAckedAt` gates the
  // band row's clear behind an explicit acknowledgement — NEVER the autonomous completion flip.
  migrationPaths: string[];
  migrationsAckedAt: number | null;
}

export function buildRollup(
  children: Pick<EpicChild, "number" | "title" | "url">[],
  details: {
    childNumber: number;
    prNumber: number | null;
    prUrl: string | null;
    mergedAt: number;
  }[],
): CompletedEpicChild[] {
  const detailMap = new Map(details.map((d) => [d.childNumber, d]));
  return children.map((child) => {
    const detail = detailMap.get(child.number);
    if (detail) {
      return {
        number: child.number,
        title: child.title,
        url: child.url,
        prNumber: detail.prNumber,
        prUrl: detail.prUrl,
        mergedAt: detail.mergedAt,
        integrated: true,
      };
    }
    return {
      number: child.number,
      title: child.title,
      url: child.url,
      prNumber: null,
      prUrl: null,
      mergedAt: null,
      integrated: false,
    };
  });
}
