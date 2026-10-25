import { isLoopbackPeer } from "./operator-auth";

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

/** Proxy headers whose presence marks a loopback request as fronted by a proxy. */
const PROXY_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"];
const MAX_KEY_CHARS = 256;

export type ThrottleKey = { proxied: boolean; key: string };

/** Bucket key for an unauthenticated attempt (#3368). A loopback proxy (`tailscale serve`) delivers
 *  every tailnet request from 127.0.0.1, so a bare peer key lets any raw local client (agent,
 *  other local user) drain the operator's budget. Raw loopback callers share one bucket; proxied
 *  ones key on the identity the proxy asserts (Tailscale strips client copies of
 *  `Tailscale-User-*`; the last X-Forwarded-For hop is the one the nearest proxy appended).
 *  Residual: a raw client can forge these headers — it then lands in the proxied class, where it
 *  can only hit a key it can name or exhaust that class's own cap. */
export function throttleKey(req: Request, peer: string | null | undefined): ThrottleKey {
  if (!peer || !isLoopbackPeer(peer)) return { proxied: false, key: peer || "unknown" };
  const login = req.headers.get("tailscale-user-login");
  if (login) return { proxied: true, key: `ts:${login}`.slice(0, MAX_KEY_CHARS) };
  const hop = req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  if (hop) return { proxied: true, key: `xff:${hop}`.slice(0, MAX_KEY_CHARS) };
  if (PROXY_HEADERS.some((name) => req.headers.has(name))) return { proxied: true, key: "proxied" };
  return { proxied: false, key: "loopback" };
}

/** Two independent {@link AttemptBudget}s, so proxied identities and direct/raw peers never share
 *  a bucket, a peer table or a global cap (#3368). The proxied side is always class-capped:
 *  its keys are header-derived, so rotation must not mint unbounded fresh buckets. */
export class PeerThrottle {
  private readonly direct: AttemptBudget;
  private readonly proxied: AttemptBudget;
  constructor(now: () => number, directGlobalMax: number | undefined, proxiedGlobalMax: number) {
    this.direct = new AttemptBudget(now, directGlobalMax);
    this.proxied = new AttemptBudget(now, proxiedGlobalMax);
  }

  allowAttempt({ proxied, key }: ThrottleKey): boolean {
    return (proxied ? this.proxied : this.direct).allowAttempt(key);
  }
}
