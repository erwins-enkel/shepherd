/**
 * Pure helpers for the maintain loop (#2157, from #2151 R5) — no I/O, no DB, no spawn.
 * Mirrors `critic-core.ts`: thresholds, evaluation, prompt, parse + clamp.
 *
 * Shepherd's Stage-6 machinery notifies and stops. This closes the loop with tiered thresholds on
 * Shepherd's OWN health data:
 *   Tier 1 — log the reading.
 *   Tier 2 — spawn a read-only diagnosis agent that drafts a backlog issue.
 *   Tier 3 — for a band declaring a pre-approved fix class, open a PR instead (#2171).
 *
 * TIER 3 IS NOT A FOURTH THRESHOLD. A reading that crosses its band's tier-2 threshold is PROMOTED
 * to tier 3 when — and only when — that band's config declares a `tier3` fix class. Making it a
 * higher threshold would be backwards: you would need MORE dead code to earn the cheap mechanical
 * fix. Promotion keeps the ladder monotonic and leaves no band with an unreachable rung.
 *
 * Exactly one class exists (`dead_code`), on exactly one band (`dead_code_drift`). #2171 forbids
 * generalising ahead of a named class, so `tier3` lives on {@link CountBandConfig} alone — the
 * three v1 bands have no mechanical remediation and do not get an inert `tier3?` field.
 *
 * SCOPE GUARD: internal signals only. No production ingress, and no statistical control bands —
 * report §4 rules both out. The threshold table below IS the "version-controlled config" the
 * playbook asks for.
 */
import type {
  BandId,
  BandReading,
  DeliveryRepoRow,
  DeliveryIncidentRow,
  MaintainTier,
  SignalKind,
} from "./types";
import { tolerantParseJson, type VerdictRead } from "./json-tolerant";
import { fenceUntrusted, UNTRUSTED_CONTENT_DIRECTIVE } from "./untrusted";

/** The file the diagnosis agent writes its drafted issue to, in its disposable worktree. */
export const MAINTAIN_DRAFT_FILE = ".shepherd-maintain.json";

/** Windows each band measures over. Fixed, not operator-tunable: they are baked into the threshold
 *  semantics (a "≥ 25 occurrences" tier means nothing without its 7 days). */
export const CRITIC_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const INCIDENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** `first_pass_collapse` reads the 30d delivery range. The two must agree — the range is what the
 *  metric is computed over, the day count is what the diagnosis prompt tells the agent. */
export const FIRST_PASS_RANGE = "30d" as const;
const FIRST_PASS_WINDOW_DAYS = 30;

/**
 * `incident_spike` evaluates every SignalKind EXCEPT this one. `reply` is the learnings flywheel's
 * operator-correction stream — high-volume by design and not an incident class, so including it
 * would put the band permanently in breach on a healthy install.
 */
const INCIDENT_KIND_EXCLUDED: SignalKind = "reply";

/** How long a band is suppressed after a run COMPLETES, whatever its outcome or tier. */
export const DEFAULT_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;

/** At most this many band ACTIONS (a Tier-2 diagnosis spawn or a Tier-3 fix) per sweep. The rest
 *  wait for the next day. */
export const MAX_ACTIONS_PER_SWEEP = 1;

/**
 * The pinned fallow release the `dead_code_drift` band measures and fixes with (#2171).
 *
 * KEEP IN SYNC with the other pin sites — `.github/workflows/ci.yml`, `scripts/pre-push.ts` and
 * `CONTRIBUTING.md` (they carry sync banners of their own). A different version changes what counts
 * as a finding, so a drifted pin would have the band measure one thing while CI gates another.
 */
export const FALLOW_VERSION = "2.100.0";

/** A rate band: breach when the measured rate crosses the tier in the band's direction. */
interface RateBandConfig {
  /** Minimum sample below which the band reports tier 0 (`belowMinSample`), never "clear". */
  minSample: number;
  tier1: number;
  tier2: number;
}

/** The incident band: breach needs BOTH an occurrence count and a distinct-session count, so one
 *  thrashing task can never trip a band meant to catch a systemic class. */
interface IncidentBandConfig {
  tier1: { occurrences: number; sessions: number };
  tier2: { occurrences: number; sessions: number };
}

/**
 * The pre-approved remediation classes a band may declare (#2171). Exactly one exists, and adding
 * a second is a deliberate act: each class needs a mechanism that can produce the diff without an
 * operator in the loop, and an operator willing to see that diff arrive as a PR with no issue
 * first. Do NOT widen this speculatively.
 */
type FixClass = "dead_code";

/** A band's Tier-3 declaration: the pre-approved fix class its tier-2 breach escalates to. */
interface Tier3Config {
  class: FixClass;
}

/** A count band: breach when the measured count reaches the tier. No minimum sample — a count of
 *  N is exactly as trustworthy at N=1 as at N=100. */
interface CountBandConfig {
  tier1: number;
  tier2: number;
  /**
   * Present ⇒ a tier-2 breach is promoted to tier 3 and routed to the fix path instead of the
   * diagnosis path. Absent on every band without a mechanical remediation, which is why this field
   * lives here and not on the rate/incident configs.
   *
   * NOT operator-overridable: `SHEPHERD_MAINTAIN_THRESHOLDS` can retune the numbers, but disarming
   * Tier 3 is what `SHEPHERD_MAINTAIN_PR` is for. One disarm switch, not two.
   */
  tier3?: Tier3Config;
}

export interface BandThresholds {
  critic_error_rate: RateBandConfig;
  incident_spike: IncidentBandConfig;
  first_pass_collapse: RateBandConfig;
  dead_code_drift: CountBandConfig;
}

/**
 * The conservative starting table. These are calibrated guesses — no historical band data existed
 * when the loop shipped — which is why every band's live value and sample size is surfaced in the
 * Delivery lens whether or not it breached, and why `SHEPHERD_MAINTAIN_THRESHOLDS` can retune them
 * without a deploy.
 */
export const DEFAULT_BAND_THRESHOLDS: BandThresholds = {
  // Share of outcome-bearing review spawns in 7d that errored (produced no verdict).
  critic_error_rate: { minSample: 10, tier1: 0.15, tier2: 0.3 },
  // Per signal kind over 7d.
  incident_spike: {
    tier1: { occurrences: 10, sessions: 3 },
    tier2: { occurrences: 25, sessions: 5 },
  },
  // Per repo over 30d. Direction is INVERTED: a LOWER rate is worse.
  first_pass_collapse: { minSample: 8, tier1: 0.6, tier2: 0.4 },
  // Auto-fixable dead-code findings in Shepherd's own checkout, right now (#2171). A point-in-time
  // count, not a window: `fallow fix` either has something to remove or it does not.
  //
  // Why tier2 sits as low as 3: the remediation is deterministic and free, so the cost of acting is
  // a PR nobody had to write. One stray export is not worth the round trip; a handful is.
  dead_code_drift: { tier1: 1, tier2: 3, tier3: { class: "dead_code" } },
};

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Merge one rate band's overrides, ignoring any field that isn't a finite number. */
function mergeRateBand(base: RateBandConfig, raw: unknown): RateBandConfig {
  if (raw === null || typeof raw !== "object") return base;
  const o = raw as Record<string, unknown>;
  return {
    minSample: isFiniteNumber(o.minSample) && o.minSample >= 0 ? o.minSample : base.minSample,
    tier1: isFiniteNumber(o.tier1) ? o.tier1 : base.tier1,
    tier2: isFiniteNumber(o.tier2) ? o.tier2 : base.tier2,
  };
}

/** Merge the count band's overrides. `tier3` is deliberately NOT mergeable — see
 *  {@link CountBandConfig.tier3}; the base's class declaration is carried through untouched. */
function mergeCountBand(base: CountBandConfig, raw: unknown): CountBandConfig {
  if (raw === null || typeof raw !== "object") return base;
  const o = raw as Record<string, unknown>;
  return {
    tier1: isFiniteNumber(o.tier1) ? o.tier1 : base.tier1,
    tier2: isFiniteNumber(o.tier2) ? o.tier2 : base.tier2,
    ...(base.tier3 ? { tier3: base.tier3 } : {}),
  };
}

function mergeIncidentTier(
  base: { occurrences: number; sessions: number },
  raw: unknown,
): { occurrences: number; sessions: number } {
  if (raw === null || typeof raw !== "object") return base;
  const o = raw as Record<string, unknown>;
  return {
    occurrences: isFiniteNumber(o.occurrences) ? o.occurrences : base.occurrences,
    sessions: isFiniteNumber(o.sessions) ? o.sessions : base.sessions,
  };
}

/**
 * Deep-merge an operator override (the parsed `SHEPHERD_MAINTAIN_THRESHOLDS` JSON) over the
 * defaults. Field-by-field and fail-soft on purpose: a typo in one number must not disarm a whole
 * band, so anything unrecognized falls back to its default rather than throwing.
 */
export function mergeThresholds(raw: unknown): BandThresholds {
  if (raw === null || typeof raw !== "object") return DEFAULT_BAND_THRESHOLDS;
  const o = raw as Record<string, unknown>;
  const inc = (o.incident_spike ?? null) as Record<string, unknown> | null;
  return {
    critic_error_rate: mergeRateBand(
      DEFAULT_BAND_THRESHOLDS.critic_error_rate,
      o.critic_error_rate,
    ),
    incident_spike: {
      tier1: mergeIncidentTier(DEFAULT_BAND_THRESHOLDS.incident_spike.tier1, inc?.tier1),
      tier2: mergeIncidentTier(DEFAULT_BAND_THRESHOLDS.incident_spike.tier2, inc?.tier2),
    },
    first_pass_collapse: mergeRateBand(
      DEFAULT_BAND_THRESHOLDS.first_pass_collapse,
      o.first_pass_collapse,
    ),
    dead_code_drift: mergeCountBand(DEFAULT_BAND_THRESHOLDS.dead_code_drift, o.dead_code_drift),
  };
}

/** Parse the env override; any failure yields the defaults untouched. */
export function thresholdsFromEnv(raw: string | undefined): BandThresholds {
  if (!raw?.trim()) return DEFAULT_BAND_THRESHOLDS;
  const parsed = tolerantParseJson(raw);
  if (parsed.status !== "ok") return DEFAULT_BAND_THRESHOLDS;
  return mergeThresholds(parsed.value);
}

// ── dead-code report ─────────────────────────────────────────────────────────

/** What `fallow dead-code --format json` told us, reduced to what the band needs. */
export interface DeadCodeReading {
  /** Findings fallow can remove itself — the ONLY ones the band counts, because `fallow fix` is
   *  what remediates them and it drives exactly this number to zero. */
  autoFixable: number;
  /** Every finding, auto-fixable or not. Carried as the band's `sampleN` so the lens can show
   *  "1 of 3" rather than implying the other two do not exist. */
  total: number;
  /** Auto-fixable count per fallow category (`unused_exports`, …), for the PR body. Bounded by
   *  fallow's own category list. */
  byCategory: Record<string, number>;
}

/**
 * Reduce a `fallow dead-code --format json` payload to a {@link DeadCodeReading}, or null when the
 * payload is not a dead-code report at all.
 *
 * NULL IS LOAD-BEARING, in two places. The band renders it as "no data" rather than as a clear
 * 0 — a fallow that failed to run must never read as "no dead code". And the Tier-3 verify gate
 * requires `autoFixable === 0` from a REAL report, so a post-fix run whose output stopped parsing
 * fails the gate instead of passing it.
 *
 * Category-agnostic on purpose: fallow's report carries ~30 finding arrays and grows new ones
 * between releases, so this walks every top-level array of `{ actions: [...] }` objects rather than
 * hard-coding a list that would silently stop counting a newly added category. `next_steps` (the
 * only other top-level array) has no `actions` and is skipped by the same rule.
 */
export function parseDeadCodeReport(text: string | null): DeadCodeReading | null {
  if (text === null) return null;
  const parsed = tolerantParseJson(text);
  if (parsed.status !== "ok" || parsed.value === null || typeof parsed.value !== "object") {
    return null;
  }
  const o = parsed.value as Record<string, unknown>;
  // Guard the discriminator: an error envelope or a different subcommand's output must not reduce
  // to a confident zero.
  if (o.kind !== "dead-code") return null;
  const out: DeadCodeReading = { autoFixable: 0, total: 0, byCategory: {} };
  for (const [category, value] of Object.entries(o)) {
    if (!Array.isArray(value)) continue;
    const tally = tallyFindings(value);
    out.total += tally.total;
    if (tally.fixable > 0) {
      out.autoFixable += tally.fixable;
      out.byCategory[category] = (out.byCategory[category] ?? 0) + tally.fixable;
    }
  }
  return out;
}

/** Count one fallow category array: how many entries are findings, and how many of those fallow
 *  can fix itself. An entry with no `actions` array is not a finding — `next_steps` is the live
 *  example, and counting it would inflate every reading. */
function tallyFindings(items: unknown[]): { total: number; fixable: number } {
  let total = 0;
  let fixable = 0;
  for (const item of items) {
    if (item === null || typeof item !== "object") continue;
    const actions = (item as Record<string, unknown>).actions;
    if (!Array.isArray(actions)) continue;
    total += 1;
    if (actions.some(isAutoFixableAction)) fixable += 1;
  }
  return { total, fixable };
}

function isAutoFixableAction(a: unknown): boolean {
  return (
    a !== null && typeof a === "object" && (a as Record<string, unknown>).auto_fixable === true
  );
}

/**
 * The packages a Tier-3 fix can type-check, cheapest first.
 *
 * `root` is `bun run typecheck` (`tsc --noEmit`), whose tsconfig EXCLUDES `ui`, `extension`,
 * `site` and `docs-site` — each is its own package with its own check command. So a root
 * typecheck alone says nothing about a fix under `ui/src`, which is most of what fallow analyses.
 */
export type FixPackage = "root" | "ui" | "extension";

/** Cheapest-first, so a failing gate short-circuits before the slow svelte-checks. */
const PACKAGE_ORDER: FixPackage[] = ["root", "extension", "ui"];

/** Trees fallow analyses that a Tier-3 run CANNOT verify: their dependencies are not installed in
 *  the fix worktree and no check command is wired for them. A fix touching one is refused rather
 *  than committed unverified. */
const UNVERIFIABLE_PREFIXES = ["site/", "docs-site/"];

/**
 * Which packages a set of changed paths implicates, and which paths nothing can verify.
 *
 * WHY THIS EXISTS: fallow's entry list spans the root, `ui/`, `extension/`, `site/` and
 * `docs-site/`, while `bun run typecheck` covers only the first. Verifying with the root
 * typecheck alone would pass VACUOUSLY for a `fallow fix` that deleted a live export under
 * `ui/src/lib` — and that diff would then be committed, pushed and opened as a PR.
 */
export function packagesFor(changed: string[]): {
  packages: FixPackage[];
  unverifiable: string[];
} {
  const touched = new Set<FixPackage>();
  const unverifiable: string[] = [];
  for (const path of changed) {
    if (UNVERIFIABLE_PREFIXES.some((prefix) => path.startsWith(prefix))) {
      unverifiable.push(path);
    } else if (path.startsWith("ui/")) {
      touched.add("ui");
    } else if (path.startsWith("extension/")) {
      touched.add("extension");
    } else {
      touched.add("root");
    }
  }
  return { packages: PACKAGE_ORDER.filter((p) => touched.has(p)), unverifiable };
}

/** Human-readable one-liner for a reading's auto-fixable breakdown, for the PR body and the log.
 *  Categories are fallow's own snake_case names, spelled out. */
export function describeDeadCode(reading: DeadCodeReading): string {
  const parts = Object.entries(reading.byCategory)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, n]) => `${n} ${category.replace(/_/g, " ")}`);
  return parts.length > 0 ? parts.join(", ") : "no auto-fixable findings";
}

/** What one sweep measured, assembled by the caller from the store + delivery metrics. */
export interface BandInput {
  /** Outcome-bearing review spawns in the critic window. */
  reviewOutcomes: { verdicts: number; errors: number };
  /** In-window `signals` grouped by kind. */
  incidents: DeliveryIncidentRow[];
  /** Per-repo delivery rows over `FIRST_PASS_RANGE`. */
  repos: DeliveryRepoRow[];
  /** The self repo's dead-code reading, or null when fallow could not be run or read. */
  deadCode: DeadCodeReading | null;
}

/** Highest tier a value crosses on a band where HIGHER is worse. */
function tierForHigherIsWorse(value: number, cfg: RateBandConfig): MaintainTier {
  if (value >= cfg.tier2) return 2;
  if (value >= cfg.tier1) return 1;
  return 0;
}

/** Highest tier a value crosses on a band where LOWER is worse (`first_pass_collapse`). */
function tierForLowerIsWorse(value: number, cfg: RateBandConfig): MaintainTier {
  if (value <= cfg.tier2) return 2;
  if (value <= cfg.tier1) return 1;
  return 0;
}

function incidentTier(row: DeliveryIncidentRow, cfg: IncidentBandConfig): MaintainTier {
  if (row.occurrences >= cfg.tier2.occurrences && row.sessions >= cfg.tier2.sessions) return 2;
  if (row.occurrences >= cfg.tier1.occurrences && row.sessions >= cfg.tier1.sessions) return 1;
  return 0;
}

/**
 * Tier 3 is a PROMOTION of a tier-2 breach, not a threshold above it: a band that declares a fix
 * class routes its breach to the fix path instead of the diagnosis path. Every other tier passes
 * through untouched.
 *
 * The single place this happens, so no caller can reach a tier-2 reading on a fix-class band and
 * spawn a diagnosis for work the loop is about to do deterministically.
 */
function promote(tier: MaintainTier, tier3: Tier3Config | undefined): MaintainTier {
  return tier === 2 && tier3 ? 3 : tier;
}

/** The measurement window a band is scored over, in days — what the diagnosis prompt must state.
 *  `first_pass_collapse` reads the 30d delivery range; the two incident/rate bands use their 7d
 *  windows. Derived here rather than passed by the caller so the prompt can never quote a window
 *  the band does not actually use (which would land in the filed issue as the agent's reasoning).
 *
 *  `dead_code_drift` has no window — it is a point-in-time count — and reports 0. Unreachable by
 *  construction: only {@link buildDiagnosisPrompt} calls this, only a tier-2 reading reaches it,
 *  and that band's tier-2 breach is always promoted to 3. */
export function windowDaysFor(bandId: BandId): number {
  if (bandId === "first_pass_collapse") return FIRST_PASS_WINDOW_DAYS;
  if (bandId === "dead_code_drift") return 0;
  return CRITIC_WINDOW_MS / 86_400_000;
}

/** Stable identity for a band row — the key a run, a reading and a cooldown are all keyed by. */
export function bandKey(bandId: BandId, subject?: string | null): string {
  return subject ? `${bandId}:${subject}` : bandId;
}

/**
 * Evaluate all three bands. Pure over its inputs and `now`.
 *
 * Every band is returned, breached or not: the Delivery lens shows clear bands and below-min-sample
 * bands too, which is what makes the guessed thresholds recalibratable from observed values.
 */
export function evaluateBands(
  input: BandInput,
  thresholds: BandThresholds,
  now: number,
): BandReading[] {
  const out: BandReading[] = [];

  // ── critic_error_rate (global) ──────────────────────────────────────────────
  const { verdicts, errors } = input.reviewOutcomes;
  const criticN = verdicts + errors;
  const criticCfg = thresholds.critic_error_rate;
  const criticBelowMin = criticN < criticCfg.minSample;
  out.push({
    key: bandKey("critic_error_rate"),
    bandId: "critic_error_rate",
    repoPath: null,
    subject: null,
    // A zero denominator would make the rate NaN; report 0 and let belowMinSample carry the truth.
    value: criticN === 0 ? 0 : errors / criticN,
    sampleN: criticN,
    tier: criticBelowMin ? 0 : tierForHigherIsWorse(errors / criticN, criticCfg),
    belowMinSample: criticBelowMin,
    evaluatedAt: now,
  });

  // ── incident_spike (global, one row per signal kind) ────────────────────────
  for (const row of input.incidents) {
    if (row.kind === INCIDENT_KIND_EXCLUDED) continue;
    out.push({
      key: bandKey("incident_spike", row.kind),
      bandId: "incident_spike",
      repoPath: null,
      subject: row.kind,
      value: row.occurrences,
      // Sample size for this band IS the distinct-session count — the dimension that separates a
      // systemic class from one thrashing task.
      sampleN: row.sessions,
      tier: incidentTier(row, thresholds.incident_spike),
      belowMinSample: false,
      evaluatedAt: now,
    });
  }

  // ── first_pass_collapse (per repo) ──────────────────────────────────────────
  const fpCfg = thresholds.first_pass_collapse;
  for (const repo of input.repos) {
    const { value, n } = repo.firstPassRate;
    // `value === null` means no reviewed merged task at all in the window — no measurement, so the
    // band is below sample by definition rather than at 0%.
    const belowMin = value === null || n < fpCfg.minSample;
    out.push({
      key: bandKey("first_pass_collapse", repo.repoPath),
      bandId: "first_pass_collapse",
      repoPath: repo.repoPath,
      subject: repo.repo,
      value: value ?? 0,
      sampleN: n,
      tier: belowMin ? 0 : tierForLowerIsWorse(value, fpCfg),
      belowMinSample: belowMin,
      evaluatedAt: now,
    });
  }

  // ── dead_code_drift (global, self repo) ─────────────────────────────────────
  const dcCfg = thresholds.dead_code_drift;
  const dc = input.deadCode;
  out.push({
    key: bandKey("dead_code_drift"),
    bandId: "dead_code_drift",
    repoPath: null,
    subject: null,
    value: dc?.autoFixable ?? 0,
    // Total findings, not a denominator: the lens shows "N of M", where M-N are the ones fallow
    // will not touch (unused FILES, which it marks not-auto-fixable) and a human still owns.
    sampleN: dc?.total ?? 0,
    tier: dc === null ? 0 : promote(countTier(dc.autoFixable, dcCfg), dcCfg.tier3),
    // A fallow that could not be run or read is "no data", NEVER a clear 0 — see
    // parseDeadCodeReport.
    belowMinSample: dc === null,
    evaluatedAt: now,
  });

  return out;
}

/** Highest tier a count crosses. Shares the higher-is-worse direction with the rate bands. */
function countTier(value: number, cfg: CountBandConfig): MaintainTier {
  if (value >= cfg.tier2) return 2;
  if (value >= cfg.tier1) return 1;
  return 0;
}

/** Breached readings, most severe first — the order Tier-2 candidates are considered in. */
export function breaches(readings: BandReading[]): BandReading[] {
  return readings
    .filter((r) => r.tier > 0)
    .sort((a, b) => b.tier - a.tier || a.key.localeCompare(b.key));
}

/** One-line rendering of a reading, for the Tier-1 log and for the diagnosis prompt's headline. */
export function describeReading(r: BandReading): string {
  const where = r.subject ? ` [${r.subject}]` : "";
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  let value: string;
  if (r.bandId === "incident_spike") {
    value = `${r.value} occurrence(s) across ${r.sampleN} session(s)`;
  } else if (r.bandId === "dead_code_drift") {
    value = `${r.value} auto-fixable of ${r.sampleN} finding(s)`;
  } else {
    value = `${pct(r.value)} (n=${r.sampleN})`;
  }
  return `${r.bandId}${where}: ${value} → tier ${r.tier}`;
}

// ── diagnosis prompt ─────────────────────────────────────────────────────────

/** Caps on the evidence block. The prompt ships as an argv positional under a hard byte budget
 *  (see prompt-budget.ts), so evidence is bounded BEFORE assembly rather than clamped after. */
const MAX_EVIDENCE_ITEMS = 12;
const MAX_EVIDENCE_CHARS = 600;

/** One captured signal offered to the diagnosis agent as evidence. `payload` is agent-written
 *  terminal text — UNTRUSTED, and fenced as such. */
export interface EvidenceLine {
  kind: string;
  repo: string;
  ts: number;
  payload: string;
}

function renderEvidence(evidence: EvidenceLine[]): string {
  if (evidence.length === 0) return "(no captured signal payloads for this band)";
  return evidence
    .slice(0, MAX_EVIDENCE_ITEMS)
    .map((e, i) => {
      const head = `[${i + 1}] kind=${e.kind} repo=${e.repo} at=${new Date(e.ts).toISOString()}`;
      const body = e.payload.slice(0, MAX_EVIDENCE_CHARS);
      return `${head}\n${fenceUntrusted(`signal ${i + 1}`, body)}`;
    })
    .join("\n\n");
}

/**
 * The Tier-2 diagnosis agent's task. It runs read-only in a disposable detached worktree of
 * Shepherd's OWN checkout under `--permission-mode dontAsk` with the `reviewer` allowlist, so it
 * can read and grep but cannot exec, commit, push, or reach a forge. Its ONLY deliverable is the
 * draft file; the trusted server decides whether that becomes an issue.
 */
export function buildDiagnosisPrompt(opts: {
  reading: BandReading;
  evidence: EvidenceLine[];
  thresholdNote: string;
}): string {
  const { reading, evidence, thresholdNote } = opts;
  const windowDays = windowDaysFor(reading.bandId);
  return [
    "You are diagnosing a health-band breach in Shepherd itself. Shepherd is an interactive",
    "mission-control for Claude Code sessions; this checkout is Shepherd's own source.",
    "",
    UNTRUSTED_CONTENT_DIRECTIVE,
    "",
    "## The breach",
    "",
    `Band: ${reading.bandId}${reading.subject ? ` (${reading.subject})` : ""}`,
    `Measured: ${describeReading(reading)}`,
    `Window: the last ${windowDays} days`,
    `Thresholds: ${thresholdNote}`,
    "",
    "## Evidence",
    "",
    renderEvidence(evidence),
    "",
    "## Your task",
    "",
    "Read this repository to work out WHAT most plausibly causes this band to be breached. Ground",
    "every claim in code you actually read — name the file and symbol. You are diagnosing, not",
    "fixing: do not edit anything, and do not propose a patch.",
    "",
    "State honestly what you could not determine. A short diagnosis that admits its gaps is worth",
    "far more than a confident guess; if the evidence does not support a cause, say so.",
    "",
    "## Deliverable",
    "",
    `Write ${MAINTAIN_DRAFT_FILE} in the repository root. Nothing else. It must be valid JSON:`,
    "",
    "{",
    '  "title": "<one line, <=120 chars, imperative, names the subsystem>",',
    '  "anomaly": "<what the numbers show, 1-3 sentences>",',
    '  "evidence": "<what in the code/signals supports the diagnosis; cite file + symbol>",',
    '  "subsystem": "<the module or subsystem most likely responsible>",',
    '  "openQuestions": ["<what a human must decide or check>", "..."]',
    "}",
    "",
    "Escape every double quote INSIDE a string value. An unescaped quote makes the file",
    "unparseable and the whole diagnosis is discarded.",
  ].join("\n");
}

// ── draft parsing ────────────────────────────────────────────────────────────

const MAX_TITLE_CHARS = 120;
const MAX_SECTION_CHARS = 4000;
const MAX_OPEN_QUESTIONS = 8;

export interface MaintainDraft {
  title: string;
  anomaly: string;
  evidence: string;
  subsystem: string;
  openQuestions: string[];
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Read + clamp the agent's draft as a 3-way {@link VerdictRead}, the same contract the recap and
 * critic finalize loops use.
 *
 * `repaired` is CARRIED, not swallowed. `tolerantParseJson` will happily run jsonrepair over a
 * truncated mid-write file and hand back a shape-valid object — so a draft caught halfway through
 * writing would otherwise finalize as a real diagnosis, kill the pane mid-turn, and (with `act` on)
 * file a truncated issue that the 14-day cooldown then holds. The caller gates a repaired parse on
 * spawn liveness via `decideVerdictAction`; a strict parse is trusted immediately.
 *
 * A present-but-shapeless draft (no title, or no anomaly) is `unparseable`, not `absent`: it is not
 * a diagnosis, and reporting it as absent would make the finalize loop wait out the whole timeout
 * for a file that is never going to improve.
 */
export function readMaintainDraft(text: string | null): VerdictRead<MaintainDraft> {
  if (text === null) return { status: "absent" };
  const parsed = tolerantParseJson(text);
  if (parsed.status !== "ok" || parsed.value === null || typeof parsed.value !== "object") {
    return { status: "unparseable", raw: text };
  }
  const draft = clampDraft(parsed.value as Record<string, unknown>);
  return draft === null
    ? { status: "unparseable", raw: text }
    : { status: "parsed", value: draft, repaired: parsed.repaired };
}

/** Shape-check + clamp a parsed draft object; null when it is not a diagnosis at all. */
function clampDraft(o: Record<string, unknown>): MaintainDraft | null {
  const title = str(o.title).replace(/\s+/g, " ").slice(0, MAX_TITLE_CHARS);
  const anomaly = str(o.anomaly).slice(0, MAX_SECTION_CHARS);
  if (!title || !anomaly) return null;
  const openQuestions = (Array.isArray(o.openQuestions) ? o.openQuestions : [])
    .map(str)
    .filter((q) => q.length > 0)
    .slice(0, MAX_OPEN_QUESTIONS)
    .map((q) => q.slice(0, MAX_TITLE_CHARS * 4));
  return {
    title,
    anomaly,
    evidence: str(o.evidence).slice(0, MAX_SECTION_CHARS),
    subsystem: str(o.subsystem).slice(0, MAX_TITLE_CHARS),
    openQuestions,
  };
}

/**
 * Render the drafted issue's body. The provenance footer is not decoration: an operator triaging
 * this in the backlog must be able to tell at a glance that a machine opened it, off which band,
 * and on what measurement — and the agent-written prose above it is a HYPOTHESIS, not a finding.
 */
export function renderIssueBody(draft: MaintainDraft, reading: BandReading): string {
  const lines = [
    "> Opened automatically by Shepherd's maintain loop. The diagnosis below is a read-only",
    "> agent's hypothesis — verify it before acting.",
    "",
    "## Anomaly",
    "",
    draft.anomaly,
  ];
  if (draft.evidence) lines.push("", "## Evidence", "", draft.evidence);
  if (draft.subsystem) lines.push("", "## Affected subsystem", "", draft.subsystem);
  if (draft.openQuestions.length > 0) {
    lines.push("", "## Open questions", "", ...draft.openQuestions.map((q) => `- ${q}`));
  }
  lines.push(
    "",
    "---",
    "",
    `Band \`${reading.key}\` · ${describeReading(reading)} · measured ${new Date(
      reading.evaluatedAt,
    ).toISOString()}`,
  );
  return lines.join("\n");
}

// ── tier 3: the dead-code fix ────────────────────────────────────────────────

/** Commit subject and PR title for a Tier-3 dead-code fix. Conventional-commit shaped: the repo's
 *  `pr-title` workflow gates PR titles, and this one is opened without a human to fix it. */
export const DEAD_CODE_COMMIT_MSG = "chore(maintain): remove auto-fixable dead code";

/**
 * The Tier-3 PR body.
 *
 * Says three things an operator needs before reading the diff: a machine opened this, the diff is
 * `fallow fix`'s output rather than anyone's judgement, and the non-auto-fixable findings this run
 * deliberately left alone are still there. The pinned fallow version is named because the diff is
 * only reproducible against it.
 */
export function renderFixPrBody(
  before: DeadCodeReading,
  reading: BandReading,
  packages: FixPackage[],
): string {
  const remaining = before.total - before.autoFixable;
  const checked = packages.map((p) => `\`${p}\``).join(", ") || "none";
  const lines = [
    "> Opened automatically by Shepherd's maintain loop (tier 3). The diff is the verbatim output",
    `> of \`fallow fix\` — no agent wrote it. Review it as you would any deletion.`,
    "",
    "## What this removes",
    "",
    `${describeDeadCode(before)} — found by \`fallow@${FALLOW_VERSION} dead-code\` against this`,
    "repository's `.fallowrc.jsonc`.",
    "",
    "## Verified before opening",
    "",
    "- `bun install --frozen-lockfile` in the root, `ui/` and `extension/` — without installed",
    "  dependencies fallow cannot resolve imports and reports findings that are not real.",
    `- The type-check of every package this diff touches (${checked}) passes. The root`,
    "  `tsc` excludes `ui` and `extension`, so each is checked with its own command.",
    "- A re-run of `fallow dead-code` reports no auto-fixable findings left.",
  ];
  if (remaining > 0) {
    lines.push(
      "",
      "## Left alone",
      "",
      `${remaining} finding(s) are not auto-fixable — fallow flags unused FILES as unsafe to delete`,
      "automatically, because deletion can remove runtime behaviour static analysis cannot see.",
      "Those remain for a human.",
    );
  }
  lines.push(
    "",
    "---",
    "",
    `Band \`${reading.key}\` · ${describeReading(reading)} · measured ${new Date(
      reading.evaluatedAt,
    ).toISOString()}`,
  );
  return lines.join("\n");
}
