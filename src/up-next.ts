// Up Next (#1169) — server-computed, in-memory cross-repo snapshot of un-started work.
// Off the render path: a background loop keeps it never-very-stale (also = instant first
// paint) and GET /api/up-next kicks a single-flight recompute. Reuses the same Backlog
// fan-out shape (mapBounded, ~6 concurrent) and the REAL epic pipeline (drain.buildEpic +
// selectEpicCandidates) so epic readiness gates on store session/integration/claim/PR facts,
// never on raw listIssues (which lacks them and would mis-gate).
import { createHash } from "node:crypto";
import type { EventHub } from "./events";
import { realpathSync } from "node:fs";
import { mapBounded } from "./map-bounded";
import { parseEpicBody } from "./epic-parse";
import { selectEpicCandidates, type Epic, type EpicRun } from "./epic-core";
import type { GitForge, PullRequest } from "./forge/types";
import type { OpenPrSnapshotService } from "./open-pr-snapshot";
import { repoHasNoCiCached } from "./checks-gate";
import { buildUpNextPrs, type UpNextPrsInFlight } from "./up-next-prs";
import { reconcileRealPathRecordToRaw, reconcileRealPathsToRaw, type RepoEntry } from "./repos";
import type { ReadinessScorer, ReadinessInputOf } from "./up-next-readiness";
import { DEFAULT_ISSUE_FILTER, type IssueFilterSettings } from "./issue-filter";
import {
  applyReadiness,
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
    result.push({
      repoPath: entry.path,
      repoSlug: forge.slug,
      repoLabel: forge.slug ?? entry.display,
    });
  }
  return result;
}

export interface UpNextChanged {
  version: string;
  computedAt: number;
}

/** Shared by production wiring and the real-transport regression test. */
export function upNextChangePublisher(events: Pick<EventHub, "emit">): UpNextDeps["onChange"] {
  return (_snapshot, change) => events.emit("upnext:changed", change);
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
  /** Publication callback: snapshots stay in memory; clients receive only the change metadata. */
  onChange: (snap: UpNextSnapshot, change: UpNextChanged) => void;
  now?: () => number;
  concurrency?: number;
  intervalMs?: number;
  /** Boot and periodic reads wait for the first fingerprint and the background reserve. */
  shouldBackgroundRefresh?: () => boolean;
  /** Backoff (ms) between post-start recompute attempts; first is immediate. See
   *  `recomputeUntilCleared`. Injectable so tests can drive the loop with tiny delays. */
  postStartRetryDelaysMs?: number[];
  /** realpath resolver, injectable for tests. Reconciles safeRepoDir/realpath-space paths
   *  against raw listRepos-space repo paths: started items against snapshot paths, and the
   *  store's session/epic history against each repo (`workedIn`). */
  realpath?: (p: string) => string;
  /** Readiness rerank (#2535). Absent (no judge key) or `enabled()` false ⇒ the snapshot is exactly
   *  today's. `enabled` is read per compute so the Settings toggle lands on the next refresh. */
  readiness?: {
    enabled: () => boolean;
    scorer: Pick<ReadinessScorer, "scoreLookup" | "scoreMissing">;
  };
  /** The operator's issue filter (#3017), read per build; absent ⇒ the defaults. */
  issueFilter?: () => IssueFilterSettings;
  /** The shared per-repo open-PR snapshot the Backlog PRs tab reads — fingerprint-gated, so PRs
   *  cost no GitHub call while they are unchanged. Absent ⇒ the forge's own PR listing. */
  openPrSnapshot?: Pick<OpenPrSnapshotService, "get">;
  /** What non-archived sessions hold per repo (`prsHeldBySessions`), keyed by the sessions'
   *  realpath-space repoPath; read per build so a just-started session drops its PR on refilter. */
  prsInFlight?: () => ReadonlyMap<string, UpNextPrsInFlight>;
  /** Whether a repo runs no CI on PRs; injectable for tests. Defaults to `repoHasNoCiCached`. */
  hasNoCi?: (forgeKind: GitForge["kind"], repoPath: string) => boolean;
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

function allItems(snap: UpNextSnapshot) {
  return snap.sections.flatMap((s) => s.items);
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
  /** The latest compute's un-reranked snapshot. A background readiness run re-applies the cache to
   *  THIS, never to the snapshot it started from — so a slow judge can never publish stale items,
   *  and scores from a run that a newer compute overtook still land. */
  private raw: { snapshot: UpNextSnapshot; inputOf: ReadinessInputOf } | null = null;
  /** The latest compute's fetched per-repo input, so a filter change rebuilds without the forge. */
  private input: {
    repos: RepoInput[];
    failedRepoCount: number;
    inputOf: ReadinessInputOf;
    /** When the input was fetched: a rebuild keeps this as `generatedAt`, so freshness stays honest. */
    fetchedAt: number;
  } | null = null;

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
    // Keep the text in this compute's private context, never on a published row.
    const bodies = new Map<string, Map<number, string>>();
    for (const repo of ok) {
      const issues = new Map(repo.openIssues.map((issue) => [issue.number, issue.body]));
      for (const epic of repo.epics) {
        if (epic.candidate) issues.set(epic.candidate.number, epic.candidate.body);
      }
      bodies.set(repo.repoPath, issues);
    }
    const inputOf: ReadinessInputOf = (item) => ({
      title: item.issueRef.title,
      body: bodies.get(item.repoPath)!.get(item.issueRef.number)!,
      labels: item.labels,
    });
    this.input = { repos: ok, failedRepoCount, inputOf, fetchedAt: this.now() };
    return this.build();
  }

  /** Re-apply the current issue filter to the last fetched input — no forge call (#3017). Before
   *  the first compute there is nothing cached, so it falls back to a full refresh. */
  refilter(): void {
    if (!this.input) {
      void this.refresh().catch((err) => console.warn("[up-next] refilter:", err));
      return;
    }
    try {
      this.build();
    } catch (err) {
      console.warn("[up-next] refilter:", err);
    }
  }

  /** Build, rerank and publish a snapshot from the cached input with the current filter. */
  private build(): UpNextSnapshot {
    const { repos, failedRepoCount, inputOf, fetchedAt } = this.input!;
    const stored = this.deps.issueFilter?.() ?? DEFAULT_ISSUE_FILTER;
    // Overrides are realpath-keyed (like repo_config); items carry the raw listRepos path.
    const repoOverrides = reconcileRealPathRecordToRaw(
      stored.repoOverrides ?? {},
      repos.map((r) => ({ path: r.repoPath })),
    );
    const filter = { ...stored, repoOverrides };
    const raw = {
      ...buildSnapshot(repos, fetchedAt, null, failedRepoCount, filter),
      pullRequests: buildUpNextPrs(repos, filter, this.heldBy()),
    };
    this.raw = { snapshot: raw, inputOf };
    const readiness = this.activeReadiness();
    if (!readiness) return this.publish(raw);
    // Publish on cached scores NOW, then score the misses in the background — Up Next never
    // awaits the judge.
    const snap = this.publish(this.rerank(raw, readiness, inputOf));
    this.scoreInBackground(raw, readiness, inputOf);
    return snap;
  }

  /** The sessions' holdings by raw repo path: store keys are realpath-space, so a repo listed
   *  under a symlinked root is matched through its realpath. */
  private heldBy(): (repoPath: string) => UpNextPrsInFlight | undefined {
    const held = this.deps.prsInFlight?.();
    if (!held || held.size === 0) return () => undefined;
    return (repoPath) => {
      const direct = held.get(repoPath);
      if (direct) return direct;
      try {
        return held.get(this.realpath(repoPath));
      } catch {
        return undefined; // vanished/broken path — only the raw form can match
      }
    };
  }

  private publish(snap: UpNextSnapshot): UpNextSnapshot {
    this.snap = snap;
    try {
      this.deps.onChange(snap, {
        version: createHash("sha256").update(JSON.stringify(snap)).digest("hex"),
        computedAt: snap.generatedAt,
      });
    } catch (err) {
      console.warn("[up-next] onChange:", err);
    }
    return snap;
  }

  /** The readiness deps when the rerank is on right now, else null. A throwing `enabled` reads as
   *  off — the feature must never cost a snapshot. */
  private activeReadiness(): NonNullable<UpNextDeps["readiness"]> | null {
    const r = this.deps.readiness;
    if (!r) return null;
    try {
      return r.enabled() ? r : null;
    } catch (err) {
      console.warn("[up-next] readiness enabled():", err);
      return null;
    }
  }

  private rerank(
    raw: UpNextSnapshot,
    readiness: NonNullable<UpNextDeps["readiness"]>,
    inputOf: ReadinessInputOf,
  ): UpNextSnapshot {
    try {
      return applyReadiness(raw, readiness.scorer.scoreLookup(allItems(raw), inputOf));
    } catch (err) {
      console.warn("[up-next] readiness rerank failed (publishing today's order):", err);
      return raw;
    }
  }

  /** Fire-and-forget: score the misses, then re-publish the LATEST raw snapshot with the larger
   *  cache — only when something new was scored and the feature is still on. */
  private scoreInBackground(
    raw: UpNextSnapshot,
    readiness: NonNullable<UpNextDeps["readiness"]>,
    inputOf: ReadinessInputOf,
  ): void {
    void (async () => {
      const scored = await readiness.scorer.scoreMissing(allItems(raw), inputOf);
      const latest = this.raw;
      if (scored <= 0 || !latest || !this.activeReadiness()) return;
      this.publish(this.rerank(latest.snapshot, readiness, latest.inputOf));
    })().catch((err) => console.warn("[up-next] readiness background scoring:", err));
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
    // The sub-issue and blocker scans run only for repos the operator works in (#2808): a
    // reference clone is listed without them — no native-epic or dependency gating there.
    const scan = this.workedIn(r.repoPath, lastUsed);
    const summaries = (scan ? await forge.listSubIssueSummaries?.().catch(() => null) : null) ?? {
      summaries: new Map<number, { total: number; completed: number }>(),
      subIssueNumbers: [],
    };
    const links = await this.prLinks(forge);
    const blockedByOpen =
      (scan ? await forge.listBlockedByOpen?.().catch(() => null) : null) ??
      new Map<number, number[]>();
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
      isFork: !!forge.isFork,
      openIssues,
      epics,
      subIssueNumbers: summaries.subIssueNumbers,
      linkedIssueNumbers: links.issues,
      openPrs: await this.openPrs(forge),
      closingIssueByPr: links.closing,
      noCi: (this.deps.hasNoCi ?? repoHasNoCiCached)(forge.kind, r.repoPath),
    };
  }

  /** Issues an open PR would close (dropped from the issue list) and each PR's lowest such issue
   *  (`closesIssue`) — one cached linked-issues query backs both. */
  private async prLinks(
    forge: GitForge,
  ): Promise<{ issues: number[]; closing: Record<number, number> }> {
    if (!forge.listOpenPrLinkedIssues) {
      const issues = (await forge.listOpenPrClosingIssues?.().catch(() => null)) ?? [];
      return { issues, closing: {} };
    }
    const linked = (await forge.listOpenPrLinkedIssues().catch(() => null)) ?? new Map();
    const closing: Record<number, number> = {};
    for (const [issue, prs] of linked)
      for (const { prNumber } of prs)
        closing[prNumber] = Math.min(closing[prNumber] ?? issue, issue);
    return { issues: [...linked.keys()], closing };
  }

  /** The repo's open PRs from the query the Backlog PRs tab uses (src/server.ts handlePrsList):
   *  the shared snapshot, else the forge's listing. A failure lists no PRs for the repo — its
   *  issues still show. */
  private async openPrs(forge: GitForge): Promise<PullRequest[] | undefined> {
    try {
      const snap = await this.deps.openPrSnapshot?.get(forge, { background: true });
      return snap ? snap.prs : await forge.listPullRequests();
    } catch {
      return undefined;
    }
  }

  /** Whether the operator works in the repo: it has a session or a stored epic run. Store keys
   *  are realpath-space while `repoPath` is raw listRepos space, so both forms are checked. */
  private workedIn(repoPath: string, lastUsed: Record<string, number>): boolean {
    let real = repoPath;
    try {
      real = this.realpath(repoPath);
    } catch {
      // vanished/broken path — only the raw form can match
    }
    const paths = real === repoPath ? [repoPath] : [repoPath, real];
    return paths.some((p) => lastUsed[p] !== undefined || this.deps.getEpicRun(p) !== null);
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
        parentLabelColors: parent.labelColors,
        parentAssignees: parent.assignees,
        parentAuthor: parent.author,
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
    this.refreshInBackground();
    this.timer = setInterval(() => this.refreshInBackground(), this.intervalMs);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  /** Lens-open refresh (#2658): kick a recompute unless the snapshot is younger than `maxAgeMs`,
   *  so repeated opens don't each fan out across every repo. */
  refreshIfStale(maxAgeMs: number): void {
    if (this.isFresh(maxAgeMs)) return;
    void this.refresh().catch((err) => console.warn("[up-next] open:", err));
  }
  /** First-dashboard catch-up and boot read (#2658): the loop skips ticks with no client, so
   *  refresh a snapshot older than one interval — still behind the background gate. */
  catchUp(): void {
    if (!this.isFresh(this.intervalMs)) this.refreshInBackground();
  }
  private isFresh(maxAgeMs: number): boolean {
    return this.snap !== null && this.now() - this.snap.generatedAt < maxAgeMs;
  }
  private refreshInBackground(): void {
    if (this.deps.shouldBackgroundRefresh && !this.deps.shouldBackgroundRefresh()) return;
    void this.refresh().catch((err) => console.warn("[up-next] background refresh:", err));
  }
}
