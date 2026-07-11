// Up Next (#1169) — server-computed, in-memory cross-repo snapshot of un-started work.
// Off the render path: a background loop keeps it never-very-stale (also = instant first
// paint) and GET /api/up-next kicks a single-flight recompute. Reuses the same Backlog
// fan-out shape (mapBounded, ~6 concurrent) and the REAL epic pipeline (drain.buildEpic +
// selectEpicCandidates) so epic readiness gates on store session/integration/claim/PR facts,
// never on raw listIssues (which lacks them and would mis-gate).
import { realpathSync } from "node:fs";
import { mapBounded } from "./map-bounded";
import { parseEpicBody } from "./epic-parse";
import { selectEpicCandidates, type Epic, type EpicRun } from "./epic-core";
import type { GitForge } from "./forge/types";
import { reconcileRealPathsToRaw, type RepoEntry } from "./repos";
import {
  buildSnapshot,
  type RepoInput,
  type EpicUnitInput,
  type UpNextSnapshot,
} from "./up-next-core";

export interface UpNextRepo {
  repoPath: string;
  repoSlug: string | null;
  repoLabel: string;
}

/**
 * Build the list of forge-backed, non-hidden repos to feed into the Up Next ranked queue.
 *
 * Deliberate divergence from the Backlog: the Backlog includes hidden repos in its payload
 * and flags them `hidden:true` so users can reach per-repo settings. Up Next FULLY EXCLUDES
 * hidden repos — it has no settings drill-down and exists only to rank actionable work, so a
 * hidden repo contributes no section or items to the queue.
 *
 * Path-space note: `hiddenRealPaths` are realpath/safeRepoDir-resolved keys (from
 * store.hiddenRepoPaths()), while `repos` carries the raw join(repoRoot,name) paths that
 * listRepos enumerates. reconcileRealPathsToRaw translates between the two so a hide under
 * a symlinked repoRoot is still honored.
 */
export function buildUpNextRepos(args: {
  repos: readonly RepoEntry[];
  resolveForge: (p: string) => GitForge | null;
  hiddenRealPaths: Set<string>;
}): UpNextRepo[] {
  // Reconcile realpath-keyed hidden set → raw join(repoRoot,name) space that listRepos uses.
  const hiddenRaw = reconcileRealPathsToRaw(args.hiddenRealPaths, args.repos);
  const result: UpNextRepo[] = [];
  for (const entry of args.repos) {
    const forge = args.resolveForge(entry.path);
    // Skip non-forge and local repos — no cold-issue source to rank.
    if (forge == null || forge.kind === "local") continue;
    // Skip hidden repos — see deliberate full-exclude note above.
    if (hiddenRaw.has(entry.path)) continue;
    result.push({ repoPath: entry.path, repoSlug: forge.slug, repoLabel: entry.display });
  }
  return result;
}

export interface UpNextDeps {
  /** Forge-backed repos only (the caller filters out non-forge / lightweight repos). */
  listForgeRepos: () => UpNextRepo[];
  resolveForge: (repoPath: string) => GitForge | null;
  /** repoPath -> last session createdAt (warm ordering). */
  lastUsedByRepo: () => Record<string, number>;
  /** The drain's on-demand epic assembler (pulls session/integration/claim/PR facts). */
  buildEpic: (repoPath: string, run: EpicRun) => Promise<Epic | null>;
  getEpicRun: (repoPath: string) => EpicRun | null;
  /** Push the fresh snapshot to clients (a `upnext:snapshot` WS frame). */
  onChange: (snap: UpNextSnapshot) => void;
  now?: () => number;
  concurrency?: number;
  intervalMs?: number;
  /** Backoff (ms) between post-start recompute attempts; first is immediate. See
   *  `recomputeUntilCleared`. Injectable so tests can drive the loop with tiny delays. */
  postStartRetryDelaysMs?: number[];
  /** realpath resolver, injectable for tests. Used only to reconcile started-item paths
   *  (safeRepoDir/realpath space) against snapshot paths (raw listRepos space). */
  realpath?: (p: string) => string;
}

/** A just-started item, keyed for the post-start membership check. `repoPath` is in
 *  safeRepoDir/realpath space (as `handleUpNextStart` produces via `safeRepoDir`). */
export interface PostStartRef {
  repoPath: string;
  issueNumber: number;
}

const DEFAULT_CONCURRENCY = 6;
const DEFAULT_INTERVAL_MS = 15 * 60_000;
/** Immediate first attempt (claim writes have already settled by the caller), then two
 *  retries covering GitHub read-after-write lag; ~10s worst case, vs the 15-min interval. */
const DEFAULT_POST_START_RETRY_DELAYS = [0, 3_000, 7_000];

/** Spawn items strictly one-at-a-time (never overlapping). WorktreeMgr.create() uses
 *  synchronous `git worktree add` and is NOT parallel-safe per repo — concurrent spawns
 *  contend on the index/refs lock — so a batch Start MUST serialize. A throwing spawn
 *  aborts the rest (the caller reports how many landed). */
export async function startSerially<T, R>(
  items: readonly T[],
  spawn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (const item of items) out.push(await spawn(item));
  return out;
}

export class UpNextService {
  private snap: UpNextSnapshot | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<UpNextSnapshot> | null = null;
  private readonly now: () => number;
  private readonly concurrency: number;
  private readonly intervalMs: number;
  private readonly postStartRetryDelays: number[];
  private readonly realpath: (p: string) => string;

  constructor(private deps: UpNextDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.postStartRetryDelays = deps.postStartRetryDelaysMs ?? DEFAULT_POST_START_RETRY_DELAYS;
    this.realpath = deps.realpath ?? realpathSync;
  }

  snapshot(): UpNextSnapshot | null {
    return this.snap;
  }

  /** Recompute the snapshot. Single-flight: concurrent callers (on-open + the loop +
   *  the manual button) share one in-flight refresh rather than fanning out N times. */
  async refresh(): Promise<UpNextSnapshot> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.compute().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async compute(): Promise<UpNextSnapshot> {
    const repos = this.deps.listForgeRepos();
    const lastUsed = this.deps.lastUsedByRepo();
    const resolved = await mapBounded(repos, this.concurrency, (r) =>
      this.resolveRepo(r, lastUsed),
    );
    const ok = resolved.filter((r): r is RepoInput => r !== null && r !== "fetch_failed");
    const failedRepoCount = resolved.filter((r) => r === "fetch_failed").length;
    const snap = buildSnapshot(ok, this.now(), null, failedRepoCount);
    this.snap = snap;
    try {
      this.deps.onChange(snap);
    } catch (err) {
      console.warn("[up-next] onChange:", err);
    }
    return snap;
  }

  /** A recompute guaranteed to START after this call. `refresh` is single-flight, so a bare
   *  call could join a compute that began BEFORE a just-written claim label landed (a 15-min
   *  tick or a GET-triggered refresh) and cache that stale snapshot. We await any in-flight
   *  compute first, then start a fresh one — which also makes our push land AFTER the stale
   *  one, so a pre-existing compute can't re-show a cleared item. */
  private async recompute(): Promise<UpNextSnapshot> {
    if (this.inFlight) await this.inFlight.catch(() => {});
    return this.refresh();
  }

  /** Does the snapshot still list any of the just-started items? Reconciles path-space:
   *  `started` carry safeRepoDir/realpath paths, while snapshot items carry raw
   *  join(repoRoot,name) paths (see buildUpNextRepos). Under a symlinked repoRoot these
   *  differ, so we map real→raw via the current repo set (mirrors reconcileRealPathsToRaw)
   *  and match on (raw repoPath, issue number) — number alone collides across repos. */
  private stillPresent(snap: UpNextSnapshot, started: readonly PostStartRef[]): boolean {
    const rawByReal = new Map<string, string>();
    for (const r of this.deps.listForgeRepos()) {
      try {
        rawByReal.set(this.realpath(r.repoPath), r.repoPath);
      } catch {
        // vanished/broken path — can't be reconciled, skip it
      }
    }
    const wanted = started.map((s) => ({
      repoPath: rawByReal.get(s.repoPath) ?? s.repoPath,
      number: s.issueNumber,
    }));
    return snap.sections.some((sec) =>
      sec.items.some((it) =>
        wanted.some((w) => w.repoPath === it.repoPath && w.number === it.issueRef.number),
      ),
    );
  }

  /** Recompute (guaranteed-fresh) until none of `started` appear in the snapshot — their
   *  claim labels have landed and propagated — or the bounded attempts run out (then the
   *  15-min interval loop is the backstop). Fixes the post-start staleness where an immediate
   *  refresh re-read issues before the fire-and-forget `shepherd:active` label landed and
   *  re-surfaced the just-started item. Backgrounded by the caller — never blocks the response. */
  async recomputeUntilCleared(started: readonly PostStartRef[]): Promise<void> {
    if (started.length === 0) return;
    for (let i = 0; i < this.postStartRetryDelays.length; i++) {
      const delay = this.postStartRetryDelays[i]!;
      if (delay > 0) await new Promise<void>((r) => setTimeout(r, delay).unref?.());
      try {
        const snap = await this.recompute();
        if (!this.stillPresent(snap, started)) return;
      } catch (err) {
        // A transient compute failure (e.g. a briefly-locked store dep) must NOT abort the
        // remaining attempts — retrying past a hiccup is the whole point. Log and try again;
        // the 15-min interval loop backstops if every attempt fails.
        console.warn("[up-next] post-start recompute attempt failed:", err);
      }
    }
  }

  private async resolveRepo(
    r: UpNextRepo,
    lastUsed: Record<string, number>,
  ): Promise<RepoInput | "fetch_failed" | null> {
    const forge = this.deps.resolveForge(r.repoPath);
    if (!forge) return null; // forge vanished mid-compute → benign skip, not a fetch failure
    // The operator's own login on this forge, for the "mine & unassigned" filter (#824). Cached
    // per-forge (`gh api user`), so ~free after the first call. null when the host can't resolve
    // it (local/un-authed/no identity API) → the core fails open and filters nothing.
    const viewer = (await forge.currentUser?.().catch(() => null)) ?? null;
    let openIssues: Awaited<ReturnType<GitForge["listIssues"]>>;
    try {
      openIssues = await forge.listIssues();
    } catch {
      // forge/network error (e.g. rate limit) → drop the repo, but flag it as a failure so the
      // snapshot can surface a load error rather than looking "all caught up" (cf. #1221).
      return "fetch_failed";
    }
    const summaries = (await forge.listSubIssueSummaries?.().catch(() => null)) ?? {
      summaries: new Map<number, { total: number; completed: number }>(),
      subIssueNumbers: [],
    };
    const linkedIssueNumbers = (await forge.listOpenPrClosingIssues?.().catch(() => null)) ?? [];
    const blockedByOpen =
      (await forge.listBlockedByOpen?.().catch(() => null)) ?? new Map<number, number[]>();
    for (const issue of openIssues) {
      const blockers = blockedByOpen.get(issue.number);
      if (blockers && blockers.length > 0) issue.blockedBy = blockers;
    }
    const epics = await this.resolveEpics(
      r.repoPath,
      openIssues,
      summaries.summaries,
      blockedByOpen,
    );

    return {
      repoPath: r.repoPath,
      repoSlug: r.repoSlug,
      repoLabel: r.repoLabel,
      lastUsedAt: lastUsed[r.repoPath] ?? null,
      viewer,
      openIssues,
      epics,
      subIssueNumbers: summaries.subIssueNumbers,
      linkedIssueNumbers,
    };
  }

  /** Detect epic parents among visible open issues (markdown epic-dag/checklist members OR a
   *  native sub-issue parent — mirrors the backlog's collectEpicCandidates) and resolve each via
   *  the real epic pipeline. */
  private async resolveEpics(
    repoPath: string,
    openIssues: Awaited<ReturnType<GitForge["listIssues"]>>,
    nativeSummaries: Map<number, { total: number; completed: number }>,
    blockedByOpen: Map<number, number[]>,
  ): Promise<EpicUnitInput[]> {
    const openByNum = new Map(openIssues.map((i) => [i.number, i]));
    const epicParents = new Set<number>();
    for (const i of openIssues)
      if (parseEpicBody(i.body).members.length > 0) epicParents.add(i.number);
    for (const pn of nativeSummaries.keys()) if (openByNum.has(pn)) epicParents.add(pn);

    const units: EpicUnitInput[] = [];
    for (const pn of epicParents) {
      const parent = openByNum.get(pn)!;
      const epic = await this.assembleEpic(repoPath, pn);
      if (!epic) continue;
      units.push({
        parentNumber: pn,
        parentTitle: parent.title,
        parentUrl: parent.url,
        parentCreatedAt: parent.createdAt,
        parentLabels: parent.labels,
        parentAssignees: parent.assignees,
        memberNumbers: epic.children.map((c) => c.number),
        candidate: selectEpicCandidates(epic.children)[0] ?? null,
        parentBlockedBy: blockedByOpen.get(pn) ?? [],
      });
    }
    return units;
  }

  /** One epic via drain.buildEpic — reuse the stored run when it matches (pinned branch / live
   *  status), else a benign default run (status is irrelevant to child-state derivation). */
  private async assembleEpic(repoPath: string, parentNumber: number): Promise<Epic | null> {
    const stored = this.deps.getEpicRun(repoPath);
    const run: EpicRun =
      stored && stored.parentIssueNumber === parentNumber
        ? stored
        : { repoPath, parentIssueNumber: parentNumber, mode: "auto", status: "idle" };
    try {
      return await this.deps.buildEpic(repoPath, run);
    } catch {
      return null;
    }
  }

  /** Boot warm-up + interval refresh (mirrors BacklogPoller). Idempotent. */
  start(): void {
    if (this.timer) return;
    void this.refresh().catch((err) => console.warn("[up-next] boot refresh:", err));
    this.timer = setInterval(
      () => void this.refresh().catch((err) => console.warn("[up-next] tick:", err)),
      this.intervalMs,
    );
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
