import { SvelteMap } from "svelte/reactivity";
import type { EpicSummary } from "./types";
import { getEpics } from "./api";

/** Skip re-fetching a repo whose epics were loaded within this window. Matches the
 *  server warm poller's ~45s `backlog:update` cadence — there's no faster client poll
 *  to track, so a tighter throttle would only burn requests for unchanged data. */
const THROTTLE_MS = 45_000;

/** Client cache of epic summaries per repo, keyed by `parentIssueNumber`, so the sessions
 *  list can badge sessions whose seeding issue is an epic. Populated lazily by `refresh`
 *  (throttled per repo); read by `lookup`. Failures are swallowed per-repo (fail-closed:
 *  a repo with no entry simply yields no badge). */
class EpicSummaries {
  // repoPath → (parentIssueNumber → summary)
  byRepo = $state<Record<string, SvelteMap<number, EpicSummary>>>({});
  // repoPath → Date.now() of the last (attempted) fetch, for throttling
  private lastFetchedAt: Record<string, number> = {};

  /** Fetch epic summaries for each distinct repoPath, throttled per repo. Best-effort:
   *  a repo's fetch that throws is swallowed, leaving any prior entry intact. */
  async refresh(repoPaths: string[]): Promise<void> {
    const distinct = [...new Set(repoPaths)];
    await Promise.all(
      distinct.map(async (repoPath) => {
        const now = Date.now();
        const last = this.lastFetchedAt[repoPath];
        if (last !== undefined && now - last < THROTTLE_MS) return;
        // stamp before the fetch so concurrent/rapid calls don't double-fetch
        this.lastFetchedAt[repoPath] = now;
        try {
          const summaries = await getEpics(repoPath);
          const map = new SvelteMap<number, EpicSummary>();
          for (const s of summaries) map.set(s.parentIssueNumber, s);
          this.byRepo = { ...this.byRepo, [repoPath]: map };
        } catch {
          /* fail-closed: leave the prior entry (or none) in place */
        }
      }),
    );
  }

  /** The cached summary for `issueNumber` in `repoPath`, or undefined if not an epic. */
  lookup(repoPath: string, issueNumber: number): EpicSummary | undefined {
    return this.byRepo[repoPath]?.get(issueNumber);
  }
}

export const epicSummaries = new EpicSummaries();
