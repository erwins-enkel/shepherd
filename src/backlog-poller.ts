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
    // Not forge-backed: no forge, or a local forge (no remote issues/PRs to count).
    // Computed per tick with no local cache so a repoMode flip propagates without a
    // restart; the underlying `git remote get-url` shell-out is memoized upstream in
    // the production `resolveForge` (makeForgeResolver), so this stays cheap.
    const forge = this.resolveForge(path);
    return forge != null && forge.kind !== "local";
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
