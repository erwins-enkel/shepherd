/**
 * Pure helpers for the maintain loop (#2157, from #2151 R5) — no I/O, no DB, no spawn.
 * Mirrors `critic-core.ts`: thresholds, evaluation, prompt, parse + clamp.
 *
 * Shepherd's Stage-6 machinery notifies and stops. This closes the loop with tiered thresholds on
 * Shepherd's OWN health data:
 *   Tier 1 — log the reading.
 *   Tier 2 — spawn a read-only diagnosis agent that drafts a backlog issue.
 * Tier 3 (open a PR for a pre-approved fix class) is deliberately absent — the only such class the
 * report names is doc drift, which the doc agent already owns.
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

/** How long a band is suppressed after a diagnosis run COMPLETES, whatever its outcome. */
export const DEFAULT_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;

/** At most this many Tier-2 diagnosis spawns per sweep. The rest wait for the next day. */
export const MAX_DIAGNOSES_PER_SWEEP = 1;

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

export interface BandThresholds {
  critic_error_rate: RateBandConfig;
  incident_spike: IncidentBandConfig;
  first_pass_collapse: RateBandConfig;
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
  };
}

/** Parse the env override; any failure yields the defaults untouched. */
export function thresholdsFromEnv(raw: string | undefined): BandThresholds {
  if (!raw?.trim()) return DEFAULT_BAND_THRESHOLDS;
  const parsed = tolerantParseJson(raw);
  if (parsed.status !== "ok") return DEFAULT_BAND_THRESHOLDS;
  return mergeThresholds(parsed.value);
}

/** What one sweep measured, assembled by the caller from the store + delivery metrics. */
export interface BandInput {
  /** Outcome-bearing review spawns in the critic window. */
  reviewOutcomes: { verdicts: number; errors: number };
  /** In-window `signals` grouped by kind. */
  incidents: DeliveryIncidentRow[];
  /** Per-repo delivery rows over `FIRST_PASS_RANGE`. */
  repos: DeliveryRepoRow[];
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

/** The measurement window a band is scored over, in days — what the diagnosis prompt must state.
 *  `first_pass_collapse` reads the 30d delivery range; the other two use their 7d windows. Derived
 *  here rather than passed by the caller so the prompt can never quote a window the band does not
 *  actually use (which would land in the filed issue as the agent's reasoning). */
export function windowDaysFor(bandId: BandId): number {
  if (bandId === "first_pass_collapse") return FIRST_PASS_WINDOW_DAYS;
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

  return out;
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
  const value =
    r.bandId === "incident_spike"
      ? `${r.value} occurrence(s) across ${r.sampleN} session(s)`
      : `${pct(r.value)} (n=${r.sampleN})`;
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
