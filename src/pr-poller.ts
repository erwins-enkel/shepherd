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
 */
export class PrPoller implements PrCache {
  private timer: ReturnType<typeof setInterval> | null = null;
  private cache = new Map<string, GitState>();
  private debounce = new Map<string, ReturnType<typeof setTimeout>>();
  private inFlight = new Set<string>();

  constructor(
    private store: Pick<SessionStore, "list" | "get">,
    private resolveForge: (repoPath: string) => GitForge | null,
    private onChange: (id: string, git: GitState) => void,
    private intervalMs = 120_000,
    /** Coalescing window for `pollSession` — bursts of status flips near a
     *  turn's end collapse into one `gh` call. */
    private pollDelayMs = 1000,
  ) {}

  async tick(): Promise<void> {
    const active = new Set<string>();
    for (const s of this.store.list({ activeOnly: true })) {
      active.add(s.id);
      await this.refresh(s);
    }
    for (const id of [...this.cache.keys()]) {
      if (!active.has(id)) this.cache.delete(id);
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
    const prev = this.cache.get(s.id);
    if (
      !prev ||
      prev.state !== git.state ||
      prev.number !== git.number ||
      prev.checks !== git.checks ||
      prev.headSha !== git.headSha
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
   * most one `gh` call) and skipped while a sweep is already polling it.
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
      await this.refresh(s);
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
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const t of this.debounce.values()) clearTimeout(t);
    this.debounce.clear();
  }
}
