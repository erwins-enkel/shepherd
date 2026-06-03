import type { SessionStore } from "./store";
import type { Session } from "./types";
import type { GitForge, GitState } from "./forge/types";

/** Read/write handle the HTTP layer uses to serve snapshots and apply instant
 *  updates from PR actions. `PrPoller` implements it. */
export interface PrCache {
  snapshot(): Record<string, GitState>;
  set(id: string, git: GitState): void;
  drop(id: string): void;
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
 * The fast sweep is capped at `fastBatch` open PRs per tick (round-robin beyond
 * it) so it never fans out one blocking `gh` per PR over an unbounded backlog.
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
  /** Round-robin offset into the open-PR list when it exceeds `fastBatch`. */
  private fastCursor = 0;
  /** Latched so the over-cap notice logs once on transition, not every fast tick. */
  private fastCapLogged = false;

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
    private store: Pick<SessionStore, "list" | "get">,
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
    /** Max open PRs polled per fast tick; the rest rotate in on later ticks. */
    private fastBatch = 8,
  ) {}

  async tick(): Promise<void> {
    if (this.sweeping) return; // a fast tick is mid-flight — it'll be re-covered here next interval
    this.sweeping = true;
    try {
      const active = new Set<string>();
      for (const s of this.store.list({ activeOnly: true })) {
        active.add(s.id);
        await this.withGh(() => this.refresh(s));
      }
      for (const id of [...this.cache.keys()]) {
        if (!active.has(id)) this.cache.delete(id);
      }
    } finally {
      this.sweeping = false;
    }
  }

  /** Accelerated re-poll of in-flight PRs (cached `state === "open"`) so the list
   *  overview tracks CI running/transition as live as the detail view, without the
   *  120s sweep's lag. Capped at `fastBatch` per tick, rotating so every open PR is
   *  covered across a few ticks rather than fanning out one `gh` per PR each time. */
  async fastTick(): Promise<void> {
    if (this.sweeping) return; // don't overlap (or double-poll behind) the full sweep
    const open = [...this.cache.entries()].filter(([, g]) => g.state === "open").map(([id]) => id);
    if (open.length === 0) return;
    let batch = open;
    if (open.length > this.fastBatch) {
      const start = this.fastCursor % open.length;
      batch = [...open, ...open].slice(start, start + this.fastBatch);
      this.fastCursor = (start + this.fastBatch) % open.length;
      // Log once on entering the over-cap regime, not every 15s tick; re-arm
      // below when the open-PR count drops back under the cap.
      if (!this.fastCapLogged) {
        console.warn(
          `[pr-poller] ${open.length} open PRs exceed fast-poll cap ${this.fastBatch}; polling ${this.fastBatch}/tick round-robin`,
        );
        this.fastCapLogged = true;
      }
    } else {
      this.fastCapLogged = false;
    }
    this.sweeping = true;
    try {
      for (const id of batch) await this.refreshOne(id);
    } finally {
      this.sweeping = false;
    }
  }

  /** Poll one session and emit `session:git` if its PR state moved. Shared by
   *  the full sweep and the targeted `pollSession` path. */
  private async refresh(s: Session): Promise<void> {
    const forge = s.branch ? this.resolveForge(s.repoPath) : null;
    if (!forge || !s.branch) return; // no PR possible — leave uncached
    let git: GitState;
    try {
      git = { kind: forge.kind, ...(await forge.prStatus(s.branch)) };
    } catch {
      return; // transient gh failure → keep last cached value
    }
    // No PR for the stored branch — the agent may have renamed the worktree's
    // branch out from under us. Adopt the live branch and retry against it.
    if (git.state === "none") {
      const live = this.reconcileBranch(s);
      if (live) {
        try {
          git = { kind: forge.kind, ...(await forge.prStatus(live)) };
        } catch {
          return;
        }
      }
    }
    const prev = this.cache.get(s.id);
    if (
      !prev ||
      prev.state !== git.state ||
      prev.number !== git.number ||
      prev.checks !== git.checks ||
      prev.headSha !== git.headSha ||
      prev.latestReview?.submittedAt !== git.latestReview?.submittedAt
    ) {
      this.cache.set(s.id, git);
      this.onChange(s.id, git);
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
  set(id: string, git: GitState): void {
    this.cache.set(id, git);
  }
  drop(id: string): void {
    this.cache.delete(id);
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
