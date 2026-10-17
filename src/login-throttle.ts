/**
 * Per-peer backoff for `POST /api/login` (issue #2105). argon2id's ~100ms verify cost alone is
 * the per-guess brake, but parallel requests scale it linearly. This adds two cheap, in-memory
 * controls keyed by the Bun-reported peer address (never a spoofable header):
 *
 *  - one verify in flight per peer — a concurrent attempt is refused instead of queued, so
 *    parallelism no longer multiplies the guess rate;
 *  - after FREE_FAILURES consecutive wrong passwords, an exponential cooldown (1s, 2s, 4s, …
 *    capped at MAX_COOLDOWN_MS) during which the peer's attempts are refused unchecked.
 *
 * A success clears the peer's record. Records are forgotten FORGET_MS after the last failure, and
 * the table is bounded (oldest evicted) so many source addresses can't grow memory or — unlike a
 * fail-closed bound — lock the real operator out. Behind a reverse proxy every client shares the
 * proxy's peer address, so they share one bucket; the cap keeps that worst case short.
 */

export const FREE_FAILURES = 5;
const BASE_COOLDOWN_MS = 1_000;
export const MAX_COOLDOWN_MS = 5 * 60_000;
const FORGET_MS = 60 * 60_000;
const MAX_PEERS = 1024;

type PeerRecord = { failures: number; lastFailure: number; until: number; inflight: boolean };

export type LoginGate = { ok: true } | { ok: false; retryAfterSec: number };

export class LoginThrottle {
  private readonly peers = new Map<string, PeerRecord>();
  constructor(private readonly now: () => number = Date.now) {}

  /** Admit or refuse one attempt. An admitted attempt MUST be settled with `settle`. */
  begin(peer: string): LoginGate {
    const now = this.now();
    this.purge(now);
    const rec = this.peers.get(peer);
    if (rec?.inflight) return { ok: false, retryAfterSec: 1 };
    if (rec && rec.until > now) {
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((rec.until - now) / 1000)) };
    }
    this.record(peer).inflight = true;
    return { ok: true };
  }

  /** Report the outcome of an admitted attempt. */
  settle(peer: string, success: boolean): void {
    const rec = this.peers.get(peer);
    if (!rec) return;
    if (success) {
      this.peers.delete(peer);
      return;
    }
    const now = this.now();
    rec.inflight = false;
    rec.failures++;
    rec.lastFailure = now;
    if (rec.failures >= FREE_FAILURES) {
      const exp = Math.min(rec.failures - FREE_FAILURES, 30);
      rec.until = now + Math.min(BASE_COOLDOWN_MS * 2 ** exp, MAX_COOLDOWN_MS);
    }
  }

  /** Release an admitted attempt that never reached a password verdict (e.g. a malformed body). */
  release(peer: string): void {
    const rec = this.peers.get(peer);
    if (!rec) return;
    if (rec.failures === 0) this.peers.delete(peer);
    else rec.inflight = false;
  }

  private record(peer: string): PeerRecord {
    let rec = this.peers.get(peer);
    if (!rec) {
      if (this.peers.size >= MAX_PEERS) this.peers.delete(this.peers.keys().next().value!);
      rec = { failures: 0, lastFailure: 0, until: 0, inflight: false };
      this.peers.set(peer, rec);
    }
    return rec;
  }

  private purge(now: number): void {
    for (const [key, rec] of this.peers) {
      if (!rec.inflight && rec.until <= now && now - rec.lastFailure >= FORGET_MS) {
        this.peers.delete(key);
      }
    }
  }
}
