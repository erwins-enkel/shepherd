import os from "node:os";
import { randomUUID } from "node:crypto";
import pkg from "../package.json" with { type: "json" };

export type TelemetryEventName = "app_launched" | "session_created" | "epic_drained" | "pr_opened";

export type PostEventFn = (host: string, appKey: string, batch: unknown[]) => Promise<void>;

/**
 * Outcome of the most recent send attempts. Telemetry is best-effort and its errors are
 * never surfaced to callers, so without this the pipeline is indistinguishable from a
 * working one when it is silently dropping everything — which is exactly how this
 * instance went a month without reporting and nobody noticed.
 */
export interface TelemetryHealth {
  /** Epoch ms of the last batch the ingestion endpoint accepted; null until one is. */
  lastSentAt: number | null;
  /** Epoch ms of the last failed batch; null until one fails. */
  lastErrorAt: number | null;
  /** Short reason for that failure ("HTTP 400", a fetch message); null until one fails. */
  lastError: string | null;
}

export interface TelemetryDeps {
  appKey: string | null;
  hostOverride: string | null;
  enabled: () => boolean;
  postEvent?: PostEventFn;
  now?: () => number;
  schedule?: (fn: () => void) => void;
  /** Seed health from durable storage at construction. Must not throw — see normalizeTelemetryHealth. */
  restore?: () => TelemetryHealth | null;
  /** Write health back after every send attempt, so it survives a restart. */
  persist?: (health: TelemetryHealth) => void;
}

interface EventBody {
  timestamp: string;
  sessionId: string;
  eventName: string;
  systemProps: Record<string, unknown>;
  props: Record<string, string | number | boolean>;
}

const MAX_BATCH = 25;

/** Cap on a stored/logged failure reason — it lands in a settings row and a UI line. */
const MAX_ERROR_LEN = 120;

const EMPTY_HEALTH: TelemetryHealth = { lastSentAt: null, lastErrorAt: null, lastError: null };

/**
 * Build the real HTTP sender. `fetch` resolves for every response the server returns, so a
 * rejected batch (HTTP 400 for an over-long locale, 401 for a bad App-Key, 429 for quota)
 * looked exactly like a delivered one; this rejects on non-2xx so `flush` can record it.
 */
export function createDefaultPost(fetchImpl: typeof fetch): PostEventFn {
  return async (host, appKey, batch) => {
    const res = await fetchImpl(`${host}/api/v0/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "App-Key": appKey },
      body: JSON.stringify(batch),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  };
}

/** Health is "failing" when the newest attempt was a failure. */
function isFailing(h: TelemetryHealth): boolean {
  if (h.lastErrorAt === null) return false;
  return h.lastSentAt === null || h.lastErrorAt > h.lastSentAt;
}

/**
 * Normalize a persisted health blob (arbitrary JSON from an operator-writable settings row)
 * to a valid TelemetryHealth, or null when it is not an object at all. Unrecognised or
 * wrong-typed fields degrade to null rather than throwing at boot.
 */
export function normalizeTelemetryHealth(value: unknown): TelemetryHealth | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const num = (x: unknown): number | null =>
    typeof x === "number" && Number.isFinite(x) ? x : null;
  const str = (x: unknown): string | null =>
    typeof x === "string" && x.length > 0 ? x.slice(0, MAX_ERROR_LEN) : null;
  return {
    lastSentAt: num(v.lastSentAt),
    lastErrorAt: num(v.lastErrorAt),
    lastError: str(v.lastError),
  };
}

/** Derive the Aptabase ingestion host from the App-Key region, honouring an explicit override. */
export function resolveAptabaseHost(
  appKey: string | null,
  hostOverride: string | null,
): string | null {
  if (!appKey) return null;
  const override = hostOverride ? hostOverride.replace(/\/+$/, "") : null;
  if (override) return override;
  const region = appKey.split("-")[1]?.toUpperCase();
  if (region === "US") return "https://us.aptabase.com";
  if (region === "EU") return "https://eu.aptabase.com";
  return null; // SH / unknown without an explicit override
}

function osName(): string {
  switch (process.platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return process.platform;
  }
}

/**
 * Normalize a glibc `LANG` value (e.g. "en_US.UTF-8") to a short BCP-47-style tag
 * Aptabase accepts. Aptabase's `SystemProps.Locale` field is capped at 10 chars and
 * rejects the whole event with HTTP 400 otherwise — and because the flush is
 * best-effort (errors swallowed), a too-long locale silently drops every event.
 * Strip the ".<encoding>" suffix, turn "_" into "-", cap at 10, fall back to "en".
 */
export function normalizeLocale(lang: string | undefined): string {
  const tag = ((lang ?? "").split(".")[0] ?? "").replace(/_/g, "-").trim();
  return tag ? tag.slice(0, 10) : "en";
}

export class TelemetryService {
  private readonly appKey: string | null;
  private readonly host: string | null;
  private readonly enabled: () => boolean;
  private readonly postEvent: PostEventFn;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void) => void;
  private readonly sessionId: string;
  private readonly buffer: EventBody[] = [];
  private pending = false;
  private readonly persist?: (health: TelemetryHealth) => void;
  private healthState: TelemetryHealth;

  constructor(deps: TelemetryDeps) {
    this.appKey = deps.appKey;
    this.host = resolveAptabaseHost(deps.appKey, deps.hostOverride);
    this.enabled = deps.enabled;
    this.postEvent = deps.postEvent ?? createDefaultPost(fetch);
    this.now = deps.now ?? (() => Date.now());
    this.schedule = deps.schedule ?? ((fn) => void setTimeout(fn, 200));
    this.sessionId = randomUUID();
    this.persist = deps.persist;
    this.healthState = deps.restore?.() ?? EMPTY_HEALTH;
  }

  /** Snapshot of the last send outcomes, for the operator-facing settings surface. */
  health(): TelemetryHealth {
    return { ...this.healthState };
  }

  /**
   * Commit a new health state, logging only when it crosses into or out of failure —
   * a persistently rejecting endpoint would otherwise log once per event forever.
   */
  private setHealth(next: TelemetryHealth): void {
    const wasFailing = isFailing(this.healthState);
    this.healthState = next;
    const nowFailing = isFailing(next);
    if (nowFailing && !wasFailing) {
      console.warn(`[telemetry] send failed: ${next.lastError} — events are being dropped`);
    } else if (!nowFailing && wasFailing) {
      console.log("[telemetry] sending again");
    }
    // Persistence is best-effort and must never escape: in production this is a synchronous
    // SQLite write that can throw SQLITE_BUSY. Both setHealth call sites sit inside flush's
    // try/catch, so an unguarded throw here would be recorded and logged as a *send* failure
    // after a successful send — and the catch-path setHealth would throw again, escaping
    // flush() itself, which callers invoke as a bare `void this.flush()`. Losing the durable
    // copy only costs the health line its memory across a restart; in-process health is
    // already correct, and the next attempt re-persists.
    try {
      this.persist?.(next);
    } catch {
      // ignored on purpose — see above
    }
  }

  private ready(): boolean {
    return this.enabled() && this.host !== null && this.appKey !== null;
  }

  private systemProps(): Record<string, unknown> {
    return {
      isDebug: false,
      osName: osName(),
      osVersion: os.release(),
      arch: process.arch,
      locale: normalizeLocale(process.env.LANG),
      appVersion: (pkg as { version: string }).version,
      engineName: process.versions.bun ? "bun" : "node",
      engineVersion: process.versions.bun ?? process.versions.node,
      sdkVersion: "shepherd-telemetry@1",
    };
  }

  event(name: TelemetryEventName, props: Record<string, string | number | boolean> = {}): void {
    if (!this.ready()) return;
    this.buffer.push({
      timestamp: new Date(this.now()).toISOString(),
      sessionId: this.sessionId,
      eventName: name,
      systemProps: this.systemProps(),
      props,
    });
    if (this.pending) return;
    this.pending = true;
    this.schedule(() => {
      this.pending = false;
      void this.flush();
    });
  }

  async flush(): Promise<void> {
    if (this.host === null || this.appKey === null) {
      this.buffer.length = 0;
      return;
    }
    while (this.buffer.length > 0) {
      const slice = this.buffer.splice(0, MAX_BATCH);
      try {
        await this.postEvent(this.host, this.appKey, slice);
        this.setHealth({ ...this.healthState, lastSentAt: this.now() });
      } catch (e) {
        // best-effort telemetry: the batch is dropped and never surfaced to callers,
        // but the outcome is recorded so the drop is not invisible.
        const reason = (e instanceof Error ? e.message : String(e)).slice(0, MAX_ERROR_LEN);
        this.setHealth({ ...this.healthState, lastErrorAt: this.now(), lastError: reason });
      }
    }
  }
}
