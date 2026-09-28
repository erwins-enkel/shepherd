// Typed accessors over the ci-watch plugin's `ctx.state` keys (#2540). All settings live here —
// a bundled plugin has no writable `config.json`.

import type { PluginState } from "../../types";

export interface Settings {
  /** Master switch — off by default; every tick is a no-op until it is on. */
  enabled: boolean;
  pollMinutes: number;
}

const DEFAULT_SETTINGS: Settings = { enabled: false, pollMinutes: 5 };
const POLL_MINUTES = { min: 1, max: 1440 };
const THRESHOLD = { min: 1, max: 20 };

/** Per-workflow threshold override; `glob` matches the workflow NAME (`*`/`?`, case-insensitive). */
export interface ThresholdOverride {
  glob: string;
  threshold: number;
}

/** Per-repo opt-in. A repo without an entry is not watched. */
export interface RepoConfig {
  enabled: boolean;
  /** Also stamp the repo's `autoLabel` on filed issues (#2542). */
  autoDrain: boolean;
  /** Consecutive failures of one key before it goes forward. */
  threshold: number;
  overrides: ThresholdOverride[];
}

export const DEFAULT_REPO: RepoConfig = {
  enabled: false,
  autoDrain: false,
  threshold: 1,
  overrides: [],
};

export interface Cursor {
  sinceId: number;
  /** False until the repo's backlog has been ingested once (nothing is forwarded before). */
  baselined: boolean;
}

/** One dedup key: workflow + failed job (matrix collapsed) in one repo. */
export interface KeyRecord {
  repo: string;
  workflowName: string;
  workflowFile: string;
  job: string;
  /** Consecutive red observations; reset by a green one. */
  streak: number;
  lastRunId: number;
  lastConclusion: "failure" | "success";
  lastFailedRunId?: number;
  lastFailedUrl?: string;
  /** Run whose failure was last handed to the forward stage. */
  forwardedRunId?: number;
  /** The issue filed for this key (#2542); `open` blocks re-forwarding. */
  filed?: { number: number; url: string; filedAt: string; sync: "open" | "closed" };
}

export interface PollStatus {
  lastPollAt: number;
  lastError: string | null;
  /** Counts from the last completed poll, by outcome/skip reason. */
  lastResult: Record<string, number>;
}

const EMPTY_STATUS: PollStatus = { lastPollAt: 0, lastError: null, lastResult: {} };

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v)
    ? Math.min(hi, Math.max(lo, Math.round(v)))
    : fallback;
}

const clampThreshold = (v: unknown) => clampInt(v, THRESHOLD.min, THRESHOLD.max, 1);

export function readSettings(state: PluginState): Settings {
  const s = state.get<Partial<Settings>>("settings") ?? {};
  return {
    enabled: s.enabled === true,
    pollMinutes: clampInt(
      s.pollMinutes,
      POLL_MINUTES.min,
      POLL_MINUTES.max,
      DEFAULT_SETTINGS.pollMinutes,
    ),
  };
}

function normalizeRepo(raw: Partial<RepoConfig> | undefined): RepoConfig {
  const r = raw ?? {};
  return {
    enabled: r.enabled === true,
    autoDrain: r.autoDrain === true,
    threshold: clampThreshold(r.threshold),
    overrides: Array.isArray(r.overrides)
      ? r.overrides
          .filter((o) => o && typeof o.glob === "string" && o.glob.trim())
          .map((o) => ({ glob: o.glob.trim(), threshold: clampThreshold(o.threshold) }))
      : [],
  };
}

export function readRepoConfig(state: PluginState, repo: string): RepoConfig {
  return normalizeRepo(state.get<Record<string, Partial<RepoConfig>>>("repos")?.[repo]);
}

export function readCursor(state: PluginState, repo: string): Cursor {
  const c = state.get<Partial<Cursor>>(`cursor:${repo}`);
  return {
    sinceId: clampInt(c?.sinceId, 0, Number.MAX_SAFE_INTEGER, 0),
    baselined: c?.baselined === true,
  };
}

export function writeCursor(state: PluginState, repo: string, c: Cursor): void {
  state.set(`cursor:${repo}`, c);
}

export function mapKey(repo: string, workflowFile: string, job: string): string {
  return `map:${repo}::${workflowFile}::${job}`;
}

export function readKey(state: PluginState, key: string): KeyRecord | null {
  return state.get<KeyRecord>(key);
}

export function writeKey(state: PluginState, key: string, r: KeyRecord): void {
  state.set(key, r);
}

/** UTC calendar day `YYYY-MM-DD` — the daily-cap bucket. */
export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface Daily {
  day: string;
  counts: Record<string, number>;
}

export function filedToday(state: PluginState, repo: string, day: string): number {
  const d = state.get<Daily>("meta:daily");
  return d?.day === day ? (d.counts[repo] ?? 0) : 0;
}

export function readStatus(state: PluginState): PollStatus {
  return { ...EMPTY_STATUS, ...(state.get<Partial<PollStatus>>("meta:status") ?? {}) };
}

export function writeStatus(state: PluginState, s: PollStatus): void {
  state.set("meta:status", s);
}
