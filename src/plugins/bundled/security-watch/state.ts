// Typed accessors over the security-watch plugin's `ctx.state` keys. All settings live here: a
// bundled plugin has no writable `config.json`.

import type { PluginRepoVisibility, PluginState } from "../../types";

export type Locale = "en" | "de";
export type Severity = "critical" | "high" | "medium" | "low";
export type Source = "cs" | "dep";

export const SEVERITIES: readonly Severity[] = ["critical", "high", "medium", "low"];

export interface Settings {
  /** Master switch: off by default; every tick is a no-op until it is on. */
  enabled: boolean;
  pollMinutes: number;
  /** Panel language: the server has no operator locale. */
  locale: Locale;
}

export const DEFAULT_SETTINGS: Settings = { enabled: false, pollMinutes: 30, locale: "en" };
export const POLL_MINUTES = { min: 5, max: 1440 };

/** Per-repo opt-in. A repo without an entry is not watched. */
export interface RepoConfig {
  enabled: boolean;
  /** Also stamp the repo's `autoLabel` on filed issues. */
  autoDrain: boolean;
  minSeverity: Severity;
  codeScanning: boolean;
  dependabot: boolean;
  /** Include test/generated/library/documentation findings and dev dependencies. */
  includeNonProduction: boolean;
  /** Operator accepted that work on a non-private repo can disclose findings publicly. */
  publicRiskAck: boolean;
}

export const DEFAULT_REPO: RepoConfig = {
  enabled: false,
  autoDrain: false,
  minSeverity: "high",
  codeScanning: true,
  dependabot: true,
  includeNonProduction: false,
  publicRiskAck: false,
};

/** One open alert, reduced to what filtering, triage and filing need. Text is untrusted. */
export interface AlertRecord {
  number: number;
  url: string;
  /** Null: a rule with no security severity (code quality). */
  severity: Severity | null;
  nonProduction: boolean;
  createdAt: number;
  /** Dependabot: first patched version, null when there is none. Code scanning: always null. */
  patched: string | null;
  line: number | null;
  /** Alert message, or advisory summary. */
  text: string;
  /** Advisory id (Dependabot). */
  ref: string;
  cwes: string[];
}

export interface TriageVerdict {
  fixable: boolean;
  confidence: "high" | "medium" | "low";
  hypothesis: string;
  files: string[];
  reason: string;
}

/** What filing did with a group. `refused`: core refused for good. */
export type FilingResult =
  | { status: "filed"; number: number; url: string }
  | { status: "duplicate"; number: number; url: string }
  | { status: "refused"; code: string };

/** The current triage of a group's candidates. */
export interface TriageState {
  /** Candidate numbers this triage looked at. */
  alerts: number[];
  outcome: "pending" | "accepted" | "rejected";
  verdict: TriageVerdict | null;
  reason: string;
  overridden: boolean;
  retries?: number;
  retryAt?: number;
  /** Accepted only. Absent: not filed yet, retried by `advance()`. */
  filing?: FilingResult;
  updatedAt: number;
}

/** The latest issue filed for a group. */
export interface FiledIssue {
  number: number;
  url: string;
  filedAt: number;
  /** Alerts the issue lists. All gone from the raw list = resolved. */
  filedAlerts: number[];
  /** Alerts this filing accounts for: anything else that becomes a candidate is new. Excludes
   *  alerts only held back by a temporary hold (grace period, no patch yet). */
  coveredAlerts: number[];
  /** Filings of this group so far, this one included (auto-fix attempts). */
  attempts: number;
  sync: "open" | "closed";
  syncedAt?: number;
}

/** One group: rule + file, or package + manifest, in one repo. */
export interface GroupRecord {
  key: string;
  repo: string;
  source: Source;
  /** Rule id, or `ecosystem/package`. */
  subject: string;
  /** File path, or manifest path. */
  location: string;
  /** Scanner name (code scanning). */
  tool: string;
  /** Rule description (code scanning). */
  description: string;
  /** Raw open alerts, before any filter or hold. */
  openAlerts: AlertRecord[];
  /** When the last filing's alerts were seen gone on a complete read. */
  observedResolvedAt?: number;
  triage?: TriageState;
  filing?: FiledIssue;
}

/** Per-source result of the latest read: `ok`, a refusal reason or an error code. */
export type Availability = Partial<Record<Source, string>>;

export interface PollStatus {
  lastPollAt: number;
  lastError: string | null;
  /** Counts from the last completed poll, by outcome or skip reason. */
  lastResult: Record<string, number>;
}

const EMPTY_STATUS: PollStatus = { lastPollAt: 0, lastError: null, lastResult: {} };

export function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v)
    ? Math.min(hi, Math.max(lo, Math.round(v)))
    : fallback;
}

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
    locale: s.locale === "de" ? "de" : "en",
  };
}

export function writeSettings(state: PluginState, s: Settings): void {
  state.set("settings", s);
}

const isSeverity = (v: unknown): v is Severity =>
  typeof v === "string" && (SEVERITIES as readonly string[]).includes(v);

function normalizeRepo(raw: Partial<RepoConfig> | undefined): RepoConfig {
  const r = raw ?? {};
  return {
    enabled: r.enabled === true,
    autoDrain: r.autoDrain === true,
    minSeverity: isSeverity(r.minSeverity) ? r.minSeverity : DEFAULT_REPO.minSeverity,
    codeScanning: r.codeScanning !== false,
    dependabot: r.dependabot !== false,
    includeNonProduction: r.includeNonProduction === true,
    publicRiskAck: r.publicRiskAck === true,
  };
}

const readRepoMap = (state: PluginState) =>
  state.get<Record<string, Partial<RepoConfig>>>("repos") ?? {};

export function readRepoConfig(state: PluginState, repo: string): RepoConfig {
  return normalizeRepo(readRepoMap(state)[repo]);
}

/** Every configured repo (watched or not), by path. */
export function readRepoConfigs(state: PluginState): Record<string, RepoConfig> {
  return Object.fromEntries(
    Object.entries(readRepoMap(state)).map(([repo, raw]) => [repo, normalizeRepo(raw)]),
  );
}

export function writeRepoConfig(state: PluginState, repo: string, cfg: RepoConfig): void {
  state.set("repos", { ...readRepoMap(state), [repo]: cfg });
}

const GROUP_PREFIX = "map:";

export function groupKey(repo: string, source: Source, subject: string, location: string): string {
  return `${GROUP_PREFIX}${repo}::${source}::${subject}::${location}`;
}

export function readGroup(state: PluginState, key: string): GroupRecord | null {
  return state.get<GroupRecord>(key);
}

export function writeGroup(state: PluginState, g: GroupRecord): void {
  state.set(g.key, g);
}

export function deleteGroup(state: PluginState, key: string): void {
  state.delete(key);
}

export function readGroups(state: PluginState): GroupRecord[] {
  return state
    .keys()
    .filter((k) => k.startsWith(GROUP_PREFIX))
    .flatMap((k) => readGroup(state, k) ?? []);
}

export function readVisibility(state: PluginState, repo: string): PluginRepoVisibility {
  return state.get<PluginRepoVisibility>(`visibility:${repo}`) ?? "unknown";
}

export function writeVisibility(
  state: PluginState,
  repo: string,
  visibility: PluginRepoVisibility,
): void {
  state.set(`visibility:${repo}`, visibility);
}

export function readAvailability(state: PluginState, repo: string): Availability {
  return state.get<Availability>(`avail:${repo}`) ?? {};
}

export function writeAvailability(state: PluginState, repo: string, a: Availability): void {
  state.set(`avail:${repo}`, a);
}

/** UTC calendar day `YYYY-MM-DD`: the daily-cap bucket. */
export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface Daily {
  day: string;
  counts: Record<string, number>;
}

function readDaily(state: PluginState, day: string): Record<string, number> {
  const d = state.get<Daily>("meta:daily");
  return d?.day === day ? d.counts : {};
}

export function filedToday(state: PluginState, repo: string, day: string): number {
  return readDaily(state, day)[repo] ?? 0;
}

/** Count one filing for `repo` today (the bucket resets on a new UTC day). */
export function bumpDaily(state: PluginState, repo: string, day: string): void {
  const counts = { ...readDaily(state, day) };
  counts[repo] = (counts[repo] ?? 0) + 1;
  state.set("meta:daily", { day, counts } satisfies Daily);
}

export function readStatus(state: PluginState): PollStatus {
  return { ...EMPTY_STATUS, ...(state.get<Partial<PollStatus>>("meta:status") ?? {}) };
}

export function writeStatus(state: PluginState, s: PollStatus): void {
  state.set("meta:status", s);
}
