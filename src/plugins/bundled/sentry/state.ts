// Typed accessors over the Sentry plugin's `ctx.state` keys (#2464). All settings live here —
// a bundled plugin has no writable `config.json`. The token lives in `ctx.secrets`.

import type { PluginState } from "../../types";

export type Locale = "en" | "de";

export interface Settings {
  /** Master switch — off by default; every tick is a no-op until it is on. */
  enabled: boolean;
  host: string;
  org: string;
  pollMinutes: number;
  /** `times_seen:>N` in the poll query. */
  minTimesSeen: number;
  locale: Locale;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: false,
  host: "https://sentry.io",
  org: "",
  pollMinutes: 5,
  minTimesSeen: 10,
  locale: "en",
};

export const POLL_MINUTES = { min: 1, max: 1440 };
export const TIMES_SEEN = { min: 0, max: 1_000_000 };

export type MappingSource =
  "sentry-config" | "sentryclirc" | "sentry-properties" | "code-mappings" | "manual";

/** Operator-confirmed repo → Sentry project mapping. */
export interface Mapping {
  project: string;
  /** Also stamp the repo's `autoLabel` on filed issues so the drain picks them up. */
  autoDrain: boolean;
  source: MappingSource;
}

/** A detected (unconfirmed) mapping suggestion. */
export interface Suggestion {
  repo: string;
  org: string | null;
  project: string;
  source: MappingSource;
}

/** One Sentry issue we filed on GitHub. */
export interface FiledRecord {
  repo: string;
  number: number;
  url: string;
  /** How many times this Sentry issue has been filed (auto-fix attempts). */
  attempts: number;
  filedAt: string;
}

/** Trusted issue-level facts captured when a candidate is built, read back by `file()`. */
export interface IssueMeta {
  shortId: string;
  projectSlug: string;
  permalink: string | null;
  substatus: string | null;
  count: number;
  userCount: number;
  firstSeen: string | null;
  lastSeen: string | null;
  /** Verified repo-relative file paths from the in-app frames. */
  paths: string[];
}

export interface PollStatus {
  lastPollAt: number;
  lastError: string | null;
  backoffUntil: number;
  strikes: number;
  /** Counts from the last completed poll, by outcome/skip reason. */
  lastResult: Record<string, number>;
}

const EMPTY_STATUS: PollStatus = {
  lastPollAt: 0,
  lastError: null,
  backoffUntil: 0,
  strikes: 0,
  lastResult: {},
};

export function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v)
    ? Math.min(hi, Math.max(lo, Math.round(v)))
    : fallback;
}

export function readSettings(state: PluginState): Settings {
  const s = { ...DEFAULT_SETTINGS, ...(state.get<Partial<Settings>>("settings") ?? {}) };
  return {
    enabled: s.enabled === true,
    host: typeof s.host === "string" && s.host ? s.host : DEFAULT_SETTINGS.host,
    org: typeof s.org === "string" ? s.org : "",
    pollMinutes: clampInt(
      s.pollMinutes,
      POLL_MINUTES.min,
      POLL_MINUTES.max,
      DEFAULT_SETTINGS.pollMinutes,
    ),
    minTimesSeen: clampInt(
      s.minTimesSeen,
      TIMES_SEEN.min,
      TIMES_SEEN.max,
      DEFAULT_SETTINGS.minTimesSeen,
    ),
    locale: s.locale === "de" ? "de" : "en",
  };
}

export function writeSettings(state: PluginState, s: Settings): void {
  state.set("settings", s);
}

export function readMappings(state: PluginState): Record<string, Mapping> {
  return state.get<Record<string, Mapping>>("mappings") ?? {};
}

export function writeMappings(state: PluginState, m: Record<string, Mapping>): void {
  state.set("mappings", m);
}

export function readSuggestions(state: PluginState): Suggestion[] {
  return state.get<Suggestion[]>("suggestions") ?? [];
}

export function writeSuggestions(state: PluginState, s: Suggestion[]): void {
  state.set("suggestions", s);
}

export function readFiled(state: PluginState, sentryId: string): FiledRecord | null {
  return state.get<FiledRecord>(`map:${sentryId}`);
}

export function writeFiled(state: PluginState, sentryId: string, r: FiledRecord): void {
  state.set(`map:${sentryId}`, r);
}

export function readMeta(state: PluginState, sentryId: string): IssueMeta | null {
  return state.get<IssueMeta>(`meta:${sentryId}`);
}

export function writeMeta(state: PluginState, sentryId: string, m: IssueMeta): void {
  state.set(`meta:${sentryId}`, m);
}

/** UTC calendar day `YYYY-MM-DD` — the daily-cap bucket. */
export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface Daily {
  day: string;
  counts: Record<string, number>;
}

function readDaily(state: PluginState, day: string): Record<string, number> {
  const d = state.get<Daily>("daily");
  return d?.day === day ? d.counts : {};
}

export function filedToday(state: PluginState, repo: string, day: string): number {
  return readDaily(state, day)[repo] ?? 0;
}

/** Count one filing for `repo` today (the bucket resets on a new UTC day). */
export function bumpDaily(state: PluginState, repo: string, day: string): void {
  const counts = { ...readDaily(state, day) };
  counts[repo] = (counts[repo] ?? 0) + 1;
  state.set("daily", { day, counts } satisfies Daily);
}

export function readStatus(state: PluginState): PollStatus {
  return { ...EMPTY_STATUS, ...(state.get<Partial<PollStatus>>("status") ?? {}) };
}

export function writeStatus(state: PluginState, s: PollStatus): void {
  state.set("status", s);
}
