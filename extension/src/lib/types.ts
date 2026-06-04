/** Auto-captured page metadata (Phase 1 signals). */
export interface PageMetadata {
  url: string;
  title: string;
  viewportW: number;
  viewportH: number;
  devicePixelRatio: number;
  userAgent: string;
  locale: string;
  /** ISO-8601 capture timestamp. */
  timestamp: string;
}

/** Result of capturing the active tab. */
export interface CaptureResult {
  /** PNG data URL from chrome.tabs.captureVisibleTab. */
  screenshotDataUrl: string;
  metadata: PageMetadata;
}

/** Persisted extension config (chrome.storage.local; never synced). */
export interface CaptureConfig {
  baseUrl: string;
  token: string;
  repoPath: string;
  baseBranch: string;
  model: "opus" | "sonnet" | "haiku" | "default";
}

/** What the popup sends the background worker to spawn a session. */
export interface SpawnPayload {
  prompt: string;
  metadata: PageMetadata;
  screenshotDataUrl: string;
}

/** Typed transport failure the popup maps to a localized message. */
export type TransportErrorKind = "origin" | "auth" | "confinement" | "unreachable" | "unknown";

export class TransportError extends Error {
  kind: TransportErrorKind;
  status: number | null;
  constructor(kind: TransportErrorKind, status: number | null, message: string) {
    super(message);
    this.name = "TransportError";
    this.kind = kind;
    this.status = status;
  }
}

/** Discriminated message envelope: popup/options <-> background worker. */
export type WorkerRequest = { type: "capture" } | { type: "spawn"; payload: SpawnPayload };

export type WorkerResponse =
  | { ok: true; type: "capture"; result: CaptureResult }
  | { ok: true; type: "spawn"; desig: string }
  | { ok: false; errorKind: TransportErrorKind | "capture"; message: string };
