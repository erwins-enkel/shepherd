import type { SessionStore } from "./store";
import type { Session } from "./types";
import type { GitForge, GitState, PrStatus } from "./forge/types";
import { annotateHandoff } from "./repo-roles";
import type { OpenPrSnapshotService } from "./open-pr-snapshot";
import type { GithubReadCache } from "./github-read-cache";

type PrPollerStore = Pick<
  SessionStore,
  "list" | "get" | "listSessionGitCache" | "putSessionGitCache" | "deleteSessionGitCache"
>;

interface ReadProvenance {
  contentKey: string | null;
  revision: number | undefined;
}
interface PrBatch extends ReadProvenance {
  statuses: Map<string, PrStatus>;
  at: number;
}
interface TransientWindow {
  since: number;
  number?: number;
  headSha?: string;
}

/** Read/write handle the HTTP layer uses to serve snapshots and apply instant
 *  updates from PR actions. `PrPoller` implements it. */
export interface PrCache {
  snapshot(): Record<string, GitState>;
  /** Read one session's cached state without materializing the whole map — O(1) for
   *  per-request callers (e.g. GET /git) that only need a single key. */
  get(id: string): GitState | undefined;
  set(id: string, git: GitState): void;
  drop(id: string): void;
}

/** `gh pr list --head <branch>` matches by branch NAME only and `--state all`
 *  includes history, so a prior, already-merged PR that reused this branch name
 *  surfaces as a terminal hit even though the session opened no PR. Trust a
 *  merged/closed PR only when its head commit is reachable from the session's
 *  branch tip (`owns(headSha)` — true/false/null when unknowable); otherwise it's
 *  a name collision, so drop it to "none" rather than flip the row to a false
 *  MERGED. Open PRs are the inherently-current one and pass through untouched.
 *  Pure + shared so the background poller and the on-demand GET endpoint guard
 *  identically — the list overview and GitRail can't disagree. */
export function guardStaleTerminal(
  git: GitState,
  owns: (headSha: string) => boolean | null,
): GitState {
  if (
    (git.state === "merged" || git.state === "closed") &&
    git.headSha &&
    owns(git.headSha) === false
  ) {
    return {
      kind: git.kind,
      state: "none",
      checks: "none",
      deployConfigured: git.deployConfigured,
    };
  }
  return git;
}

/** Whether a terminal (`merged`/`closed`) `raw` is this session's genuine PR transition and should
 *  bypass `guardStaleTerminal` (which would mis-downgrade it to "none" when the merge train
 *  rebased/force-pushed the head out of the session's worktree, so the ownership check can't see it).
 *  Returns false immediately for any non-terminal `raw` — `guardStaleTerminal` is a no-op off-terminal
 *  anyway, and this prevents a malformed `{state:"none"}` from ever being trusted.
 *  True (for a terminal `raw`) when either:
 *   - `marked && markedNumber === raw.number` — the session is merge-train-flagged AND its recorded
 *                 observed PR number matches the terminal result: server-side reconcile only sets
 *                 `mergingSince` when it observed the PR as `state:"open"` with that number, so this
 *                 still holds for the cold-cache rebase/force-push case (same PR number, head moved).
 *                 A different-number terminal (reused branch name) falls through to the prev-cache check
 *                 rather than being blanket-trusted; or
 *   - `prev` already cached THIS PR (same number, non-"none" state) — a PR we already owned. Since
 *                 #1929 that cache is PERSISTED (`session_git_cache`) and rehydrated at construction,
 *                 so this identity survives a restart; or
 *   - (#1790) the PR was opened no earlier than the session itself. This is the fallback for the one
 *                 case the two proofs above can't cover: a PR the poller never observed as `open`
 *                 (created and merged between sweeps, or a cache row that never landed), whose remote
 *                 head a reviewer/rebase push has since moved out of the session's stale worktree —
 *                 `ownsPr` then says false and a genuine merge would be downgraded to "none" forever.
 *                 It is deliberately LAST and deliberately weakest: a cached identity, when there is
 *                 one, is authoritative in BOTH directions (a different number rejects outright rather
 *                 than falling through to here), and a payload without `createdAt` (an older cache
 *                 entry, a forge that doesn't supply it) gets no proof at all. The reused-branch-name
 *                 collision this whole function guards against is a PR created BEFORE the session, so
 *                 it still fails here and still runs the ownership check.
 *  When this returns false, `raw` may be a reused-branch-name collision and must run through
 *  `guardStaleTerminal`. */
export function trustsTerminal(
  prev: GitState | undefined,
  raw: GitState,
  marked: boolean,
  markedNumber: number | null,
  /** `session.createdAt` (epoch ms), for the temporal fallback. Omitted ⇒ that proof is skipped. */
  sessionCreatedAt: number | null = null,
): boolean {
  if (raw.state !== "merged" && raw.state !== "closed") return false; // guardStaleTerminal is a no-op off-terminal anyway
  if (marked && markedNumber != null && raw.number === markedNumber) return true;
  // A cached identity settles it either way — never fall through to the weaker temporal proof
  // when we already know which PR this session owns.
  if (prev && prev.number != null && prev.state !== "none") return prev.number === raw.number;
  return sessionCreatedAt != null && raw.createdAt != null && raw.createdAt >= sessionCreatedAt;
}

/** Order-independent equality for two optional string lists. `runningChecks` is
 *  derived from `jobsFromRollup`, whose order isn't guaranteed stable, so a plain
 *  index compare would flag a pure reorder as a change and emit a spurious push. */
function sameSet(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === b) return true;
  if ((a?.length ?? 0) !== (b?.length ?? 0)) return false;
  const as = [...(a ?? [])].sort();
  const bs = [...(b ?? [])].sort();
  return as.every((v, i) => v === bs[i]);
}

function stableJson(v: unknown): string {
  if (!v || typeof v !== "object") return JSON.stringify(v ?? null);
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
        a.toLowerCase().localeCompare(b.toLowerCase()),
      ),
    ),
  );
}

/** True when a freshly polled PR state differs from the cached one in any field
 *  the UI renders (status, CI/merge-eligibility, review, handoff) — i.e. worth
 *  pushing a session:git update. Exported for unit testing. */
/** The review + responsibility half of {@link gitStateChanged}, split out so each comparison
 *  chain stays one readable screen. */
function reviewStateChanged(prev: GitState, git: GitState): boolean {
  return (
    prev.latestReview?.submittedAt !== git.latestReview?.submittedAt ||
    stableJson(prev.reviewerStates) !== stableJson(git.reviewerStates) ||
    prev.handoff !== git.handoff ||
    prev.handoffWho !== git.handoffWho ||
    stableJson(prev.reviewBlock) !== stableJson(git.reviewBlock) ||
    // The merge confirmation reads this, and unlike `handoff` it is not CI-gated — on a stable
    // open PR nothing else here moves, so without this term a freshly derived (or cleared)
    // responsibility would be recomputed and then discarded, forever.
    stableJson(prev.mergeGate) !== stableJson(git.mergeGate)
  );
}

export function gitStateChanged(prev: GitState | undefined, git: GitState): boolean {
  return (
    !prev ||
    prev.state !== git.state ||
    prev.number !== git.number ||
    prev.checks !== git.checks ||
    !sameSet(prev.runningChecks, git.runningChecks) ||
    prev.mergeable !== git.mergeable ||
    prev.mergeStateStatus !== git.mergeStateStatus ||
    prev.isDraft !== git.isDraft ||
    prev.isFork !== git.isFork ||
    prev.authorLogin !== git.authorLogin ||
    !sameSet(prev.requestedReviewers, git.requestedReviewers) ||
    prev.headSha !== git.headSha ||
    prev.baseRefName !== git.baseRefName ||
    reviewStateChanged(prev, git)
  );
}

/**
 * Polls PR status for active sessions and caches it in memory. One `gh` process
 * runs at a time (sequential awaits) to bound the synchronous `execFileSync`
 * blocking in the forge runner and avoid GitHub rate spikes.
 *
 * Two cadences. The full `tick` sweep (every `intervalMs`, default 120s) covers
 * every active session and prunes the cache. A faster `fastTick` (every
 * `fastIntervalMs`, default 15s) re-polls only sessions with an *open* PR — the
 * in-flight ones whose CI/merge/review state can still move. Without it the list
 * overview lagged the detail view (GitRail, which polls its open PR every 15s):
 * `checks: "pending"` is short-lived and the 120s sweep routinely sampled `none`
 * then `success` two sweeps later, never recording the running state, so the
 * list jumped straight to green and never showed the pulsing "CI running" dot.
 * The fast sweep routes its eligible (transient, in-window) open PRs through the
 * same per-repo batch path as `tick` (`buildBatches`/`batchForRepo` + count-gate):
 * a repo whose transient PRs dominate its open set is refreshed with one
 * `listOpenPrStatuses`; a repo with many stable open PRs beyond the few transient
 * ones falls back to bounded per-session polls (the gate protects the 15s points
 * budget). No per-PR cap or round-robin — every eligible PR is covered each tick.
 */
export class PrPoller implements PrCache {
  private timer: ReturnType<typeof setInterval> | null = null;
  private fastTimer: ReturnType<typeof setInterval> | null = null;
  private cache = new Map<string, GitState>();
  private debounce = new Map<string, ReturnType<typeof setTimeout>>();
  private inFlight = new Set<string>();
  /** Serializes every forge poll so at most one blocking `gh` runs at a time
   *  across ALL paths — full sweep, fast sweep, and the targeted `pollSession`.
   *  Concurrent `execFileSync` would stall the single-process event loop. */
  private ghChain: Promise<void> = Promise.resolve();
  /** True while a periodic sweep (full or fast) is mid-flight. Distinct from the
   *  gh mutex: this drops *overlapping periodic ticks* so a slow sweep can't pile
   *  up a backlog of queued ticks. The targeted poll does NOT consult it — it
   *  serializes via `ghChain` instead, so a turn-end poll is never dropped. */
  private sweeping = false;
  /** Tracks when each open PR entered (or re-entered via a new headSha) a transient
   *  state — used to time-bound how long `fastTick` keeps re-polling it. */
  private transientSince = new Map<string, TransientWindow>();
  /** Content key under which this session was last checked, seeded from the warm snapshot. */
  private readonly freshnessBySession = new Map<string, string>();

  /** True when an open PR can still move without a human action — i.e. it is worth
   *  fast-polling. A PR that is fully settled (CI green, mergeable, clean) is parked. */
  private isTransientOpen(git: GitState): boolean {
    return (
      git.state === "open" &&
      (git.checks === "pending" ||
        (git.runningChecks?.length ?? 0) > 0 ||
        git.mergeable == null ||
        git.mergeStateStatus === "unknown")
    );
  }

  /** Finished/idle sessions need running CI to stay on the fast cadence. */
  private isTransientSession(s: Session, git: GitState): boolean {
    return (
      this.isTransientOpen(git) &&
      ((s.status !== "done" && s.status !== "idle") ||
        git.checks === "pending" ||
        (git.runningChecks?.length ?? 0) > 0)
    );
  }

  /** Run `fn` with the single-`gh` lock held; queues behind any in-flight poll. */
  private withGh<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.ghChain.then(fn, fn);
    this.ghChain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  constructor(
    private store: PrPollerStore,
    private resolveForge: (repoPath: string) => GitForge | null,
    private onChange: (id: string, git: GitState) => void,
    private intervalMs = 120_000,
    /** Coalescing window for `pollSession` — bursts of status flips near a
     *  turn's end collapse into one `gh` call. */
    private pollDelayMs = 1000,
    /** Called when the stored branch yields no PR: re-resolves the session's live
     *  worktree branch (an agent may have renamed it), persists the adoption, and
     *  returns the new branch to retry against — or null when nothing changed. */
    private reconcileBranch: (s: Session) => string | null = () => null,
    /** Fast cadence for re-polling open PRs (in-flight CI/merge state). */
    private fastIntervalMs = 15_000,
    /** Whether a name-matched terminal (merged/closed) PR's head commit actually
     *  belongs to the session's branch. Guards against `gh pr list --head <name>`
     *  returning a prior, already-merged PR that merely reused this branch name.
     *  `false` → discard the stale PR; `true`/`null` → trust it. */
    private ownsPr: (s: Session, headSha: string) => boolean | null = () => true,
    /** Cadence gate: poll at full rate only while *warm* (a dashboard is open OR
     *  autonomous merge work is in flight). When cold, the fast sweep pauses
     *  entirely and the full sweep throttles to `idleIntervalMs`. */
    private warm: () => boolean = () => true,
    /** True while the shared GraphQL backoff is engaged. Full sweeps still run
     *  through the per-session path so GitHub REST fallback can keep terminal PR
     *  state moving; GraphQL batch work and fast sweeps are paused. */
    private rateLimited: () => boolean = () => false,
    /** Coarse full-sweep cadence while cold (no warmth) — the fast sweep is paused
     *  outright, so this is the only PR refresh path when nobody's watching. */
    private idleIntervalMs = 300_000,
    /** How long a PR can remain transient (checks pending / mergeable unknown / merge
     *  state unknown) before `fastTick` parks it and stops fast-polling it. A new
     *  headSha resets the clock. Default: 5 minutes. */
    private transientMaxMs = 300_000,
    /** Batch the full sweep for a non-fork repo only while its open-PR count
     *  `P ≤ batchOpenRatio × (sessions with a branch in that repo)`. Above it,
     *  the per-repo full-rollup batch costs more GraphQL points than per-session,
     *  so fall back. Measured cost ≈ 0.4 pt/open-PR vs ~1 pt/session ⇒ default 2. */
    private batchOpenRatio = 2,
    /** Coarse cadence at which cached-`none` sessions are re-confirmed via
     *  per-session `prStatus` (a `--state open` batch can't surface a PR that was
     *  created and reached terminal between sweeps). Bounds stuck-`none` self-heal
     *  latency without per-sweep O(none-sessions) fan-out. */
    private noneRecheckMs = 600_000,
    /** Shared per-repo open-PR snapshot cache. When present, the full-sweep batch is sourced
     *  from it (`refresh`, always-fresh) so the PRs tab reuses the poller's fetch; when absent
     *  (older test wiring), the batch falls back to the forge's direct `listOpenPrStatuses`. */
    private snapshotSvc?: OpenPrSnapshotService,
    /** Current PR fingerprint content (plus own-write revision), or null without coverage. */
    private repoFreshness?: (repoPath: string) => string | null,
    private readCache?: GithubReadCache,
  ) {
    this.cache = new Map(Object.entries(this.store.listSessionGitCache()));
    this.hydrateTransientWindows();
    this.hydrateSessionFreshness();
  }

  private now(): number {
    return this.readCache?.now() ?? Date.now();
  }

  private hydrateTransientWindows(): void {
    if (!this.readCache) return;
    for (const [id, git] of this.cache) {
      if (!this.isTransientOpen(git)) continue;
      const s = this.store.get(id);
      const forge = s ? this.resolveForge(s.repoPath) : null;
      if (!s || forge?.kind !== "github" || !forge.slug) continue;
      this.transientSince.set(id, this.cachedTransientWindow(s, git, forge.slug));
    }
  }

  private cachedTransientWindow(s: Session, git: GitState, slug: string): TransientWindow {
    const identity = { number: git.number, headSha: git.headSha };
    const saved = this.readCache!.get("transient", slug, s.id);
    if (saved && saved.value.number === git.number && saved.value.headSha === git.headSha)
      return { since: saved.at, ...identity };
    const sessionRead = this.readCache!.get("session", slug, s.id);
    const snapshot = this.readCache!.get("prs", slug);
    const head = snapshot?.value.statuses.get(s.branch ?? "");
    // Older warm caches lack a dedicated stamp: seed from a matching observation.
    // With no provenance, park the rehydrated PR until a new head/state transition.
    let since = this.now() - this.transientMaxMs;
    if (sessionRead?.value === s.branch) since = sessionRead.at;
    else if (head && head.number === git.number && head.headSha === git.headSha)
      since = snapshot!.at;
    const entry = { since, ...identity };
    this.persistTransient(s.id, entry);
    return entry;
  }

  private persistTransient(id: string, entry?: TransientWindow): void {
    if (!this.readCache) return;
    const s = this.store.get(id);
    const forge = s ? this.resolveForge(s.repoPath) : null;
    if (forge?.kind !== "github" || !forge.slug) return;
    if (entry)
      this.readCache.put(
        "transient",
        forge.slug,
        null,
        { number: entry.number, headSha: entry.headSha },
        id,
        entry.since,
      );
    else this.readCache.delete("transient", forge.slug, id);
  }

  private hydrateSessionFreshness(): void {
    if (!this.repoFreshness || !this.readCache) return;
    for (const id of this.cache.keys()) {
      const s = this.store.get(id);
      const key = s ? this.repoFreshness(s.repoPath) : null;
      const forge = s ? this.resolveForge(s.repoPath) : null;
      if (!s || forge?.kind !== "github" || !forge.slug || !this.readCache) continue;
      const saved = this.readCache.get("session", forge.slug, id);
      if (
        key != null &&
        saved &&
        saved.value === s.branch &&
        saved.contentKey === this.readCache.contentKey("prs", forge.slug) &&
        !this.readCache.expired(saved)
      )
        this.freshnessBySession.set(id, key);
    }
    if (this.cache.size > 0) this.lastNoneRecheckAt = this.now();
  }

  /** Epoch-ms of the last full sweep that actually ran — gates the cold-path
   *  throttle in `tick`. */
  private lastFullSweepAt = 0;

  /** Epoch-ms of the last sweep that re-confirmed cached-`none` sessions. */
  private lastNoneRecheckAt = 0;

  async tick(): Promise<void> {
    const graphqlLimited = this.rateLimited();
    // Cold path: nobody's watching and no autonomous merge work — throttle the full
    // sweep to the coarse idle cadence instead of every `intervalMs`.
    if (!this.warm() && this.now() - this.lastFullSweepAt < this.idleIntervalMs) return;
    if (this.sweeping) return; // a fast tick is mid-flight — it'll be re-covered here next interval
    this.lastFullSweepAt = this.now();
    this.sweeping = true;
    try {
      const sessions = [...this.store.list({ activeOnly: true })];
      const recheckNone = this.now() - this.lastNoneRecheckAt >= this.noneRecheckMs;
      if (recheckNone) this.lastNoneRecheckAt = this.now();
      const due = sessions.filter((s) => this.shouldPoll(s, recheckNone));
      const batches = graphqlLimited
        ? new Map<string, PrBatch | null>()
        : await this.buildBatches(due, !this.repoFreshness);
      const active = new Set<string>();
      for (const s of sessions) {
        active.add(s.id);
        if (!due.includes(s)) continue;
        await this.withGh(() => this.refresh(s, this.batchFor(s, batches), recheckNone));
      }
      for (const id of [...this.cache.keys()]) {
        if (!active.has(id)) {
          this.drop(id);
        }
      }
    } finally {
      this.sweeping = false;
    }
  }

  private shouldPoll(s: Session, recheckNone: boolean): boolean {
    const prev = this.cache.get(s.id);
    if (
      this.readCache &&
      !this.readCache.canRefresh() &&
      this.resolveForge(s.repoPath)?.kind === "github"
    )
      return s.mergingSince != null || (!!prev && this.isTransientSession(s, prev));
    const key = this.repoFreshness?.(s.repoPath);
    return (
      !prev ||
      key == null ||
      this.freshnessBySession.get(s.id) !== key ||
      s.mergingSince != null ||
      this.isTransientSession(s, prev) ||
      (prev.state === "none" && recheckNone) ||
      this.sessionReadStale(s)
    );
  }

  private sessionReadStale(s: Session): boolean {
    if (!this.readCache) return false;
    const forge = this.resolveForge(s.repoPath);
    if (forge?.kind !== "github" || !forge.slug) return false;
    const entry = this.readCache.get("session", forge.slug, s.id);
    return !entry || entry.value !== s.branch || this.readCache.expired(entry);
  }

  /** Fetch the batch status for one repo. Returns the open-PR map, or null when
   *  the repo should fall back to per-session polling (no batch methods, fork,
   *  count-gate trip, or a transient fetch failure). All `gh` calls under `withGh`.
   *  count < 2: batching costs 2 gh calls (countOpenPrs + refresh) vs
   *  S = count per-session calls; break-even is S ≥ 2, so a single-session repo
   *  is a strict regression — skip both probe and list call. */
  private async batchForRepo(
    forge: GitForge,
    count: number,
    fresh = true,
  ): Promise<PrBatch | null> {
    if (!forge.countOpenPrs || forge.isFork || count < 2) return null;
    if (!forge.listOpenPrSnapshot && !forge.listOpenPrStatuses) return null;
    const provenance = this.readProvenance(forge);
    try {
      const p = await this.withGh(() => forge.countOpenPrs!());
      if (p >= 200 || p > this.batchOpenRatio * count) {
        return null; // cap-hit (truncated batch) or count-gate → per-session
      }
      if (this.snapshotSvc && forge.listOpenPrSnapshot) {
        return await this.withGh(() => this.snapshotBatch(forge, fresh, provenance));
      }
      return {
        statuses: await this.withGh(() => forge.listOpenPrStatuses!()),
        ...provenance,
        at: this.readCache?.now() ?? Date.now(),
      };
    } catch {
      return null; // transient failure → per-session this sweep
    }
  }

  private async snapshotBatch(
    forge: GitForge,
    fresh: boolean,
    provenance: ReadProvenance,
  ): Promise<PrBatch | null> {
    const snap = await (fresh ? this.snapshotSvc!.refresh(forge) : this.snapshotSvc!.get(forge));
    if (!snap || (this.repoFreshness && !this.snapshotSvc!.isCurrent(forge, snap))) return null;
    const entry =
      forge.kind === "github" && forge.slug ? this.readCache?.get("prs", forge.slug) : null;
    return {
      statuses: snap.statuses,
      ...this.readProvenance(forge),
      contentKey: entry?.contentKey ?? provenance.contentKey,
      at: entry?.at ?? this.readCache?.now() ?? Date.now(),
    };
  }

  /** One open-PR batch per distinct non-fork repo, subject to the count-gate.
   *  Maps `forge.slug` → its `Map<headRefName, PrStatus>`, or `null` when that
   *  repo must use the per-session path (no batch methods, fork mode, count-gate
   *  over ratio, or a transient fetch failure). All `gh` under `withGh`. */
  private async buildBatches(
    sessions: Session[],
    fresh = true,
  ): Promise<Map<string, PrBatch | null>> {
    const out = new Map<string, PrBatch | null>();
    const byKey = new Map<string, { forge: GitForge; count: number; fresh: boolean }>();
    for (const s of sessions) {
      if (!s.branch) continue;
      const forge = this.resolveForge(s.repoPath);
      if (!forge || forge.slug == null) continue;
      const e = byKey.get(forge.slug);
      const prev = this.cache.get(s.id);
      const force = fresh || !prev || this.isTransientSession(s, prev) || s.mergingSince != null;
      if (e) {
        e.count++;
        e.fresh ||= force;
      } else byKey.set(forge.slug, { forge, count: 1, fresh: force });
    }
    for (const [key, { forge, count, fresh }] of byKey) {
      out.set(key, await this.batchForRepo(forge, count, fresh));
    }
    return out;
  }

  /** The prefetched batch for `s`'s repo, or null (→ per-session path). */
  private batchFor(s: Session, batches: Map<string, PrBatch | null>): PrBatch | null {
    if (!s.branch) return null;
    const forge = this.resolveForge(s.repoPath);
    if (!forge || forge.slug == null) return null;
    return batches.get(forge.slug) ?? null;
  }

  /** Accelerated re-poll of in-flight PRs (cached `state === "open"`) so the list
   *  overview tracks CI running/transition as live as the detail view, without the
   *  120s sweep's lag. Routes the eligible (transient, in-window) open PRs through
   *  the same per-repo batch path as the full sweep (`buildBatches`/`batchFor` +
   *  count-gate): a repo whose transient PRs dominate its open set is refreshed
   *  with one `listOpenPrStatuses`; a repo with stable open PRs beyond the few
   *  transient ones trips the gate and falls back to bounded per-session polls. No
   *  per-PR cap or round-robin — every eligible PR is covered each tick, O(repos)
   *  when transient-dominant, O(eligible) per-session otherwise. */
  async fastTick(): Promise<void> {
    const graphqlLimited = this.rateLimited();
    // Cadence gate first: skip entirely when not warm, before the activity-aware filter below.
    if (!this.warm()) return;
    if (this.sweeping) return; // don't overlap (or double-poll behind) the full sweep
    const open = [...this.cache.entries()].filter(([, g]) => g.state === "open").map(([id]) => id);
    if (open.length === 0) return;
    // Activity-aware filter: only re-poll PRs that are still transient AND within
    // the time-bounded window. A missing stamp never opens a new restart window.
    const now = this.now();
    const eligible = open.filter((id) => {
      const git = this.cache.get(id)!;
      const s = this.store.get(id);
      if (!s || !this.isTransientSession(s, git)) return false;
      const entry = this.transientSince.get(id);
      return !!entry && now - entry.since < this.transientMaxMs;
    });
    if (eligible.length === 0) return;
    // Resolve to live sessions (an archived/gone session is pruned by the next full
    // tick); the count-gate is fed only this eligible-transient set, so it weighs a
    // batch against the per-session calls we'd actually make this tick.
    const sessions = eligible
      .map((id) => this.store.get(id))
      .filter((s): s is Session => !!s && s.status !== "archived");
    if (sessions.length === 0) return;
    // Flag BEFORE buildBatches so its countOpenPrs/listOpenPrStatuses probe runs
    // inside the mutual-exclusion window — a concurrent full tick can't interleave.
    this.sweeping = true;
    try {
      const batches = graphqlLimited
        ? new Map<string, PrBatch | null>()
        : await this.buildBatches(sessions);
      for (const s of sessions) {
        if (this.inFlight.has(s.id)) continue; // a targeted pollSession is already covering it
        this.inFlight.add(s.id);
        try {
          await this.withGh(() => this.refresh(s, this.batchFor(s, batches)));
        } finally {
          this.inFlight.delete(s.id);
        }
      }
    } finally {
      this.sweeping = false;
    }
  }

  /** Reject a reused-name terminal PR for `s` via the shared `guardStaleTerminal`.
   *  Applied to every poll result (stored and adopted-live branch alike). */
  private rejectStaleTerminal(s: Session, git: GitState): GitState {
    return guardStaleTerminal(git, (headSha) => this.ownsPr(s, headSha));
  }

  /** Poll one session and emit `session:git` if its PR state moved. Shared by
   *  the full sweep (which passes the prefetched per-repo `batch`) and the
   *  targeted `pollSession`/`fastTick` paths (no batch → per-session). The
   *  post-processing (handoff / transient stamp / change-emit) is shared; only
   *  raw-status resolution differs (`statusFromBatch` vs `statusPerSession`). */
  private async refresh(s: Session, batch?: PrBatch | null, recheckNone = false): Promise<void> {
    const forge = s.branch ? this.resolveForge(s.repoPath) : null;
    if (!forge || !s.branch) return; // no PR possible — leave uncached
    const me = (await forge.currentUser?.()) ?? null;
    const prev = this.cache.get(s.id);
    const fpKey = this.repoFreshness?.(s.repoPath);
    const provenance = this.readProvenance(forge);
    const currentBatch =
      batch && batch.contentKey === provenance.contentKey && batch.revision === provenance.revision
        ? batch
        : null;
    const marked = s.mergingSince != null;
    const markedNumber = s.mergingPrNumber ?? null;
    const guard = (raw: GitState): GitState =>
      trustsTerminal(prev, raw, marked, markedNumber, s.createdAt)
        ? raw
        : this.rejectStaleTerminal(s, raw);

    const raw = currentBatch
      ? await this.statusFromBatch(
          s,
          forge,
          currentBatch.statuses,
          prev,
          marked,
          recheckNone,
          guard,
        )
      : await this.statusPerSession(s, forge, guard);
    if (raw === null) return; // transient gh failure → keep last cached value
    if (provenance.revision !== this.readProvenance(forge).revision) return;

    // Who's up (open+green): computed from .shepherd/roles.json + the operator's
    // login, so the herd can show "waiting on scoop" instead of "your turn".
    const git = annotateHandoff(raw, s.repoPath, me, prev);
    this.trackTransient(s.id, git);
    if (gitStateChanged(prev, git) && this.set(s.id, git)) {
      this.onChange(s.id, git);
    }
    this.rememberSessionRead(s, forge, fpKey, provenance, currentBatch?.at);
  }

  private readProvenance(forge: GitForge): ReadProvenance {
    if (forge.kind !== "github" || !forge.slug || !this.readCache)
      return { contentKey: null, revision: undefined };
    return {
      contentKey: this.readCache.contentKey("prs", forge.slug),
      revision: this.readCache.revision(forge.slug),
    };
  }

  private rememberSessionRead(
    s: Session,
    forge: GitForge,
    fpKey: string | null | undefined,
    provenance: ReadProvenance,
    at?: number,
  ): void {
    if (
      fpKey == null ||
      !this.cache.has(s.id) ||
      provenance.revision !== this.readProvenance(forge).revision
    )
      return;
    this.freshnessBySession.set(s.id, fpKey);
    if (forge.kind === "github" && forge.slug && s.branch)
      this.readCache?.put("session", forge.slug, provenance.contentKey, s.branch, s.id, at);
  }

  /** Per-session raw status — TODAY'S logic verbatim (the no-batch fallback).
   *  Returns null on a transient `gh` throw ("keep last cached value"). */
  private async statusPerSession(
    s: Session,
    forge: GitForge,
    guard: (raw: GitState) => GitState,
  ): Promise<GitState | null> {
    let git: GitState;
    try {
      git = guard({ kind: forge.kind, ...(await forge.prStatus(s.branch!)) });
    } catch {
      return null;
    }
    // No PR for the stored branch — the agent may have renamed the worktree's
    // branch out from under us. Adopt the live branch and retry against it. The
    // adopted branch is just as susceptible to a reused-name terminal hit, so run
    // the same ownership guard over its status too.
    if (git.state === "none") {
      const live = this.reconcileBranch(s);
      if (live) {
        try {
          git = guard({ kind: forge.kind, ...(await forge.prStatus(live)) });
        } catch {
          return null;
        }
      }
    }
    return git;
  }

  /** Raw status from the per-repo open-PR batch. A batch hit is the live open PR.
   *  On a miss: confirm a terminal/none via per-session `prStatus` only when
   *  bounded (`marked || prev == null || prev.state !== "none" || recheckNone`);
   *  then `reconcileBranch` every sweep (local git) and look the renamed branch up
   *  in the batch first (no GraphQL) so an open-rename is adopted at the normal
   *  sweep cadence; finally synthesize a definitive `none`. */
  private async statusFromBatch(
    s: Session,
    forge: GitForge,
    batch: Map<string, PrStatus>,
    prev: GitState | undefined,
    marked: boolean,
    recheckNone: boolean,
    guard: (raw: GitState) => GitState,
  ): Promise<GitState | null> {
    const hit = batch.get(s.branch!);
    if (hit) return guard({ kind: forge.kind, ...hit });

    const needsConfirm = marked || prev == null || prev.state !== "none" || recheckNone;
    const noneGit = (): GitState => ({
      kind: forge.kind,
      state: "none",
      checks: "none",
      deployConfigured: !!forge.deployWorkflow,
    });

    let git: GitState | null = null;
    if (needsConfirm) {
      try {
        git = guard({ kind: forge.kind, ...(await forge.prStatus(s.branch!)) });
      } catch {
        return null;
      }
    }

    if (git != null && git.state !== "none") return git;

    const live = this.reconcileBranch(s);
    if (!live || live === s.branch) return git ?? noneGit();

    const liveHit = batch.get(live);
    if (liveHit) return guard({ kind: forge.kind, ...liveHit });

    if (!needsConfirm) return git ?? noneGit();

    try {
      return guard({ kind: forge.kind, ...(await forge.prStatus(live)) });
    } catch {
      return null;
    }
  }

  /** Maintain the transient-window stamp for `id` from its latest observed `git`,
   *  regardless of whether visible state changed. A non-transient state clears the
   *  stamp; a headSha change (new push) resets the window; the same headSha keeps the
   *  original `since` so the time-bound in `fastTick` measures from the first
   *  transient observation. Extracted from `refresh` to keep that method's branch
   *  count under the complexity gate. */
  private trackTransient(id: string, git: GitState): void {
    if (!this.isTransientOpen(git)) {
      if (this.transientSince.delete(id)) this.persistTransient(id);
      return;
    }
    const entry = this.transientSince.get(id);
    if (!entry || entry.headSha !== git.headSha || entry.number !== git.number) {
      const next = { since: this.now(), number: git.number, headSha: git.headSha };
      this.transientSince.set(id, next);
      this.persistTransient(id, next);
    }
  }

  /**
   * Targeted poll triggered by an external signal — chiefly an agent finishing
   * a turn, which is when it has most likely just run `gh pr create`. Surfaces
   * the PR badge within seconds instead of waiting up to `intervalMs` for the
   * next full sweep. Debounced per session (so a burst of status flips makes at
   * most one `gh` call); de-duped per session via `inFlight`, and serialized
   * behind any in-flight sweep through `withGh` so it never runs `gh`
   * concurrently with one (queued, not dropped).
   */
  pollSession(id: string): void {
    const pending = this.debounce.get(id);
    if (pending) clearTimeout(pending);
    this.debounce.set(
      id,
      setTimeout(() => {
        this.debounce.delete(id);
        void this.refreshOne(id);
      }, this.pollDelayMs),
    );
  }

  /**
   * Awaitable, undebounced poll for a caller that must act on FRESH PR state (autopilot's
   * open-a-PR re-check). Deliberately NOT de-duped on `inFlight`: a poll already in flight may
   * have started before the agent's `gh pr create`, so its answer can be stale. `withGh`
   * serializes it behind that poll, and the change-gated set/emit makes the repeat harmless.
   * Supersedes a pending debounced `pollSession` for the same session.
   */
  async pollNow(id: string): Promise<void> {
    const pending = this.debounce.get(id);
    if (pending) {
      clearTimeout(pending);
      this.debounce.delete(id);
    }
    const s = this.store.get(id);
    if (!s || s.status === "archived") return;
    await this.withGh(() => this.refresh(s));
  }

  private async refreshOne(id: string): Promise<void> {
    if (this.inFlight.has(id)) return;
    const s = this.store.get(id);
    if (!s || s.status === "archived") return; // gone → the next tick prunes it
    this.inFlight.add(id);
    try {
      await this.withGh(() => this.refresh(s));
    } finally {
      this.inFlight.delete(id);
    }
  }

  snapshot(): Record<string, GitState> {
    return Object.fromEntries(this.cache);
  }
  get(id: string): GitState | undefined {
    return this.cache.get(id);
  }
  set(id: string, git: GitState): boolean {
    this.forgetFreshness(id);
    if (!this.store.putSessionGitCache(id, git)) {
      this.cache.delete(id);
      this.transientSince.delete(id);
      this.persistTransient(id);
      return false;
    }
    this.cache.set(id, git);
    this.trackTransient(id, git);
    return true;
  }
  drop(id: string): void {
    this.forgetFreshness(id);
    this.store.deleteSessionGitCache(id);
    this.cache.delete(id);
    this.transientSince.delete(id);
    this.persistTransient(id);
  }

  private forgetFreshness(id: string): void {
    this.freshnessBySession.delete(id);
    if (!this.readCache) return;
    const s = this.store.get(id);
    const forge = s ? this.resolveForge(s.repoPath) : null;
    if (forge?.kind === "github" && forge.slug) this.readCache.delete("session", forge.slug, id);
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.fastTimer = setInterval(() => void this.fastTick(), this.fastIntervalMs);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.fastTimer) clearInterval(this.fastTimer);
    for (const t of this.debounce.values()) clearTimeout(t);
    this.debounce.clear();
  }
}
