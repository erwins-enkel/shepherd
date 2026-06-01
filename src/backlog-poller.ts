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

  constructor(
    private listRepos: () => Array<{ path: string }>,
    private resolveForge: (repoPath: string) => unknown | null,
    private warm: (repoPath: string) => Promise<RepoCounts>,
    private intervalMs = 45_000,
  ) {}

  async tick(): Promise<void> {
    const forgeRepos = this.listRepos().filter((r) => this.resolveForge(r.path) != null);
    await Promise.all(forgeRepos.map((r) => this.warm(r.path).catch(() => null)));
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
