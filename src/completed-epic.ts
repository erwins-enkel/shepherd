import type { EpicChild } from "./epic-core";
import type { ChecksState, ForgeKind, PrStatus } from "./forge/types";
import { checksCleared, repoHasNoCiCached } from "./checks-gate";

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
  // #1071: why the auto-rebase pass paused. null = not paused / rebase not yet attempted.
  // 'cap': cap exhausted; 'conflict': genuine conflict; 'driver': merge driver unavailable.
  landingRebasePauseReason: "cap" | "conflict" | "driver" | null;
  /** Live, non-persisted landing-PR gate signals (present only when the landing PR could be fetched). */
  landingChecks?: ChecksState;
  landingMergeable?: boolean | null;
  /** True when the landing PR is safe to merge from the app (gates the "Land epic" CTA). */
  landingReady?: boolean;
  /** True when an open+ready landing has sat unlanded past EPIC_LANDING_STRANDED_MS (Rec D escalation). */
  landingStranded?: boolean;
  /** Live, non-persisted: the landing PR's CI is terminally failing (not behind/conflicting). */
  landingCiFailing?: boolean;
}

/** Rec D threshold: surface the "stranded" escalation when an open+ready landing PR has sat
 *  unlanded this long after epic completion.
 *
 *  Documented deviation: the issue says "landing PR mergeable for > N hours"; we approximate with
 *  "epic completed > N h ago AND landing PR currently ready" to avoid persisting a `mergeableSince`
 *  column. A PR that becomes ready long after the epic completed would fire earlier than intended,
 *  but this is conservative (earlier escalation) and avoids a schema change. */
export const EPIC_LANDING_STRANDED_MS = 6 * 60 * 60_000;

/** Returns true when the landing PR is safe to merge from the app (gates the "Land epic" CTA).
 *
 *  Requires: open, checks passing, and mergeable=true. When mergeStateStatus is present (GitHub),
 *  it must be "clean" or "has_hooks" — all other statuses indicate a PR that is not ready:
 *  - "blocked": branch-protection rules are blocking the merge; the app-triggered merge would fail,
 *    so we must NOT show an enabled CTA that fires a doomed merge call.
 *  - "behind", "dirty", "unstable", "draft", "unknown": also not mergeable.
 *  When mergeStateStatus is undefined (Gitea), we fall back to state+checks+mergeable alone.
 *  `noCi` (GitHub repo with zero workflows) lets a terminal checks:"none" count as cleared — a
 *  no-CI repo's landing PR is still mergeable (mergeStateStatus stays the authoritative gate). */
export function computeLandingReady(
  pr: Pick<PrStatus, "state" | "checks" | "mergeable" | "mergeStateStatus">,
  noCi = false,
): boolean {
  if (pr.state !== "open") return false;
  if (!checksCleared(pr.checks, noCi)) return false;
  if (pr.mergeable !== true) return false;
  if (pr.mergeStateStatus === undefined) return true; // Gitea fallback
  return pr.mergeStateStatus === "clean" || pr.mergeStateStatus === "has_hooks";
}

/** Returns true when the landing PR is open, ready, and the epic completed over
 *  EPIC_LANDING_STRANDED_MS ago (the Rec D escalation threshold). */
export function computeLandingStranded(opts: {
  landingState: EpicLandingState;
  landingReady: boolean;
  completedAt: number;
  now: number;
}): boolean {
  return (
    opts.landingState === "open" &&
    opts.landingReady &&
    opts.now - opts.completedAt > EPIC_LANDING_STRANDED_MS
  );
}

/** Accessors enrichLandingEpics needs, injected so this module stays forge-light (a structural
 *  forge shape, not the full GitForge type). `resolveForge` returns null when the repo has no forge. */
export interface EnrichLandingDeps {
  getEpicIntegrationBranch: (repoPath: string, parentIssueNumber: number) => string | null;
  resolveForge: (
    repoPath: string,
  ) => { kind: ForgeKind; prStatus: (headBranch: string) => Promise<PrStatus> } | null | undefined;
  now: number;
}

/** Enrich each OPEN-landing completed epic in `rows` with live landing-PR gate signals
 *  (`landingChecks`/`landingMergeable`/`landingReady`/`landingStranded`/`landingCiFailing`), mutating in place.
 *  Best-effort + fail-safe per row: a missing branch/forge or a forge error simply leaves that
 *  row's live fields undefined — never throws. Shared by GET /api/epics/completed and the rundown's
 *  landing-ready accessor so both compute readiness identically. */
export async function enrichLandingEpics(
  rows: CompletedEpic[],
  deps: EnrichLandingDeps,
): Promise<void> {
  await Promise.all(
    rows.map(async (row) => {
      if (row.landingState !== "open") return;
      const branch = deps.getEpicIntegrationBranch(row.repoPath, row.parentIssueNumber);
      if (branch === null) return;
      const forge = deps.resolveForge(row.repoPath);
      if (!forge) return;
      try {
        const pr = await forge.prStatus(branch);
        row.landingChecks = pr.checks;
        row.landingMergeable = pr.mergeable ?? null;
        const landingReady = computeLandingReady(pr, repoHasNoCiCached(forge.kind, row.repoPath));
        row.landingReady = landingReady;
        row.landingStranded = computeLandingStranded({
          landingState: "open",
          landingReady,
          completedAt: row.completedAt,
          now: deps.now,
        });
        // A terminally-failing landing PR that is NOT behind/conflicting (those are owned by the
        // rebase pass's landingRebasePauseReason). Surfaced as a distinct Tier-1 item (index.ts).
        row.landingCiFailing =
          pr.checks === "failure" && pr.mergeStateStatus !== "behind" && pr.mergeable !== false;
      } catch {
        // leave live fields undefined — callers always serve/return the base DB rows
      }
    }),
  );
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
