const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 10;
const MAX_PEERS = 1024;

/** Per-peer attempt bucket for unauthenticated routes (`/api/pair`, `/api/login`). Bounds both
 *  attempts and memory; saturated buckets fail closed until the window ends. An optional
 *  `globalMax` also caps all peers together per window (#3338): behind a proxy every client may
 *  share one address, and directly bound the per-peer buckets alone allow 1024 × 10. */
export class AttemptBudget {
  private readonly attempts = new Map<string, { until: number; count: number }>();
  private global = { until: 0, count: 0 };
  constructor(
    private readonly now: () => number = Date.now,
    private readonly globalMax?: number,
  ) {}

  allowAttempt(peer: string): boolean {
    const now = this.now();
    for (const [key, bucket] of this.attempts) if (bucket.until <= now) this.attempts.delete(key);
    let bucket = this.attempts.get(peer);
    if (!bucket) {
      if (this.attempts.size >= MAX_PEERS) return false;
      bucket = { until: now + WINDOW_MS, count: 0 };
      this.attempts.set(peer, bucket);
    }
    if (++bucket.count > MAX_ATTEMPTS) return false;
    // Charged only for attempts the peer's own bucket accepted, so one client over its limit
    // cannot drain the shared pool for everyone else.
    if (this.globalMax === undefined) return true;
    if (this.global.until <= now) this.global = { until: now + WINDOW_MS, count: 0 };
    return ++this.global.count <= this.globalMax;
  }
}
