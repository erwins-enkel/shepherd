import type { RepoCounts } from "./backlog";

/**
 * Keeps the backlog counts cache warm so GET /api/backlog serves from memory
 * instead of paying per-repo `gh`/Gitea round-trips on the request path — most
 * visibly the cold first paint of an empty overview. Mirrors PrPoller's
 * boot-warmup + interval cadence.
 *
 * The default cadence is intentionally below CountsService's 60s read-TTL so a
 * forced refresh rewrites each entry before it can expire — the request path
 * then always finds a fresh value. Best-effort: a failing warm is swallowed so
 * one bad repo never sinks the tick or its siblings.
 */
export class BacklogPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  /**
   * Memoised "is this repo forge-backed?" per path. `resolveForge` (detectForge)
   * shells out to a synchronous `git remote get-url` — uncached it would block
   * the event loop on N git subprocesses every tick. Forge↔repo is effectively
   * immutable, so resolving once per path is safe.
   */
  private readonly forgeBacked = new Map<string, boolean>();

  constructor(
    private listRepos: () => Array<{ path: string }>,
    private resolveForge: (repoPath: string) => unknown | null,
    private warm: (repoPath: string) => Promise<RepoCounts>,
    private intervalMs = 45_000,
  ) {}

  async tick(): Promise<void> {
    const forgeRepos = this.listRepos().filter((r) => this.isForgeBacked(r.path));
    await Promise.all(forgeRepos.map((r) => this.warm(r.path).catch(() => null)));
  }

  private isForgeBacked(path: string): boolean {
    let backed = this.forgeBacked.get(path);
    if (backed === undefined) {
      backed = this.resolveForge(path) != null;
      this.forgeBacked.set(path, backed);
    }
    return backed;
  }

  start(): void {
    if (this.timer) return; // idempotent — never orphan a running timer
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
