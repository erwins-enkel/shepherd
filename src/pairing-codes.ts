import { createHash, randomBytes } from "node:crypto";

export const PAIRING_TTL_MS = 5 * 60_000;
const MAX_CODES = 5;
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 10;
const MAX_PEERS = 1024;
const hash = (code: string) => createHash("sha256").update(code).digest("hex");

/** Ephemeral, hashed invitations. Consumption is synchronous: no await can reuse a code. */
export class PairingCodeService {
  private readonly codes = new Map<string, number>();
  private readonly attempts = new Map<string, { until: number; count: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  mint(): { code: string; expiresAt: number } {
    this.purge();
    if (this.codes.size >= MAX_CODES) this.codes.delete(this.codes.keys().next().value!);
    const code = `shpp_${randomBytes(32).toString("base64url")}`;
    const expiresAt = this.now() + PAIRING_TTL_MS;
    this.codes.set(hash(code), expiresAt);
    return { code, expiresAt };
  }

  consume(code: unknown): boolean {
    this.purge();
    if (typeof code !== "string" || !/^shpp_[A-Za-z0-9_-]{43}$/.test(code)) return false;
    return this.codes.delete(hash(code));
  }

  /** Bound both attempts and memory; saturated buckets fail closed until the window ends. */
  allowAttempt(peer: string): boolean {
    this.purge();
    let bucket = this.attempts.get(peer);
    if (!bucket) {
      if (this.attempts.size >= MAX_PEERS) return false;
      bucket = { until: this.now() + WINDOW_MS, count: 0 };
      this.attempts.set(peer, bucket);
    }
    return ++bucket.count <= MAX_ATTEMPTS;
  }

  private purge(): void {
    const now = this.now();
    for (const [key, expiresAt] of this.codes) if (expiresAt <= now) this.codes.delete(key);
    for (const [key, bucket] of this.attempts) if (bucket.until <= now) this.attempts.delete(key);
  }
}
