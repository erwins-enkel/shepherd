const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 10;
const MAX_PEERS = 1024;

/** Per-peer attempt bucket for unauthenticated routes (`/api/pair`, `/api/login`). Bounds both
 *  attempts and memory; saturated buckets fail closed until the window ends. */
export class AttemptBudget {
  private readonly attempts = new Map<string, { until: number; count: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  allowAttempt(peer: string): boolean {
    const now = this.now();
    for (const [key, bucket] of this.attempts) if (bucket.until <= now) this.attempts.delete(key);
    let bucket = this.attempts.get(peer);
    if (!bucket) {
      if (this.attempts.size >= MAX_PEERS) return false;
      bucket = { until: now + WINDOW_MS, count: 0 };
      this.attempts.set(peer, bucket);
    }
    return ++bucket.count <= MAX_ATTEMPTS;
  }
}
