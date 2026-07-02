import os from "node:os";
import { randomUUID } from "node:crypto";
import pkg from "../package.json" with { type: "json" };

export type TelemetryEventName = "app_launched" | "session_created" | "epic_drained" | "pr_opened";

export type PostEventFn = (host: string, appKey: string, batch: unknown[]) => Promise<void>;

export interface TelemetryDeps {
  appKey: string | null;
  hostOverride: string | null;
  enabled: () => boolean;
  postEvent?: PostEventFn;
  now?: () => number;
  schedule?: (fn: () => void) => void;
}

interface EventBody {
  timestamp: string;
  sessionId: string;
  eventName: string;
  systemProps: Record<string, unknown>;
  props: Record<string, string | number | boolean>;
}

const MAX_BATCH = 25;

const defaultPost: PostEventFn = (host, appKey, batch) =>
  fetch(`${host}/api/v0/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "App-Key": appKey },
    body: JSON.stringify(batch),
  }).then(() => undefined);

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

  constructor(deps: TelemetryDeps) {
    this.appKey = deps.appKey;
    this.host = resolveAptabaseHost(deps.appKey, deps.hostOverride);
    this.enabled = deps.enabled;
    this.postEvent = deps.postEvent ?? defaultPost;
    this.now = deps.now ?? (() => Date.now());
    this.schedule = deps.schedule ?? ((fn) => void setTimeout(fn, 200));
    this.sessionId = randomUUID();
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
      locale: process.env.LANG ?? "unknown",
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
      } catch {
        // best-effort telemetry: drop the batch, never surface to callers
      }
    }
  }
}
