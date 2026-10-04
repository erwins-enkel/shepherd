// Native iOS push over Apple's push service (APNs), the interim direct transport of #2665.
//
// A registered iPhone is stored as an ordinary push subscription whose endpoint is
// `apns:<environment>:<device token>`, so the existing gates (presence, cooldown, reduced mode,
// per-device categories, locale) apply unchanged and only delivery differs. The relay that
// replaces this transport will hand out its own endpoints; nothing above `deliver` changes.

import http2 from "node:http2";
import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import type { PushPayload } from "./push";

export type ApnsEnvironment = "sandbox" | "production";

const HOSTS: Record<ApnsEnvironment, string> = {
  sandbox: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
};

const ENDPOINT_RE = /^apns:(sandbox|production):([0-9a-f]{64,200})$/;
const TOKEN_RE = /^[0-9a-fA-F]{64,200}$/;

export function isApnsToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

export function apnsEndpoint(environment: ApnsEnvironment, token: string): string {
  return `apns:${environment}:${token.toLowerCase()}`;
}

export function parseApnsEndpoint(
  endpoint: string,
): { environment: ApnsEnvironment; token: string } | null {
  const m = ENDPOINT_RE.exec(endpoint);
  if (!m?.[1] || !m[2]) return null;
  return { environment: m[1] as ApnsEnvironment, token: m[2] };
}

function b64url(data: Buffer | string): string {
  return Buffer.from(data).toString("base64url");
}

/** The ES256 provider token APNs expects in `authorization: bearer …`. */
export function apnsJwt(keyId: string, teamId: string, key: KeyObject, issuedAt: number): string {
  const head = b64url(JSON.stringify({ alg: "ES256", kid: keyId }));
  const claims = b64url(JSON.stringify({ iss: teamId, iat: issuedAt }));
  const signature = sign("sha256", Buffer.from(`${head}.${claims}`), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return `${head}.${claims}.${b64url(signature)}`;
}

/** The JSON body for one alert. `sessionId`/`kind` let the app open the right session on tap. */
export function apnsBody(payload: PushPayload): string {
  return JSON.stringify({
    aps: {
      alert: { title: payload.title, body: payload.body },
      sound: "default",
      // Group per session; host-global alerts (empty sessionId) share one thread.
      "thread-id": payload.sessionId || "host",
    },
    sessionId: payload.sessionId,
    kind: payload.kind,
  });
}

/** `apns-collapse-id` must not exceed 64 bytes; a longer tag is cut, not dropped. */
export function collapseId(tag: string): string {
  const bytes = Buffer.from(tag);
  return bytes.length <= 64 ? tag : bytes.subarray(0, 64).toString("utf8").replace(/�+$/, "");
}

export interface ApnsResult {
  status: number;
  reason?: string;
}

export type ApnsTransport = (
  origin: string,
  headers: Record<string, string>,
  body: string,
) => Promise<ApnsResult>;

/** True when APNs says this token will never work again, so the subscription can go. */
export function isDeadToken(result: ApnsResult): boolean {
  if (result.status === 410) return true;
  return (
    result.status === 400 &&
    (result.reason === "BadDeviceToken" || result.reason === "DeviceTokenNotForTopic")
  );
}

export interface ApnsConfig {
  key: string | null;
  keyId: string | null;
  teamId: string | null;
  topic: string;
}

/** Why a configured key cannot sign: the file is missing, it is not a private key, or it is a
 *  private key APNs cannot use (APNs auth keys are always EC P-256). */
export type ApnsKeyError = "unreadable" | "invalid" | "not_p256";

const PEM_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/** Parse PEM text into an APNs signing key, or say why it is not one. */
export function parseApnsKey(pem: string): KeyObject | ApnsKeyError {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    return "invalid";
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    return "not_p256";
  }
  return key;
}

/** `source` is PEM text or, from the environment only, a path to the `.p8` file. */
function loadApnsKey(source: string): KeyObject | ApnsKeyError {
  if (PEM_RE.test(source)) return parseApnsKey(source);
  try {
    return parseApnsKey(readFileSync(source, "utf8"));
  } catch {
    return "unreadable";
  }
}

/** The last APNs answer that was not a delivery, kept for the settings status. */
export interface ApnsFailure {
  status: number;
  reason: string | null;
  at: number;
}

/** Apple accepts a provider token for an hour and rejects refreshes more often than every 20
 *  minutes; renewing at 40 keeps both. */
const TOKEN_LIFETIME_S = 40 * 60;

export class ApnsSender {
  private cfg!: ApnsConfig;
  private key: KeyObject | null = null;
  private jwt: { value: string; issuedAt: number } | null = null;
  /** Set when a complete configuration names a key that cannot sign. */
  keyError: ApnsKeyError | null = null;
  lastError: ApnsFailure | null = null;
  lastDeliveredAt: number | null = null;

  constructor(
    cfg: ApnsConfig,
    private transport: ApnsTransport = http2Transport,
    private nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    this.reload(cfg);
  }

  /** Swap in a new configuration without a restart. The provider token and the delivery history
   *  belong to the old key, so both start over. */
  reload(cfg: ApnsConfig): void {
    this.cfg = cfg;
    this.key = null;
    this.jwt = null;
    this.keyError = null;
    this.lastError = null;
    this.lastDeliveredAt = null;
    if (!cfg.key || !cfg.keyId || !cfg.teamId) return;
    const key = loadApnsKey(cfg.key);
    if (typeof key === "string") {
      this.keyError = key;
      console.warn(`[apns] the APNs key is ${key} — native iOS push stays off`);
      return;
    }
    this.key = key;
  }

  get enabled(): boolean {
    return this.key !== null;
  }

  async send(
    environment: ApnsEnvironment,
    token: string,
    payload: PushPayload,
  ): Promise<ApnsResult> {
    if (!this.key || !this.cfg.keyId || !this.cfg.teamId) return { status: 0, reason: "disabled" };
    const now = this.nowSeconds();
    if (!this.jwt || now - this.jwt.issuedAt >= TOKEN_LIFETIME_S) {
      this.jwt = { value: apnsJwt(this.cfg.keyId, this.cfg.teamId, this.key, now), issuedAt: now };
    }
    const headers: Record<string, string> = {
      ":method": "POST",
      ":path": `/3/device/${token}`,
      authorization: `bearer ${this.jwt.value}`,
      "apns-topic": this.cfg.topic,
      "apns-push-type": "alert",
      "apns-priority": "10",
      // Keep trying for a day while the phone is offline; a stale alert after that is noise.
      "apns-expiration": String(now + 24 * 60 * 60),
    };
    if (payload.tag) headers["apns-collapse-id"] = collapseId(payload.tag);
    let result: ApnsResult;
    try {
      result = await this.transport(HOSTS[environment], headers, apnsBody(payload));
    } catch (err) {
      this.lastError = { status: 0, reason: (err as Error)?.message ?? null, at: now * 1000 };
      throw err;
    }
    if (result.status === 200) this.lastDeliveredAt = now * 1000;
    else this.lastError = { status: result.status, reason: result.reason ?? null, at: now * 1000 };
    // A rejected provider token is not the device's fault: mint a fresh one next time.
    if (result.status === 403) this.jwt = null;
    return result;
  }
}

// One long-lived HTTP/2 connection per APNs host, as Apple asks; reopened when it drops.
const sessions = new Map<string, http2.ClientHttp2Session>();

function connection(origin: string): http2.ClientHttp2Session {
  const existing = sessions.get(origin);
  if (existing && !existing.closed && !existing.destroyed) return existing;
  const session = http2.connect(origin);
  const forget = () => {
    if (sessions.get(origin) === session) sessions.delete(origin);
  };
  session.on("error", forget);
  session.on("close", forget);
  session.on("goaway", forget);
  // An idle push connection must never keep the server process alive.
  session.unref();
  sessions.set(origin, session);
  return session;
}

const REQUEST_TIMEOUT_MS = 15_000;

const http2Transport: ApnsTransport = (origin, headers, body) =>
  new Promise((resolve, reject) => {
    let req: http2.ClientHttp2Stream;
    try {
      req = connection(origin).request(headers);
    } catch (err) {
      reject(err);
      return;
    }
    let status = 0;
    let data = "";
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.close(http2.constants.NGHTTP2_CANCEL));
    req.on("response", (h) => (status = Number(h[":status"] ?? 0)));
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (data += chunk));
    req.on("error", reject);
    req.on("end", () => {
      let reason: string | undefined;
      try {
        reason = data ? (JSON.parse(data) as { reason?: string }).reason : undefined;
      } catch {
        reason = undefined;
      }
      resolve({ status, reason });
    });
    req.end(body);
  });
