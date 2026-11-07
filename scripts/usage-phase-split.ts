/**
 * Plan/execute phase cost split for plan-gated sessions (#1951, measure-first for R1).
 *
 * Splits one Claude transcript at the plan gate's Go steer into a planning and an execution phase,
 * then prices R1 counterfactuals over the execution phase — all UPPER BOUNDS, holding the
 * recorded token counts fixed:
 *   - tier:     the same execution tokens re-priced at a cheaper executor model;
 *   - reset:    a fresh executor that never carries the planning context past Go. Each main-thread
 *               execution turn handles `contextAtGo − opener` fewer prefix tokens — taken from its
 *               cache reads first, then from its cache writes (a cold rebuild re-writes the prefix).
 *               The fresh agent pays one cold opener write, unless the first execution turn was
 *               itself a cold rebuild, whose trimmed write already stands in for it;
 *   - combined: both;
 *   - inPane:   tier via an in-pane model switch, which keeps the context but cannot reuse the old
 *               model's prompt cache — one cold rebuild of `contextAtGo` at the executor model
 *               (again unless the first execution turn was already cold).
 * Pure: no FS or DB. `scripts/usage-report.ts --phase-split` feeds it transcripts and DB rows.
 * Cost-units are the RELATIVE per-Mtok proxy from src/pricing.ts — never dollars.
 */
import { parseLine, type ParsedRecord } from "../src/usage";
import { weightedUnits, coldResumeUnits, MAIN_SESSION_CACHE_TTL } from "../src/pricing";

/** Leading text of every Go steer (`planGoSteer` in src/service.ts; drift-guarded by its test). */
export const GO_MARKER = "Plan approved. Execute `.shepherd-plan.md` now";
/** Leading text of the re-gate steer (`PLAN_REGATE_STEER` in src/service.ts). */
const REGATE_MARKER = "STOP implementing. Your plan was edited";
/** Shepherd delivers steers by paste, so Claude Code may record them inside this wrapper. */
const PASTE_WRAPPER = /^<pasted_content\b[^>]*>\s*/;
/** The model the tier counterfactual re-prices execution at (Sonnet 5.5 pricing row). */
export const EXECUTOR_MODEL = "claude-sonnet-5-5";
/** Rough chars-per-token for sizing the plan a fresh executor would read. */
const CHARS_PER_TOKEN = 4;

export interface TokenSums {
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  units: number;
}

export interface PhaseSplit {
  planning: TokenSums;
  execution: TokenSums;
  /** Context of the last main-thread request before Go — what execution keeps re-reading. */
  contextAtGo: number;
  /** Context of the first main-thread request (system prompt + task) — a fresh agent's floor. */
  openerContext: number;
  /** Estimated tokens of the last `.shepherd-plan.md` Write before Go (0 when none was seen). */
  planTokens: number;
  planSizeKnown: boolean;
  /** A re-gate steer arrived after Go; everything after the first Go still counts as execution. */
  regated: boolean;
  /** Deduped execution-phase usage records (main thread AND sidechains). */
  execRecords: ParsedRecord[];
}

function emptySums(): TokenSums {
  return { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, units: 0 };
}

function addRecord(sums: TokenSums, r: ParsedRecord): void {
  sums.requests++;
  sums.input += r.input;
  sums.output += r.output;
  sums.cacheRead += r.cacheRead;
  sums.cacheWrite += r.cacheWrite5m + r.cacheWrite1h;
  sums.units += weightedUnits(r, r.model);
}

function contextOf(r: ParsedRecord): number {
  return r.input + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h;
}

interface RawLine {
  type?: unknown;
  isSidechain?: unknown;
  message?: { content?: unknown };
}

function parseRaw(line: string): RawLine | null {
  const t = line.trim();
  if (!t) return null;
  try {
    const o: unknown = JSON.parse(t);
    return o && typeof o === "object" ? (o as RawLine) : null;
  } catch {
    return null;
  }
}

/** A main-thread user turn's text (string content, or its text blocks), else null. */
function userText(o: RawLine): string | null {
  if (o.type !== "user" || o.isSidechain === true) return null;
  const c = o.message?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return null;
  return c
    .map((p) => (p && typeof p === "object" ? ((p as { text?: unknown }).text ?? "") : ""))
    .filter((t): t is string => typeof t === "string")
    .join(" ");
}

function steerStartsWith(text: string, marker: string): boolean {
  return text.trim().replace(PASTE_WRAPPER, "").startsWith(marker);
}

/** Token estimate of a `.shepherd-plan.md` Write in this assistant line, else null. */
function planWriteTokens(o: RawLine): number | null {
  const c = o.message?.content;
  if (o.type !== "assistant" || !Array.isArray(c)) return null;
  let found: number | null = null;
  for (const p of c as { type?: unknown; name?: unknown; input?: unknown }[]) {
    if (p?.type !== "tool_use" || p.name !== "Write") continue;
    const input = p.input as { file_path?: unknown; content?: unknown } | undefined;
    if (typeof input?.file_path !== "string" || !input.file_path.endsWith(".shepherd-plan.md"))
      continue;
    if (typeof input.content === "string")
      found = Math.ceil(input.content.length / CHARS_PER_TOKEN);
  }
  return found;
}

interface Walk {
  split: PhaseSplit;
  goSeen: boolean;
  openerSeen: boolean;
  lastMainContext: number;
  seen: Set<string>;
}

function onUser(w: Walk, text: string): void {
  if (!w.goSeen && steerStartsWith(text, GO_MARKER)) {
    w.goSeen = true;
    w.split.contextAtGo = w.lastMainContext;
  } else if (w.goSeen && steerStartsWith(text, REGATE_MARKER)) {
    w.split.regated = true;
  }
}

function onUsage(w: Walk, r: ParsedRecord): void {
  if (r.requestId) {
    if (w.seen.has(r.requestId)) return;
    w.seen.add(r.requestId);
  }
  addRecord(w.goSeen ? w.split.execution : w.split.planning, r);
  if (w.goSeen) w.split.execRecords.push(r);
  if (r.isSidechain) return;
  if (!w.openerSeen) {
    w.openerSeen = true;
    w.split.openerContext = contextOf(r);
  }
  if (!w.goSeen) w.lastMainContext = contextOf(r);
}

function onAssistant(w: Walk, o: RawLine, line: string): void {
  if (!w.goSeen) {
    const plan = planWriteTokens(o);
    if (plan !== null) {
      w.split.planTokens = plan;
      w.split.planSizeKnown = true;
    }
  }
  const r = parseLine(line);
  if (r) onUsage(w, r);
}

/** Split a transcript at its first Go steer, or null when it never received one. */
export function phaseSplit(lines: Iterable<string>): PhaseSplit | null {
  const w: Walk = {
    split: {
      planning: emptySums(),
      execution: emptySums(),
      contextAtGo: 0,
      openerContext: 0,
      planTokens: 0,
      planSizeKnown: false,
      regated: false,
      execRecords: [],
    },
    goSeen: false,
    openerSeen: false,
    lastMainContext: 0,
    seen: new Set(),
  };
  for (const line of lines) {
    const o = parseRaw(line);
    if (!o) continue;
    if (o.type === "assistant") onAssistant(w, o, line);
    else {
      const text = userText(o);
      if (text !== null) onUser(w, text);
    }
  }
  return w.goSeen ? w.split : null;
}

export interface Counterfactuals {
  /** Execution-phase cost as recorded. */
  actual: number;
  tier: number;
  reset: number;
  combined: number;
  inPane: number;
}

function dominantModel(records: ParsedRecord[]): string {
  const units = new Map<string, number>();
  for (const r of records)
    units.set(r.model, (units.get(r.model) ?? 0) + weightedUnits(r, r.model));
  let best = "unknown";
  let max = -1;
  for (const [m, u] of units)
    if (u > max) {
      best = m;
      max = u;
    }
  return best;
}

/** A turn that wrote more than half its context re-built the prompt cache (cold). */
function isColdRebuild(r: ParsedRecord): boolean {
  return r.cacheWrite5m + r.cacheWrite1h > contextOf(r) / 2;
}

/** `r` without up to `carried` prefix tokens: from cache reads first, then cache writes (1h, 5m). */
function withoutCarried(r: ParsedRecord, carried: number): ParsedRecord {
  const read = Math.min(r.cacheRead, carried);
  const w1h = Math.min(r.cacheWrite1h, carried - read);
  const w5m = Math.min(r.cacheWrite5m, carried - read - w1h);
  return {
    ...r,
    cacheRead: r.cacheRead - read,
    cacheWrite1h: r.cacheWrite1h - w1h,
    cacheWrite5m: r.cacheWrite5m - w5m,
  };
}

/** Execution-phase cost under each R1 scenario (see the module comment). No main-thread execution
 *  turn (Go was the last thing that happened) means nothing to respawn: every scenario = actual. */
export function counterfactuals(s: PhaseSplit): Counterfactuals {
  const actual = s.execRecords.reduce((acc, r) => acc + weightedUnits(r, r.model), 0);
  const main = s.execRecords.filter((r) => !r.isSidechain);
  if (!main.length)
    return { actual, tier: actual, reset: actual, combined: actual, inPane: actual };
  const opener = s.openerContext + s.planTokens;
  const carried = Math.max(0, s.contextAtGo - opener);
  const cf: Counterfactuals = { actual, tier: 0, reset: 0, combined: 0, inPane: 0 };
  for (const r of s.execRecords) {
    const fresh = r.isSidechain ? r : withoutCarried(r, carried);
    cf.tier += weightedUnits(r, EXECUTOR_MODEL);
    cf.reset += weightedUnits(fresh, r.model);
    cf.combined += weightedUnits(fresh, EXECUTOR_MODEL);
  }
  cf.inPane = cf.tier;
  if (!isColdRebuild(main[0]!)) {
    cf.reset += coldResumeUnits(opener, dominantModel(main), MAIN_SESSION_CACHE_TTL);
    cf.combined += coldResumeUnits(opener, EXECUTOR_MODEL, MAIN_SESSION_CACHE_TTL);
    cf.inPane += coldResumeUnits(s.contextAtGo, EXECUTOR_MODEL, MAIN_SESSION_CACHE_TTL);
  }
  return cf;
}

export type Cohort = "switched" | "baseline";

/** `switched` = the #3434 execution effort is the one in force at archive and differs from the
 *  planning effort; every other gated session is `baseline`. */
export function cohortOf(row: {
  executionEffort: string | null;
  activeEffort: string | null;
  effort: string | null;
}): Cohort {
  return row.executionEffort !== null &&
    row.activeEffort === row.executionEffort &&
    row.activeEffort !== row.effort
    ? "switched"
    : "baseline";
}

export interface PhaseRow {
  desig: string;
  model: string;
  cohort: Cohort;
  split: PhaseSplit;
  cf: Counterfactuals;
  /** Whole-transcript cost (planning + execution). */
  total: number;
}

export function phaseRow(
  meta: { desig: string; model: string; cohort: Cohort },
  split: PhaseSplit,
): PhaseRow {
  return {
    ...meta,
    split,
    cf: counterfactuals(split),
    total: split.planning.units + split.execution.units,
  };
}

export interface CohortSummary {
  cohort: Cohort | "all";
  n: number;
  total: number;
  /** Σ execution cost ÷ Σ total cost. */
  execShare: number;
  execShareMedian: number;
  execCostPerReqMedian: number;
  execOutputPerReqMedian: number;
  /** Σ (actual − scenario) ÷ Σ total cost, per scenario. */
  tierPct: number;
  resetPct: number;
  combinedPct: number;
  inPanePct: number;
  regated: number;
  planUnknown: number;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function ratio(a: number, b: number): number {
  return b > 0 ? a / b : 0;
}

function sumOf(rows: PhaseRow[], f: (r: PhaseRow) => number): number {
  return rows.reduce((acc, r) => acc + f(r), 0);
}

function summarize(cohort: CohortSummary["cohort"], rows: PhaseRow[]): CohortSummary {
  const total = sumOf(rows, (r) => r.total);
  const saved = (f: (cf: Counterfactuals) => number) =>
    ratio(
      sumOf(rows, (r) => r.cf.actual - f(r.cf)),
      total,
    );
  const perReq = (f: (e: TokenSums) => number) =>
    median(rows.map((r) => ratio(f(r.split.execution), r.split.execution.requests)));
  return {
    cohort,
    n: rows.length,
    total,
    execShare: ratio(
      sumOf(rows, (r) => r.split.execution.units),
      total,
    ),
    execShareMedian: median(rows.map((r) => ratio(r.split.execution.units, r.total))),
    execCostPerReqMedian: perReq((e) => e.units),
    execOutputPerReqMedian: perReq((e) => e.output),
    tierPct: saved((cf) => cf.tier),
    resetPct: saved((cf) => cf.reset),
    combinedPct: saved((cf) => cf.combined),
    inPanePct: saved((cf) => cf.inPane),
    regated: rows.filter((r) => r.split.regated).length,
    planUnknown: rows.filter((r) => !r.split.planSizeKnown).length,
  };
}

/** One summary per cohort, then the pooled `all` row. */
export function cohortSummary(rows: PhaseRow[]): CohortSummary[] {
  return [
    summarize(
      "switched",
      rows.filter((r) => r.cohort === "switched"),
    ),
    summarize(
      "baseline",
      rows.filter((r) => r.cohort === "baseline"),
    ),
    summarize("all", rows),
  ];
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const units = (x: number) => x.toFixed(3);
const int = (x: number) => Math.round(x).toLocaleString("en-US");

export const PHASE_HEADERS = [
  "Task",
  "Cohort",
  "Model",
  "Plan cost*",
  "Exec cost*",
  "Exec share",
  "Exec req",
  "Ctx@Go",
  "Opener",
  "Tier save",
  "Reset save",
  "Both save",
  "Flags",
];

export function phaseRowCells(r: PhaseRow): string[] {
  const s = r.split;
  const save = (x: number) => pct(ratio(r.cf.actual - x, r.total));
  const flags = [s.regated ? "regated" : "", s.planSizeKnown ? "" : "plan?"].filter(Boolean);
  return [
    r.desig,
    r.cohort,
    r.model,
    units(s.planning.units),
    units(s.execution.units),
    pct(ratio(s.execution.units, r.total)),
    String(s.execution.requests),
    int(s.contextAtGo),
    int(s.openerContext + s.planTokens),
    save(r.cf.tier),
    save(r.cf.reset),
    save(r.cf.combined),
    flags.join(" ") || "-",
  ];
}

export const SUMMARY_HEADERS = [
  "Cohort",
  "n",
  "Total cost*",
  "Exec share (Σ)",
  "Exec share (median)",
  "Exec cost*/req (median)",
  "Exec output/req (median)",
  "Tier save (Σ)",
  "Reset save (Σ)",
  "Both save (Σ)",
  "In-pane save (Σ)",
  "Regated",
  "Plan size unknown",
];

export function summaryCells(c: CohortSummary): string[] {
  return [
    c.cohort,
    String(c.n),
    units(c.total),
    pct(c.execShare),
    pct(c.execShareMedian),
    c.execCostPerReqMedian.toFixed(4),
    int(c.execOutputPerReqMedian),
    pct(c.tierPct),
    pct(c.resetPct),
    pct(c.combinedPct),
    pct(c.inPanePct),
    String(c.regated),
    String(c.planUnknown),
  ];
}

// ── Supporting tables (everything the research report cites) ─────────────────

export const KIND_HEADERS = [
  "Execution cost by kind",
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
];

/** Share of pooled execution-phase cost per token kind, each priced at its record's model. */
export function execKindCells(rows: PhaseRow[]): string[] {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  const k = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const row of rows)
    for (const r of row.split.execRecords) {
      k.input += weightedUnits({ ...zero, input: r.input }, r.model);
      k.output += weightedUnits({ ...zero, output: r.output }, r.model);
      k.cacheRead += weightedUnits({ ...zero, cacheRead: r.cacheRead }, r.model);
      k.cacheWrite += weightedUnits(
        { ...zero, cacheWrite5m: r.cacheWrite5m, cacheWrite1h: r.cacheWrite1h },
        r.model,
      );
    }
  const all = k.input + k.output + k.cacheRead + k.cacheWrite;
  return [
    `all (${rows.length})`,
    pct(ratio(k.input, all)),
    pct(ratio(k.output, all)),
    pct(ratio(k.cacheRead, all)),
    pct(ratio(k.cacheWrite, all)),
  ];
}

/** Nearest-rank percentile (`p` in 0..1). */
function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
}

export const DIST_HEADERS = ["Per session", "p10", "p50 (median)", "p90"];

export function distributionRows(rows: PhaseRow[]): string[][] {
  const opener = (r: PhaseRow) => r.split.openerContext + r.split.planTokens;
  const series: [string, (r: PhaseRow) => number][] = [
    ["Opener tokens (first request + plan)", opener],
    ["Context at Go (tokens)", (r) => r.split.contextAtGo],
    ["Carried planning context (tokens)", (r) => Math.max(0, r.split.contextAtGo - opener(r))],
    ["Execution requests", (r) => r.split.execution.requests],
  ];
  return series.map(([label, f]) => {
    const xs = rows.map(f);
    return [label, int(percentile(xs, 0.1)), int(median(xs)), int(percentile(xs, 0.9))];
  });
}

const LENGTH_BUCKETS: [string, number, number][] = [
  ["< 20", 0, 20],
  ["20–49", 20, 50],
  ["50–99", 50, 100],
  ["≥ 100", 100, Infinity],
];

export const BUCKET_HEADERS = [
  "Exec requests",
  "n",
  "Share of all cost",
  "Tier save",
  "Reset save",
  "Both save",
  "In-pane save",
];

/** Savings (share of the bucket's whole-session cost) by execution length. */
export function lengthBucketRows(rows: PhaseRow[]): string[][] {
  const grand = sumOf(rows, (r) => r.total);
  return LENGTH_BUCKETS.map(([label, lo, hi]) => {
    const b = rows.filter(
      (r) => r.split.execution.requests >= lo && r.split.execution.requests < hi,
    );
    const total = sumOf(b, (r) => r.total);
    const save = (f: (cf: Counterfactuals) => number) =>
      pct(
        ratio(
          sumOf(b, (r) => r.cf.actual - f(r.cf)),
          total,
        ),
      );
    return [
      label,
      String(b.length),
      pct(ratio(total, grand)),
      save((cf) => cf.tier),
      save((cf) => cf.reset),
      save((cf) => cf.combined),
      save((cf) => cf.inPane),
    ];
  });
}
