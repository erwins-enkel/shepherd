import type { SessionStore } from "./store";
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

  constructor(
    private store: Pick<SessionStore, "list">,
    private resolveForge: (repoPath: string) => GitForge | null,
    private onChange: (id: string, git: GitState) => void,
    private intervalMs = 120_000,
  ) {}

  async tick(): Promise<void> {
    const active = new Set<string>();
    for (const s of this.store.list({ activeOnly: true })) {
      active.add(s.id);
      const forge = s.branch ? this.resolveForge(s.repoPath) : null;
      if (!forge || !s.branch) continue; // no PR possible — leave uncached
      let git: GitState;
      try {
        git = { kind: forge.kind, ...(await forge.prStatus(s.branch)) };
      } catch {
        continue; // transient gh failure → keep last cached value
      }
      const prev = this.cache.get(s.id);
      if (!prev || prev.state !== git.state || prev.number !== git.number) {
        this.cache.set(s.id, git);
        this.onChange(s.id, git);
      }
    }
    for (const id of [...this.cache.keys()]) {
      if (!active.has(id)) this.cache.delete(id);
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
  }
}
