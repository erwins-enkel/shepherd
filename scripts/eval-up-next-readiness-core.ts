// Pure metrics for the Up Next readiness eval (#2535). No I/O, no network — unit-tested in
// `test/eval-up-next-readiness.test.ts`; the runner is `scripts/eval-up-next-readiness.ts`.
//
// The question the eval answers: inside ONE Up Next group, does "readiness band first, then today's
// order" put ready issues nearer the top than today's order alone? Real historic group compositions
// are unknowable, so groups are SIMULATED: seeded random draws from one repo's labelled pool, ordered
// both ways, scored by precision@N (share of the top-N slots holding a ready issue).

import { compareInRepo, type UpNextKind } from "../src/up-next-core";
import { BAND_RANK, band } from "../src/up-next-readiness-core";
import { auroc, type AurocResult } from "./eval-jev";

export type ReadinessLabel = "ready" | "notReady";

export interface ReadinessFixture {
  /** Repo slug or path — the grouping key. */
  repo: string;
  number: number;
  title: string;
  body: string;
  labels: string[];
  createdAt: number;
  kind: UpNextKind;
  label: ReadinessLabel;
  /** Cached judge scores keyed by {@link scoreKey}; null = asked but no usable answer. */
  scores?: Record<string, number | null>;
  /** The score under evaluation, resolved from `scores` for one key (see {@link withScores}). */
  p?: number | null;
}

/** One cached score per (model, question variant) — a re-pin or a new variant never reuses one. */
export function scoreKey(model: string, variant: string): string {
  return `${model}|${variant}`;
}

/** Fixtures that carry a usable score under `key`, with `p` resolved to it. */
export function withScores(fixtures: ReadinessFixture[], key: string): ReadinessFixture[] {
  return fixtures.flatMap((f) => {
    const p = f.scores?.[key];
    return typeof p === "number" ? [{ ...f, p }] : [];
  });
}

export type Split = "dev" | "holdout";

/** Stable ⅔ dev / ⅓ holdout split by FNV-1a over repo#number — independent of fixture order, so a
 *  regenerated set keeps every surviving fixture on the same side. Variants are CHOSEN on dev; the
 *  holdout is looked at once, for the winner. */
export function splitOf(f: Pick<ReadinessFixture, "repo" | "number">): Split {
  let h = 0x811c9dc5;
  for (const c of `${f.repo}#${f.number}`) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 3 === 0 ? "holdout" : "dev";
}

export interface Thresholds {
  readyAt: number;
  notReadyBelow: number;
}

export interface SimOptions extends Thresholds {
  draws: number;
  groupSize: number;
  topN: number;
  seed: number;
}

export const DEFAULT_SIM: Omit<SimOptions, keyof Thresholds> = {
  draws: 500,
  groupSize: 10,
  topN: 3,
  seed: 2535,
};

/** Minimum fixtures in EACH class before a GO can be called at all. */
export const MIN_PER_CLASS = 20;
export const GO_MIN_LIFT = 1.15;
export const GO_MIN_AUROC = 0.7;

/** mulberry32 — tiny, seeded, deterministic. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sample<T>(pool: T[], k: number, rand: () => number): T[] {
  const a = [...pool];
  const n = Math.min(k, a.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rand() * (a.length - i));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, n);
}

export function baselineOrder(group: ReadinessFixture[]): ReadinessFixture[] {
  return [...group].sort(compareInRepo);
}

export function bandedOrder(group: ReadinessFixture[], t: Thresholds): ReadinessFixture[] {
  const bandOf = (f: ReadinessFixture) => BAND_RANK[band(f.p ?? null, t.readyAt, t.notReadyBelow)];
  return [...group].sort((a, b) => bandOf(a) - bandOf(b) || compareInRepo(a, b));
}

function precisionAt(order: ReadinessFixture[], n: number): number {
  const top = order.slice(0, n);
  return top.filter((f) => f.label === "ready").length / top.length;
}

export interface SimResult {
  /** Draws that counted (the group held both classes — otherwise order cannot matter). */
  groups: number;
  baseline: number;
  banded: number;
  /** banded / baseline; null when the baseline is 0. */
  lift: number | null;
}

function liftOf(banded: number, baseline: number): number | null {
  return baseline > 0 ? banded / baseline : null;
}

export function groupByRepo(fixtures: ReadinessFixture[]): Map<string, ReadinessFixture[]> {
  const by = new Map<string, ReadinessFixture[]>();
  for (const f of fixtures) (by.get(f.repo) ?? by.set(f.repo, []).get(f.repo)!).push(f);
  return by;
}

/** Simulate groups from one pool. PURE given the seed. */
export function simulatePool(pool: ReadinessFixture[], opts: SimOptions): SimResult {
  const rand = rng(opts.seed);
  let groups = 0;
  let base = 0;
  let banded = 0;
  const hasBoth = pool.some((f) => f.label === "ready") && pool.some((f) => f.label === "notReady");
  if (pool.length > opts.topN && hasBoth) {
    for (let d = 0; d < opts.draws; d++) {
      const g = sample(pool, opts.groupSize, rand);
      if (!g.some((f) => f.label === "ready") || !g.some((f) => f.label === "notReady")) continue;
      groups++;
      base += precisionAt(baselineOrder(g), opts.topN);
      banded += precisionAt(bandedOrder(g, opts), opts.topN);
    }
  }
  const b = groups ? base / groups : 0;
  const j = groups ? banded / groups : 0;
  return { groups, baseline: b, banded: j, lift: liftOf(j, b) };
}

/** Group-weighted overall result across every repo pool. */
export function simulate(
  fixtures: ReadinessFixture[],
  opts: SimOptions,
): {
  overall: SimResult;
  perRepo: Map<string, SimResult>;
} {
  const perRepo = new Map<string, SimResult>();
  let groups = 0;
  let base = 0;
  let banded = 0;
  for (const [repo, pool] of groupByRepo(fixtures)) {
    const r = simulatePool(pool, opts);
    perRepo.set(repo, r);
    groups += r.groups;
    base += r.baseline * r.groups;
    banded += r.banded * r.groups;
  }
  const b = groups ? base / groups : 0;
  const j = groups ? banded / groups : 0;
  return { overall: { groups, baseline: b, banded: j, lift: liftOf(j, b) }, perRepo };
}

/** AUROC of p (ready = positive). Unscored fixtures are left out. */
export function readinessAuroc(fixtures: ReadinessFixture[]): AurocResult {
  return auroc(
    fixtures
      .filter((f) => typeof f.p === "number")
      .map((f) => ({ score: f.p as number, correct: f.label === "ready" })),
  );
}

export const SWEEP_READY_AT = [0.5, 0.6, 0.7];
export const SWEEP_NOT_READY_BELOW = [0.2, 0.3, 0.4];

export interface SweepRow extends Thresholds {
  result: SimResult;
}

export function thresholdSweep(
  fixtures: ReadinessFixture[],
  base: Omit<SimOptions, keyof Thresholds> = DEFAULT_SIM,
): SweepRow[] {
  const rows: SweepRow[] = [];
  for (const readyAt of SWEEP_READY_AT) {
    for (const notReadyBelow of SWEEP_NOT_READY_BELOW) {
      if (notReadyBelow >= readyAt) continue;
      const t = { readyAt, notReadyBelow };
      rows.push({ ...t, result: simulate(fixtures, { ...base, ...t }).overall });
    }
  }
  return rows;
}

export interface Decision {
  go: boolean;
  reasons: string[];
}

export function decide(fixtures: ReadinessFixture[], sim: SimResult, roc: AurocResult): Decision {
  const reasons: string[] = [];
  const ready = fixtures.filter((f) => f.label === "ready").length;
  const notReady = fixtures.length - ready;
  if (ready < MIN_PER_CLASS || notReady < MIN_PER_CLASS) {
    reasons.push(`too few fixtures per class (need ≥${MIN_PER_CLASS} each)`);
  }
  if (sim.lift === null || sim.lift < GO_MIN_LIFT) {
    reasons.push(`ready@N lift below ${GO_MIN_LIFT}×`);
  }
  if (roc.auroc === null || roc.auroc < GO_MIN_AUROC) {
    reasons.push(`AUROC below ${GO_MIN_AUROC}`);
  }
  return { go: reasons.length === 0, reasons };
}
