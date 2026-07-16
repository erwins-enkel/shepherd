import type { AccountUsageIndex } from "./usage";
import { isApiKeyMode } from "./spawn-auth";

export type WindowKey = "session5h" | "week";

const PERIOD_MS: Record<WindowKey, number> = {
  session5h: 5 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
};

const LOOKBACK_MS: Record<WindowKey, number> = {
  session5h: 60 * 60 * 1000, // 1h trailing window for the 5H projection
  week: 24 * 60 * 60 * 1000, // 24h trailing window for the WK projection
};
const WINDOW_LABEL: Record<WindowKey, "5H" | "WK"> = { session5h: "5H", week: "WK" };

/** Below this scraped %, inverting to a cap is too noisy — keep the prior cap instead. */
const MIN_CALIBRATION_PCT = 5;

/** Weekly-window % at/above which we escalate /usage calibration cadence: close enough to the
 *  subscription cap that paid extra-credit spend becomes plausible and a daily credit snapshot is
 *  too stale to trust. */
const CREDIT_WATCH_PCT = 90; // internal watermark for calibrateDelay; not part of the public API
export const CREDIT_WATCH_INTERVAL_MS = 15 * 60 * 1000; // escalated cadence near the cap
export const CALIBRATE_INTERVAL_MS = 24 * 60 * 60 * 1000; // normal daily cadence

/** Delay until the next `/usage` calibration, given the latest live limits. Escalates to the
 *  watch cadence while the weekly window is near its cap so credit spend stays fresh. */
export function calibrateDelay(limits: UsageLimits): number {
  return (limits.week?.pct ?? 0) >= CREDIT_WATCH_PCT
    ? CREDIT_WATCH_INTERVAL_MS
    : CALIBRATE_INTERVAL_MS;
}

export interface ScrapedWindow {
  pct: number;
  resetAt: number | null;
  resetLabel: string | null;
}
/** A model-scoped weekly gauge ("Current week (Fable)") — a passthrough sub-limit keyed by model. */
export interface ScrapedModelWindow extends ScrapedWindow {
  model: string;
}
/** The "Usage credits" panel: paid pay-as-you-go overage spend against a monthly budget. */
export interface ScrapedCredit {
  pct: number;
  spent: number;
  cap: number;
  currency: string;
  resetAt: number | null;
  resetLabel: string | null;
}
export interface ScrapedUsage {
  session5h: ScrapedWindow | null;
  week: ScrapedWindow | null;
  perModelWeek: ScrapedModelWindow[];
  credits: ScrapedCredit | null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function to24h(h: number, ampm?: string): number {
  if (!ampm) return h;
  const pm = ampm.toLowerCase() === "pm";
  if (h === 12) return pm ? 12 : 0;
  return pm ? h + 12 : h;
}

/** Parse a `/usage` reset label ("9:30pm", "Jun 6, 5pm", "Jun 11 at 11pm") to a ms epoch in local time. */
export function parseResetLabel(label: string, now: number): number | null {
  const s = label.replace(/\s+/g, "").toLowerCase();
  let m = s.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/);
  if (m) {
    const d = new Date(now);
    d.setHours(to24h(+m[1]!, m[3]), m[2] ? +m[2] : 0, 0, 0);
    // reset labels always point forward — a time-of-day already past means tomorrow
    if (d.getTime() < now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  m = s.match(/^([a-z]{3})(\d{1,2})(?:(?:,|at)(\d{1,2})(?::(\d{2}))?(am|pm))?$/);
  if (m) {
    const mon = MONTHS.indexOf(m[1]!);
    if (mon < 0) return null;
    const d = new Date(now);
    d.setMonth(mon, +m[2]!);
    d.setHours(m[3] ? to24h(+m[3], m[5]) : 0, m[4] ? +m[4] : 0, 0, 0);
    // a month/day already past means next year (Dec scrape, Jan reset)
    if (d.getTime() < now) d.setFullYear(d.getFullYear() + 1);
    return d.getTime();
  }
  return null;
}

/**
 * Parse a credits-cycle reset label (month-name + day, e.g. "Jun1" / "Jun 1") to a ms epoch at
 * local midnight. Unlike `parseResetLabel`, a date already past rolls forward ONE MONTH (the
 * credits budget is monthly), not one year — carrying the year on a Dec→Jan wrap.
 */
export function parseMonthlyReset(label: string, now: number): number | null {
  const m = label
    .replace(/\s+/g, "")
    .toLowerCase()
    .match(/^([a-z]{3})(\d{1,2})$/);
  if (!m) return null;
  const mon = MONTHS.indexOf(m[1]!);
  if (mon < 0) return null;
  const day = +m[2]!;
  const d = new Date(now);
  // day-safe: pin to the 1st before setting the month so a short target month can't overflow
  // (e.g. setting month while on day 31 spills "Feb 31" into March), then clamp the labeled day
  // to the new month's length. Re-clamp on every step — the month length changes as we advance.
  const clampDay = () => {
    d.setDate(1);
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, lastDay));
  };
  d.setMonth(mon, 1);
  clampDay();
  d.setHours(0, 0, 0, 0);
  // the credits cycle is monthly: a label naming a past month/day is the NEXT occurrence — step
  // forward a month at a time (carrying the year on the Dec→Jan wrap) until it lands at/after now.
  // (One step suffices for "this month, day already past"; the loop also handles Dec-scrape/Jan-reset.)
  while (d.getTime() < now) {
    d.setMonth(d.getMonth() + 1, 1);
    clampDay();
  }
  return d.getTime();
}

// Built from char codes so the control bytes never appear literally in a regex literal.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI_CSI = new RegExp(ESC + "\\[[0-9;?]*[A-Za-z]", "g");
const ANSI_OSC = new RegExp(ESC + "\\][^" + BEL + "]*" + BEL, "g");

// Chrome rendered below the gauges ("Esc to cancel", the credits / contributing panels).
// A section also ends there — otherwise the buffer's last segment would run to end-of-capture
// and could absorb a trailing panel's "% used" when its own gauge line never rendered.
const SECTION_TRAILER = /Esctocancel|Usagecredits|What'scontributing/i;

/**
 * Which window a section belongs to. `session5h`/`week` are the calibrated account windows.
 * A `{ model }` result is a per-model weekly passthrough sub-limit we surface (currently only
 * Fable). Other model-scoped gauges ("Sonnet only"/"Opus only") stay `null` (dropped) — they
 * would otherwise override the account weekly cap.
 */
function segmentKey(seg: string): WindowKey | { model: string } | null {
  if (!/^Currentweek/i.test(seg)) return "session5h";
  // Prefix match (not exact `(Fable)`) so a possible `(Fable only)` render still classifies.
  if (/^Currentweek\(Fable/i.test(seg)) return { model: "fable" };
  return /^Currentweek\((?!allmodels\))/i.test(seg) ? null : "week";
}

/**
 * Read pct + reset label out of one section's text; null while the pct hasn't rendered.
 * `lenient` (only per-model passthrough segments) tolerates a pct without the literal `used`,
 * but STRICT-FIRST: it prefers a finished `N%used` and only falls back to a bare `N%` when no
 * `%used` exists in the segment — so a mid-redraw partial (`2%` before `29%used`) can never be
 * read as the value. The shared strict path (session5h/week) is unchanged.
 */
function parseSegment(seg: string, now: number, lenient = false): ScrapedWindow | null {
  const pctM = seg.match(/(\d+)%used/i) ?? (lenient ? seg.match(/(\d+)%/i) : null);
  if (!pctM) return null;
  const label = seg.match(/Resets(.*?)\(/i)?.[1] ?? null;
  return {
    pct: +pctM[1]!,
    resetLabel: label,
    resetAt: label ? parseResetLabel(label, now) : null,
  };
}

/**
 * Read the "Usage credits" panel out of the already-ANSI-stripped, whitespace-collapsed capture.
 * This is a STANDALONE scan — it must NOT route through the section anchor/`SECTION_TRAILER` loop,
 * which lists `Usagecredits` as a trailer and would truncate this segment to empty. Collapsed shape:
 *   Usagecredits▎0%used€0.29/€50.00spent·ResetsJun1(Europe/Berlin)
 * The gauge pct rounds down (can read `0%used` while real money is spent), so `spent` is the truth
 * signal and is parsed independently of pct.
 *
 * Scan EVERY "Usagecredits" occurrence, not just the first. The probe runs claude in the classic
 * renderer (CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN), which accumulates the `/usage` slash-command menu
 * into the buffer — and the `/usage-credits` command (renamed from `/extra-usage` in Claude Code
 * v2.1.144) carries the description "Configure usage credits to keep working when you hit a limit",
 * which collapses to a `Usagecredits…` run that precedes the real panel. The first match is thus
 * that menu text (no spend figure); the actual panel — the only occurrence carrying a `…/…spent`
 * amount — comes later. So match on the spend line as the truth signal and skip any occurrence
 * (menu text, or a still-"Refreshing…" partial frame) that lacks it.
 */
export function parseCredits(collapsed: string, now: number): ScrapedCredit | null {
  for (const m of collapsed.matchAll(/Usagecredits/gi)) {
    let seg = collapsed.slice(m.index);
    const end = seg.search(/Esctocancel/i);
    if (end >= 0) seg = seg.slice(0, end);
    // symbol-only currency group: a `(\D*)([\d.]+)` form would wrongly grab the `%used` of `0%used€`.
    // Amounts are assumed dot-decimal (as the Europe/Berlin TUI renders, e.g. `€0.29`); a comma render
    // (`€0,29`) wouldn't match `[\d.]+` and would drop the whole credits section (returns null).
    // `seg` is already whitespace-collapsed, so there is no inter-group whitespace to skip.
    const spend = seg.match(/([^\d.\s/])([\d.]+)\/[^\d.\s/]?([\d.]+)spent/i);
    if (!spend) continue; // menu text or a still-"Refreshing…" partial — try the next occurrence
    // pct rounds down and can be absent; treat missing as 0 — spend above is the real signal
    const pct = +(seg.match(/(\d+)%used/i)?.[1] ?? 0);
    const label = seg.match(/Resets(.*?)\(/i)?.[1] ?? null;
    return {
      pct,
      spent: +spend[2]!,
      cap: +spend[3]!,
      currency: spend[1]!,
      resetLabel: label,
      resetAt: label ? parseMonthlyReset(label, now) : null,
    };
  }
  return null;
}

/**
 * Later segments are newer renders, so keep the last reading per window — but never let a
 * reset-less partial replace a render that already carries a reset label.
 */
function preferReset(prior: ScrapedWindow | null | undefined, next: ScrapedWindow): boolean {
  return !prior || !!next.resetLabel || !prior.resetLabel;
}

/** Fold one section (already sliced from the capture) into the accumulating windows. */
function absorbSegment(
  rawSeg: string,
  now: number,
  best: ScrapedUsage,
  models: Map<string, ScrapedModelWindow>,
): void {
  let seg = rawSeg;
  const trailer = seg.search(SECTION_TRAILER);
  if (trailer >= 0) seg = seg.slice(0, trailer);
  const key = segmentKey(seg);
  if (!key) return;
  if (typeof key === "object") {
    const w = parseSegment(seg, now, true); // per-model: tolerate a pct without `used`
    if (w && preferReset(models.get(key.model), w)) models.set(key.model, { ...w, ...key });
    return;
  }
  const w = parseSegment(seg, now);
  if (w && preferReset(best[key], w)) best[key] = w;
}

/** Extract the limit windows from a (possibly multi-frame, ANSI-laden) `/usage` capture. */
export function parseUsageFrame(raw: string, now: number): ScrapedUsage {
  const noAnsi = raw.replace(ANSI_CSI, "").replace(ANSI_OSC, "");
  const c = noAnsi.replace(/\s+/g, ""); // collapse all whitespace; TUI render is unreliable
  // The capture holds many partial redraws of the same panel. Cut it at every section anchor
  // so a window's pct/reset can only be read from its OWN section — a truncated redraw must
  // not let one window steal the next section's (or the next frame's) values. Per-model gauges
  // are deduped by model slug (Map upsert) so partial redraws don't emit one bar per redraw.
  const anchors = [...c.matchAll(/Currentsession|Currentweek/gi)];
  const best: ScrapedUsage = {
    session5h: null,
    week: null,
    perModelWeek: [],
    credits: parseCredits(c, now),
  };
  const models = new Map<string, ScrapedModelWindow>();
  for (let i = 0; i < anchors.length; i++) {
    absorbSegment(c.slice(anchors[i]!.index, anchors[i + 1]?.index ?? c.length), now, best, models);
  }
  best.perModelWeek = [...models.values()];
  return best;
}

export interface CapRow {
  window: WindowKey;
  cap: number;
  resetAt: number;
  pct: number;
  scrapedAt: number;
}

export interface LimitWindow {
  pct: number;
  resetAt: number;
}
/** Live "Usage credits" window — a direct passthrough of the last scrape snapshot. */
export interface CreditWindow {
  pct: number;
  spent: number;
  cap: number;
  currency: string;
  resetAt: number | null;
  scrapedAt: number;
  stale: boolean; // derived from scrapedAt age (NOT the cap-based 2-week stale flag)
}
/** Live per-model weekly sub-limit ("Current week (Fable)") — a direct passthrough of the
 *  last scrape, keyed by model. Not recomputed from JSONL. */
export interface ModelWeekWindow {
  model: string;
  pct: number;
  resetAt: number | null;
  scrapedAt: number;
  stale: boolean; // derived from scrapedAt age against MODEL_WEEK_STALE_MS
}
export interface UsageLimits {
  session5h: LimitWindow | null;
  week: LimitWindow | null;
  perModelWeek: ModelWeekWindow[];
  credits: CreditWindow | null;
  stale: boolean;
  calibratedAt: number | null;
  /** true in api-key auth mode: usage tracking is subscription-only, so the meters carry no
   *  data and the UI shows an explicit subscription-only state (not a fake zero meter). */
  subscriptionOnly: boolean;
  providers?: UsageProviderSnapshot[];
}

export interface UsageProjection {
  window: "5H" | "WK";
  projectedPct: number; // projected % at reset if burn holds (NOT clamped; may exceed 100)
  resetAt: number; // ms epoch of window reset
  burnRatePerHour: number; // recent weighted units/hour
}

export type UsageProviderSnapshot =
  | {
      provider: "claude";
      kind: "limits";
      session5h: LimitWindow | null;
      week: LimitWindow | null;
      perModelWeek: ModelWeekWindow[];
      credits: CreditWindow | null;
      stale: boolean;
      calibratedAt: number | null;
      subscriptionOnly: boolean;
    }
  | {
      provider: "codex";
      kind: "tokens";
      totalTokens: number;
      session5hTokens: number;
      weekTokens: number;
      updatedAt: number | null;
      stale: boolean;
      // Rate-limit windows scraped from Codex's own session rollout logs (the same
      // 5h/weekly used-% + reset that `codex` reports). null when no rollout carries
      // a rate-limit event yet, so the UI falls back to the raw token counts.
      session5h: LimitWindow | null;
      week: LimitWindow | null;
      rateLimitSource?: "rollout" | "missing";
      rateLimitCheckedAt?: number;
      rateLimitFilesScanned?: number;
      rateLimitLatestEventAt?: number | null;
    };

export interface UsageProviderSource {
  snapshot(now: number): UsageProviderSnapshot | null;
}

// Credits is scrape-fresh-only (no local signal to recompute from), so it goes stale fast —
// 1h, unlike the 2-week cap stale that tolerates JSONL-recomputed windows drifting.
const CREDIT_STALE_MS = 60 * 60 * 1000;

// Beyond this age the credit snapshot is treated as DEAD (extra usage was turned off): calibrate
// runs at least daily, so a snapshot older than two calibration cycles means the `/usage` panel has
// stopped rendering a credits section across multiple successful scrapes — the account no longer has
// credits enabled. `limits()` drops it entirely rather than lingering a "SCRAPED Nd AGO / SNAPSHOT
// STALE" gauge the user can't refresh away. The persisted snapshot + history are untouched, so if
// credits are re-enabled the next scrape re-populates it and the gauge returns.
const CREDIT_DROP_MS = 2 * CALIBRATE_INTERVAL_MS;

// Per-model weekly passthrough is scrape-fresh-only too, but — unlike credits — it isn't put on
// the near-cap 15-min watch cadence, so a 1h stale would flip it "stale" within an hour of every
// daily calibration. Tie it to the calibration cadence, tolerant of one missed daily run.
export const MODEL_WEEK_STALE_MS = 2 * CALIBRATE_INTERVAL_MS;

export interface CapStore {
  getCaps(): CapRow[];
  putCap(row: CapRow): void;
}

/** Latest persisted "Usage credits" snapshot — a direct passthrough of the scrape, not back-calculated. */
export interface CreditSnapshot {
  spent: number;
  cap: number;
  currency: string;
  pct: number;
  resetAt: number | null; // monthly reset epoch (ms); null if the label was unparseable
  scrapedAt: number;
}

export interface CreditStore {
  getCreditSnapshot(): CreditSnapshot | null; // null when nothing persisted yet
  putCreditSnapshot(row: CreditSnapshot): void; // single-row: upsert, latest wins
}

/** Latest persisted per-model weekly passthrough snapshot — one row per model, upsert. */
export interface ModelWeekSnapshot {
  model: string;
  pct: number;
  resetAt: number | null; // weekly reset epoch (ms); null if the gauge carried no reset label
  scrapedAt: number;
}

export interface ModelWeekStore {
  getModelWeekSnapshots(): ModelWeekSnapshot[]; // empty when nothing persisted yet
  putModelWeekSnapshot(row: ModelWeekSnapshot): void; // keyed by model: upsert, latest wins
}

/** A source of raw `/usage` text. Returns null on failure (spawn/parse/timeout). */
export interface UsageProbe {
  scrape(): Promise<string | null>;
}

/** Roll a reset anchor forward by its period until it is >= now. */
function rollForward(resetAt: number, period: number, now: number): number {
  if (period <= 0) return resetAt;
  let r = resetAt;
  if (r < now) {
    const steps = Math.ceil((now - r) / period);
    r += steps * period;
  }
  return r;
}

const clampPct = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

export class UsageLimitsService {
  constructor(
    private index: AccountUsageIndex,
    private caps: CapStore,
    private probe: UsageProbe,
    private creditStore: CreditStore,
    // No-op default: callers that don't exercise per-model passthrough (most tests) keep working;
    // production passes the persistent store.
    private modelWeekStore: ModelWeekStore = {
      getModelWeekSnapshots: () => [],
      putModelWeekSnapshot: () => {},
    },
    private providerSources: UsageProviderSource[] = [],
  ) {}

  // `now` of the last calibrate whose probe returned a usable frame. A manual-refresh caller
  // reads this right after awaiting calibrate() to tell a real re-scrape (the snapshot advanced)
  // from a skipped/failed one (stale) — without overloading calibrate()'s boolean (which conflates
  // "scraped but wrote no cap" with "scrape failed"). Distinct from a successful cap-write.
  private _lastScrapeAt = 0;
  /** `now` of the most recent frame-returning scrape (0 if none yet). */
  get lastScrapeAt(): number {
    return this._lastScrapeAt;
  }

  /** Scrape `/usage` and recalibrate the per-window caps from local JSONL. */
  async calibrate(now: number): Promise<boolean> {
    // Subscription-only: never spawn the probe under api-key auth — the /usage panel doesn't
    // exist for API-key accounts and spawning a bare claude risks a hang on the auth prompt.
    if (isApiKeyMode()) return false;
    const raw = await this.probe.scrape();
    if (!raw) return false;
    this._lastScrapeAt = now; // a usable frame was scraped this run
    const parsed = parseUsageFrame(raw, now);
    const prior = new Map(this.caps.getCaps().map((r) => [r.window, r]));
    let any = false;
    for (const key of ["session5h", "week"] as WindowKey[]) {
      if (this.calibrateWindow(key, parsed[key], prior.get(key), now)) any = true;
    }
    if (this.persistCredit(parsed, now)) any = true;
    if (this.persistModelWeek(parsed, now)) any = true;
    return any;
  }

  /**
   * Recalibrate one window's cap from its scraped pct against local JSONL. Returns true when it
   * wrote a cap (or refreshed a prior anchor) — i.e. when the calibration produced something worth
   * emitting. Absent window (`w` null) → no-op, returns false.
   */
  private calibrateWindow(
    key: WindowKey,
    w: ScrapedUsage[WindowKey],
    p: CapRow | undefined,
    now: number,
  ): boolean {
    if (!w) return false;
    const period = PERIOD_MS[key];
    // unparseable reset label: a prior anchor rolled forward beats guessing now+period —
    // a bogus anchor poisons both the calibration window and the displayed reset time
    const resetAt = w.resetAt ?? (p ? rollForward(p.resetAt, period, now) : now + period);
    const start = resetAt - period;
    const units = this.index.windowSum(start, Math.min(resetAt, now));
    if (w.pct >= MIN_CALIBRATION_PCT && units > 0) {
      this.caps.putCap({
        window: key,
        cap: units / (w.pct / 100),
        resetAt,
        pct: w.pct,
        scrapedAt: now,
      });
      return true;
    }
    // too little signal to invert a cap — refresh the anchor on the prior cap if we have one
    if (p) this.caps.putCap({ ...p, resetAt, pct: w.pct, scrapedAt: now });
    return !!p;
  }

  /**
   * Credits is a direct passthrough — persist the scrape verbatim whenever the panel rendered it.
   * No MIN_CALIBRATION_PCT gate (that's a cap-inversion guard, irrelevant here). A missing section
   * (extra usage disabled) leaves any prior snapshot untouched — never fabricate. Returns true when
   * a snapshot was persisted (worth emitting usage:limits even if caps didn't move).
   */
  private persistCredit(parsed: ScrapedUsage, now: number): boolean {
    if (!parsed.credits) return false;
    const cr = parsed.credits;
    this.creditStore.putCreditSnapshot({
      spent: cr.spent,
      cap: cr.cap,
      currency: cr.currency,
      pct: cr.pct,
      resetAt: cr.resetAt,
      scrapedAt: now,
    });
    return true;
  }

  /**
   * Per-model weekly sub-limits are a direct passthrough — persist each rendered gauge verbatim,
   * one row per model. A missing gauge leaves any prior snapshot untouched (never fabricate).
   * Returns true when at least one was persisted.
   */
  private persistModelWeek(parsed: ScrapedUsage, now: number): boolean {
    let any = false;
    for (const w of parsed.perModelWeek) {
      this.modelWeekStore.putModelWeekSnapshot({
        model: w.model,
        pct: w.pct,
        resetAt: w.resetAt,
        scrapedAt: now,
      });
      any = true;
    }
    return any;
  }

  /**
   * Effective units consumed in the current window, anchored to the last scrape.
   *
   * `row.pct` is the account's true % at `row.scrapedAt` (⇒ `pct/100 * cap` units), so we add ONLY
   * local usage since the scrape. This reconciles a mid-window account reset — Claude zeroes the
   * weekly counter without moving the reset boundary — that a fixed windowed sum misses: the
   * pre-reset usage stays inside the window but no longer counts toward the account cap, and a
   * scraped `pct` below MIN_CALIBRATION_PCT can't re-invert the cap, so `windowSum/cap` would stay
   * stuck at the pre-reset % forever (the "usage reset but the gauge won't update" bug).
   *
   * In the normal (non-reset) path this is provably identical to `windowSum(windowStart, now)/cap`:
   * the cap was inverted from `unitsAtScrape / (pct/100)`, so `pct/100*cap == unitsAtScrape` and
   * `unitsAtScrape + windowSum(scrapedAt, now) == windowSum(windowStart, now)`.
   *
   * When the window has rolled over since the scrape (`resetAt` advanced past the stored anchor),
   * the anchor belongs to the previous window — fall back to the plain windowed sum of the fresh
   * window (matches the pre-anchor post-boundary behavior).
   */
  private currentUnits(row: CapRow, resetAt: number, now: number): number {
    const period = PERIOD_MS[row.window];
    if (resetAt !== row.resetAt) return this.index.windowSum(resetAt - period, now);
    return (row.pct / 100) * row.cap + this.index.windowSum(row.scrapedAt, now);
  }

  /** Current live limits, recomputed from local JSONL against the calibrated caps. */
  limits(now: number): UsageLimits {
    const rows = new Map(this.caps.getCaps().map((r) => [r.window, r]));
    let calibratedAt: number | null = null;
    const compute = (key: WindowKey): LimitWindow | null => {
      const row = rows.get(key);
      if (!row || row.cap <= 0) return null;
      calibratedAt = Math.max(calibratedAt ?? 0, row.scrapedAt);
      const resetAt = rollForward(row.resetAt, PERIOD_MS[key], now);
      return { pct: clampPct((this.currentUnits(row, resetAt, now) / row.cap) * 100), resetAt };
    };
    const session5h = compute("session5h");
    const week = compute("week");
    const stale = calibratedAt === null || now - calibratedAt > 2 * PERIOD_MS.week;
    // Credits is a passthrough of the stored snapshot — not recomputed from JSONL.
    const snap = this.creditStore.getCreditSnapshot();
    let credits: CreditWindow | null = null;
    // Two guards keep `credits` null (gauge hidden):
    //  1. Post-reset: a snapshot whose monthly budget already rolled over is meaningless until
    //     re-scraped (also stops the gauge showing a past reset date). An unparseable (null)
    //     resetAt can't be known to have rolled over, so it passes through.
    //  2. Dead: a snapshot older than CREDIT_DROP_MS means extra usage was turned off (the `/usage`
    //     panel stopped rendering credits across multiple daily scrapes) — hide it rather than
    //     linger a stale, un-refreshable "SCRAPED Nd AGO" gauge. The snapshot itself is untouched.
    const rolledOver = snap != null && snap.resetAt != null && snap.resetAt <= now;
    const dead = snap != null && now - snap.scrapedAt > CREDIT_DROP_MS;
    if (snap && !rolledOver && !dead) {
      credits = {
        pct: snap.pct,
        spent: snap.spent,
        cap: snap.cap,
        currency: snap.currency,
        resetAt: snap.resetAt,
        scrapedAt: snap.scrapedAt,
        stale: now - snap.scrapedAt > CREDIT_STALE_MS,
      };
    }
    // Per-model weekly passthrough: emit every stored snapshot, with the same post-reset guard as
    // credits (a snapshot past its weekly reset is meaningless until re-scraped; a null resetAt —
    // the gauge carried no reset label — can't be known to have rolled over, so it passes through).
    const perModelWeek: ModelWeekWindow[] = this.modelWeekStore
      .getModelWeekSnapshots()
      .filter((s) => !(s.resetAt != null && s.resetAt <= now))
      .map((s) => ({
        model: s.model,
        pct: s.pct,
        resetAt: s.resetAt,
        scrapedAt: s.scrapedAt,
        stale: now - s.scrapedAt > MODEL_WEEK_STALE_MS,
      }));
    const subscriptionOnly = isApiKeyMode();
    const claude: UsageProviderSnapshot = {
      provider: "claude",
      kind: "limits",
      session5h,
      week,
      perModelWeek,
      credits,
      stale,
      calibratedAt,
      subscriptionOnly,
    };
    const providers = [
      claude,
      ...this.providerSources.flatMap((source) => {
        try {
          const snap = source.snapshot(now);
          return snap ? [snap] : [];
        } catch {
          return [];
        }
      }),
    ];
    return {
      session5h,
      week,
      perModelWeek,
      credits,
      stale,
      calibratedAt,
      subscriptionOnly,
      providers,
    };
  }

  /** Burn-rate projections: projected % at window reset, based on a trailing lookback window. */
  projections(now: number): UsageProjection[] {
    const rows = new Map(this.caps.getCaps().map((r) => [r.window, r]));
    const out: UsageProjection[] = [];
    for (const key of ["session5h", "week"] as WindowKey[]) {
      const row = rows.get(key);
      if (!row || row.cap <= 0) continue; // mirrors limits() returning null
      const period = PERIOD_MS[key];
      const resetAt = rollForward(row.resetAt, period, now);
      const windowStart = resetAt - period;
      // Anchored to the last scrape (same reconciliation as limits()) so a mid-window reset doesn't
      // leave the projection basing off pre-reset usage that no longer counts.
      const curUnits = this.currentUnits(row, resetAt, now);
      const lookback = LOOKBACK_MS[key];
      // numerator start clamped to windowStart so the trailing window never bleeds
      // pre-reset burn into a fresh window; denominator stays the NOMINAL lookback hours
      // (so the first hour of a fresh window yields a low, non-explosive rate that ramps).
      const recentUnits = this.index.windowSum(Math.max(windowStart, now - lookback), now);
      const burnRatePerHour = Math.round(recentUnits / (lookback / 3_600_000));
      const hoursToReset = Math.max(0, (resetAt - now) / 3_600_000);
      const projectedPct = Math.round(
        ((curUnits + burnRatePerHour * hoursToReset) / row.cap) * 100,
      );
      out.push({ window: WINDOW_LABEL[key], projectedPct, resetAt, burnRatePerHour });
    }
    return out;
  }
}
