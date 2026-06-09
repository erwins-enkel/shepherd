import type { CapturedSignals, GatherSignal, SignalToggles } from "./signals";

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

/**
 * How the screenshot is produced.
 * - `visible` — the current viewport (`chrome.tabs.captureVisibleTab`).
 * - `fullpage` — scroll + capture + stitch the whole page into one tall PNG.
 * - `element` — crop to a user-picked element (a separate async picker flow, not
 *   a value the synchronous `capture` message accepts).
 */
export type CaptureMode = "visible" | "fullpage" | "element";

/** Result of capturing the active tab. */
export interface CaptureResult {
  /** PNG data URL (visible capture, stitched full page, or cropped element). */
  screenshotDataUrl: string;
  metadata: PageMetadata;
  /** Which mode produced `screenshotDataUrl` (drives the popup's mode-aware hints). */
  mode: CaptureMode;
  /** Gathered signals (only the toggles that were on, that succeeded). */
  signals?: CapturedSignals;
  /**
   * Signals the user asked for that failed to gather (axe threw, recorder buffer
   * absent). Surfaced explicitly so a gather failure isn't mistaken for an empty
   * result — present only when non-empty.
   */
  signalErrors?: GatherSignal[];
  /**
   * Full-page only: the page exceeded the tile cap, so the bottom was left
   * uncaptured. Present (true) only when truncated — the popup warns explicitly
   * rather than passing a partial page off as the whole thing.
   */
  fullPageTruncated?: boolean;
}

/** One URL→repo routing rule. `pattern` is a glob (`*` wildcards) matched
 *  case-insensitively against the captured tab's full URL; first match wins. */
export interface RoutingRule {
  pattern: string;
  repoPath: string;
}

/** Where a capture is delivered. */
export type DeliveryTarget = "session" | "issue";

/** Persisted extension config (chrome.storage.local; never synced). */
export interface CaptureConfig {
  baseUrl: string;
  token: string;
  repoPath: string;
  baseBranch: string;
  model: "fable" | "opus" | "sonnet" | "haiku" | "default";
  /** Per-signal toggles; persisted defaults, overridable per-capture in the popup. */
  signals: SignalToggles;
  /** URL→repo rules; first match overrides `repoPath`. Empty = always fall back. */
  routingRules: RoutingRule[];
}

/** What the popup sends the background worker to spawn a session. */
export interface SpawnPayload {
  prompt: string;
  metadata: PageMetadata;
  screenshotDataUrl: string;
  /** Whether to upload + attach the screenshot. */
  attachScreenshot: boolean;
  signals?: CapturedSignals;
  /** Routing-resolved effective repo (overrides `config.repoPath` at spawn). */
  repoPath: string;
}

/**
 * Typed transport failure the popup maps to a localized message. `invalid`
 * (HTTP 400) covers any request the server rejected as malformed — repo-path
 * confinement is only one such case — so the popup surfaces the server's own
 * `detail`. `too_large`/`unsupported` are the upload-specific 413/415.
 */
export type TransportErrorKind =
  | "origin"
  | "auth"
  | "invalid"
  | "too_large"
  | "unsupported"
  | "unreachable"
  | "unknown";

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
export type WorkerRequest =
  | { type: "capture"; toggles: SignalToggles; mode: Exclude<CaptureMode, "element"> }
  | { type: "start-picker"; toggles: SignalToggles; instructions: string }
  | { type: "spawn"; payload: SpawnPayload }
  | {
      type: "file-issue";
      payload: {
        repoPath: string;
        title: string;
        prompt: string;
        metadata: PageMetadata;
        signals?: CapturedSignals;
      };
    };

export type WorkerResponse =
  | { ok: true; type: "capture"; result: CaptureResult }
  | { ok: true; type: "picker-started" }
  | { ok: true; type: "spawn"; desig: string }
  | { ok: true; type: "issue"; number: number; url: string }
  | { ok: false; errorKind: TransportErrorKind | "capture"; message: string };

/**
 * Messages the injected element picker (`picker.ts`, page content script) sends
 * the background worker. `picker-pick` carries the clicked element's
 * viewport-relative CSS rect plus the viewport size + dpr needed to crop the
 * capture; `picker-cancel` is sent on Esc / right-click.
 */
export type PickerMessage =
  | {
      type: "picker-pick";
      rect: { x: number; y: number; width: number; height: number };
      viewport: { width: number; height: number };
      dpr: number;
    }
  | { type: "picker-cancel" };
