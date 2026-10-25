/**
 * Pure helpers shared by the page-side recorder (src/recorder.ts). Kept free of
 * `window`/`chrome` so they are unit-testable; the recorder glue that wraps
 * console/fetch/XHR delegates its buffer + classification decisions here.
 */
import type { ConsoleEntry, NetworkEntry } from "./signals";

/** Push onto a ring buffer, dropping the oldest entries once it exceeds `cap`. */
export function pushCapped<T>(buf: T[], entry: T, cap: number): void {
  buf.push(entry);
  while (buf.length > cap) buf.shift();
}

/** A response counts as a recordable failure once its status is ≥400. */
export function isFailedResponse(status: number): boolean {
  return status >= 400;
}

/** Collapse console arguments into one readable line. */
export function normalizeConsoleArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

/** Ring-buffer size the recorder keeps per signal; also the most entries a read accepts. */
export const RECORDER_CAP = 50;

const TEXT_MAX = 2000;
const URL_MAX = 2048;
const METHOD_MAX = 16;
const TS_MAX = 64;

type RecorderBuffer = { console: ConsoleEntry[]; network: NetworkEntry[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function cappedString(v: unknown, max: number): string | null {
  return typeof v === "string" ? v.slice(0, max) : null;
}

function parseConsoleEntry(v: unknown): ConsoleEntry | null {
  if (!isRecord(v) || (v.level !== "error" && v.level !== "warn")) return null;
  const text = cappedString(v.text, TEXT_MAX);
  const ts = cappedString(v.ts, TS_MAX);
  return text === null || ts === null ? null : { level: v.level, text, ts };
}

function parseStatus(v: unknown): NetworkEntry["status"] | null {
  if (v === "error" || v === "load-error") return v;
  return typeof v === "number" && Number.isInteger(v) && v >= 100 && v <= 599 ? v : null;
}

function parseNetworkEntry(v: unknown): NetworkEntry | null {
  if (!isRecord(v)) return null;
  const method = cappedString(v.method, METHOD_MAX);
  const url = cappedString(v.url, URL_MAX);
  const ts = cappedString(v.ts, TS_MAX);
  const status = parseStatus(v.status);
  if (method === null || url === null || ts === null || status === null) return null;
  return { method, url, status, ts };
}

function parseEntries<T>(v: unknown, parse: (e: unknown) => T | null): T[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return null;
  return v
    .slice(-RECORDER_CAP)
    .map(parse)
    .filter((e): e is T => e !== null);
}

/**
 * Validate the recorder buffer read back from the page's MAIN world. That global is page-owned —
 * the page can create or rewrite it with any shape — so only well-typed entries survive, rebuilt
 * from known fields with capped lengths. null when the value isn't a buffer at all.
 */
export function parseRecorderBuffer(raw: unknown): RecorderBuffer | null {
  if (!isRecord(raw)) return null;
  const console = parseEntries(raw.console, parseConsoleEntry);
  const network = parseEntries(raw.network, parseNetworkEntry);
  return console === null || network === null ? null : { console, network };
}
