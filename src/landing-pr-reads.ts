import { repoHasNoCiCached } from "./checks-gate";
import type { GitForge, PrStatus } from "./forge/types";
import type { OpenPrSnapshotService } from "./open-pr-snapshot";

/**
 * Landing-PR reads for the drain's landing passes (#2873). The rebase, CI re-run, auto-land and
 * pre-warm passes each need an epic landing PR's live state every 30 s tick. Read one by one,
 * that is a `gh pr list --head` (1 GraphQL point) per pass per tick, even for a PR that waits
 * hours for an approval.
 *
 *  - One read per branch per tick: the passes of a tick share one result, a failed read included.
 *  - A settled open PR ({@link landingPrSettled}) changes only through a review, a push, a merge or
 *    a close, and each of those moves the repo's PR fingerprint. While that key holds, the last read
 *    is reused, re-checked every {@link LANDING_PR_RECHECK_MS} for what the fingerprint can't see
 *    (a CI re-run started on GitHub, the base moving without a PR).
 *  - A current open-PR snapshot fetched after our last knowledge of the branch serves a settled PR
 *    without a call. The snapshot is never fetched from here.
 *  - The drain's own writes to the branch or PR call {@link LandingPrReads.invalidate}: the next
 *    tick reads per head.
 */
export const LANDING_PR_RECHECK_MS = 15 * 60_000;

/** An open landing PR that can't move without a review, push, merge or close: checks are done
 *  (or there is no CI), GitHub has computed its mergeability, and nothing is still running. */
export function landingPrSettled(pr: PrStatus, noCi: boolean): boolean {
  return (
    pr.state === "open" &&
    (pr.checks === "success" || pr.checks === "failure" || (pr.checks === "none" && noCi)) &&
    (pr.runningChecks?.length ?? 0) === 0 &&
    pr.mergeable != null &&
    pr.mergeStateStatus !== "unknown"
  );
}

interface Known {
  /** When it was learned: a read's start, a snapshot's fetch, or an own write. */
  at: number;
  /** The PR fingerprint key it was learned under; null never matches. */
  key: string | null;
  /** Null after an own write: nothing to reuse until the next read. */
  status: PrStatus | null;
}

export interface LandingPrReadsDeps {
  now: () => number;
  /** The repo's PR fingerprint key, or null when no fingerprint covers it (no reuse across ticks). */
  freshness?: (repoPath: string) => string | null;
  snapshot?: Pick<OpenPrSnapshotService, "peekCurrent">;
}

export class LandingPrReads {
  private readonly known = new Map<string, Known>();
  private tickReads = new Map<string, Promise<PrStatus>>();

  constructor(private readonly deps: LandingPrReadsDeps) {}

  /** A new drain tick: reads from here on are shared until the next call. */
  beginTick(): void {
    this.tickReads = new Map();
  }

  /** The landing PR on `branch`, read at most once per tick. Rejects like `forge.prStatus`. */
  read(repoPath: string, forge: GitForge, branch: string): Promise<PrStatus> {
    const id = `${repoPath}\0${branch}`;
    let read = this.tickReads.get(id);
    if (!read) {
      read = this.resolve(id, repoPath, forge, branch);
      this.tickReads.set(id, read);
    }
    return read;
  }

  /** The drain wrote to `branch` or its PR: from the next tick on, read it per head. This tick's
   *  passes keep the pre-write result, which is never more landable than the truth. */
  invalidate(repoPath: string, branch: string): void {
    this.known.set(`${repoPath}\0${branch}`, { at: this.deps.now(), key: null, status: null });
  }

  private async resolve(
    id: string,
    repoPath: string,
    forge: GitForge,
    branch: string,
  ): Promise<PrStatus> {
    const key = this.deps.freshness?.(repoPath) ?? null;
    const now = this.deps.now();
    const known = this.known.get(id);
    if (key !== null) {
      const noCi = repoHasNoCiCached(forge.kind, repoPath);
      if (
        known?.status &&
        known.key === key &&
        now - known.at < LANDING_PR_RECHECK_MS &&
        landingPrSettled(known.status, noCi)
      )
        return known.status;
      const snap = forge.isFork ? null : this.deps.snapshot?.peekCurrent(forge);
      const status = snap?.value.statuses.get(branch);
      if (
        snap &&
        status &&
        snap.at > (known?.at ?? -Infinity) &&
        now - snap.at < LANDING_PR_RECHECK_MS &&
        landingPrSettled(status, noCi)
      ) {
        this.known.set(id, { at: snap.at, key, status });
        return status;
      }
    }
    const status = await forge.prStatus(branch);
    // A write that landed while this read was in flight wins: its marker stays.
    if (this.known.get(id) === known) this.known.set(id, { at: now, key, status });
    return status;
  }
}
