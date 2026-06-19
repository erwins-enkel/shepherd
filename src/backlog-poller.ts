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
   * Memoised "is this repo forge-backed?" per path for non-local forges.
   * `resolveForge` shells out to `git remote get-url` for forge repos — uncached
   * it would block the event loop on N git subprocesses every tick.
   *
   * Local forges (`kind === "local"`) are NOT cached here: repoMode can be
   * toggled at runtime, so we recompute the backed verdict per tick for them.
   * Forge repos are immutably backed once detected.
   */
  private readonly forgeBackedCache = new Map<string, boolean>();

  constructor(
    private listRepos: () => Array<{ path: string }>,
    private resolveForge: (repoPath: string) => { kind?: string } | null,
    private warm: (repoPath: string) => Promise<RepoCounts>,
    private intervalMs = 45_000,
    /**
     * Fired once per tick after every repo's counts are warm. Lets the caller
     * push the freshly-warmed overview to clients (a `backlog:update` WS frame)
     * so a long-open dashboard stays live instead of showing a fetch-once
     * snapshot. Best-effort: a throwing hook is swallowed so the broadcast can
     * never sink the warm cadence.
     */
    private onWarmed?: () => void | Promise<void>,
  ) {}

  async tick(): Promise<void> {
    const forgeRepos = this.listRepos().filter((r) => this.isForgeBacked(r.path));
    await Promise.all(forgeRepos.map((r) => this.warm(r.path).catch(() => null)));
    if (this.onWarmed) await Promise.resolve(this.onWarmed()).catch(() => null);
  }

  private isForgeBacked(path: string): boolean {
    const forge = this.resolveForge(path);
    // Local forge is not considered forge-backed (no remote issues/PRs to count).
    // Recompute each time so a repoMode flip propagates without a restart.
    if (forge?.kind === "local") return false;
    if (forge === null || forge === undefined) return false;

    // Genuine remote forge: memoize to avoid repeated git shell-outs.
    let cached = this.forgeBackedCache.get(path);
    if (cached === undefined) {
      cached = true; // forge != null && kind !== "local"
      this.forgeBackedCache.set(path, cached);
    }
    return cached;
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
