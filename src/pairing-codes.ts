import { createHash, randomBytes } from "node:crypto";
import { PeerThrottle, type ThrottleKey } from "./attempt-budget";

export const PAIRING_TTL_MS = 5 * 60_000;
const MAX_CODES = 5;
/** All `/api/pair` attempts together per minute, per class — direct vs proxied (#3338, #3368). */
const GLOBAL_ATTEMPTS = 30;
const hash = (code: string) => createHash("sha256").update(code).digest("hex");

/** Ephemeral, hashed invitations. Consumption is synchronous: no await can reuse a code. */
export class PairingCodeService {
  private readonly codes = new Map<string, number>();
  private readonly attempts: PeerThrottle;
  constructor(private readonly now: () => number = Date.now) {
    this.attempts = new PeerThrottle(now, GLOBAL_ATTEMPTS, GLOBAL_ATTEMPTS);
  }

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
  allowAttempt(key: ThrottleKey): boolean {
    return this.attempts.allowAttempt(key);
  }

  private purge(): void {
    const now = this.now();
    for (const [key, expiresAt] of this.codes) if (expiresAt <= now) this.codes.delete(key);
  }
}
