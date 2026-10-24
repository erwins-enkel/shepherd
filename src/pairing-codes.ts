import { createHash, randomBytes } from "node:crypto";
import { AttemptBudget } from "./attempt-budget";

export const PAIRING_TTL_MS = 5 * 60_000;
const MAX_CODES = 5;
const hash = (code: string) => createHash("sha256").update(code).digest("hex");

/** Ephemeral, hashed invitations. Consumption is synchronous: no await can reuse a code. */
export class PairingCodeService {
  private readonly codes = new Map<string, number>();
  private readonly attempts: AttemptBudget;
  constructor(private readonly now: () => number = Date.now) {
    this.attempts = new AttemptBudget(now);
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
  allowAttempt(peer: string): boolean {
    return this.attempts.allowAttempt(peer);
  }

  private purge(): void {
    const now = this.now();
    for (const [key, expiresAt] of this.codes) if (expiresAt <= now) this.codes.delete(key);
  }
}
