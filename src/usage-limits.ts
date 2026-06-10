import type { AccountUsageIndex } from "./usage";

export type WindowKey = "session5h" | "week";

const PERIOD_MS: Record<WindowKey, number> = {
  session5h: 5 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
};

/** Below this scraped %, inverting to a cap is too noisy — keep the prior cap instead. */
const MIN_CALIBRATION_PCT = 5;

export interface ScrapedWindow {
  pct: number;
  resetAt: number | null;
  resetLabel: string | null;
}
export interface ScrapedUsage {
  session5h: ScrapedWindow | null;
  week: ScrapedWindow | null;
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

// Built from char codes so the control bytes never appear literally in a regex literal.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI_CSI = new RegExp(ESC + "\\[[0-9;?]*[A-Za-z]", "g");
const ANSI_OSC = new RegExp(ESC + "\\][^" + BEL + "]*" + BEL, "g");

/** Which window a section belongs to; null for model-scoped weekly gauges ("Sonnet only"). */
function segmentKey(seg: string): WindowKey | null {
  if (!/^Currentweek/i.test(seg)) return "session5h";
  return /^Currentweek\((?!allmodels\))/i.test(seg) ? null : "week";
}

/** Read pct + reset label out of one section's text; null while the pct hasn't rendered. */
function parseSegment(seg: string, now: number): ScrapedWindow | null {
  const pctM = seg.match(/(\d+)%used/i);
  if (!pctM) return null;
  const label = seg.match(/Resets(.*?)\(/i)?.[1] ?? null;
  return {
    pct: +pctM[1]!,
    resetLabel: label,
    resetAt: label ? parseResetLabel(label, now) : null,
  };
}

/** Extract the two limit windows from a (possibly multi-frame, ANSI-laden) `/usage` capture. */
export function parseUsageFrame(raw: string, now: number): ScrapedUsage {
  const noAnsi = raw.replace(ANSI_CSI, "").replace(ANSI_OSC, "");
  const c = noAnsi.replace(/\s+/g, ""); // collapse all whitespace; TUI render is unreliable
  // The capture holds many partial redraws of the same panel. Cut it at every section anchor
  // so a window's pct/reset can only be read from its OWN section — a truncated redraw must
  // not let one window steal the next section's (or the next frame's) values.
  const anchors = [...c.matchAll(/Currentsession|Currentweek/gi)];
  const best: ScrapedUsage = { session5h: null, week: null };
  for (let i = 0; i < anchors.length; i++) {
    const seg = c.slice(anchors[i]!.index, anchors[i + 1]?.index ?? c.length);
    const key = segmentKey(seg);
    const w = key ? parseSegment(seg, now) : null;
    if (!key || !w) continue;
    // later segments are newer renders — keep the last reading per window, but never let
    // a reset-less partial replace one that carries a reset label
    if (!best[key] || w.resetLabel || !best[key].resetLabel) best[key] = w;
  }
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
export interface UsageLimits {
  session5h: LimitWindow | null;
  week: LimitWindow | null;
  stale: boolean;
  calibratedAt: number | null;
}

export interface CapStore {
  getCaps(): CapRow[];
  putCap(row: CapRow): void;
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
  ) {}

  /** Scrape `/usage` and recalibrate the per-window caps from local JSONL. */
  async calibrate(now: number): Promise<boolean> {
    const raw = await this.probe.scrape();
    if (!raw) return false;
    const parsed = parseUsageFrame(raw, now);
    const prior = new Map(this.caps.getCaps().map((r) => [r.window, r]));
    let any = false;
    for (const key of ["session5h", "week"] as WindowKey[]) {
      const w = parsed[key];
      if (!w) continue;
      const period = PERIOD_MS[key];
      const p = prior.get(key);
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
        any = true;
      } else {
        // too little signal to invert a cap — refresh the anchor on the prior cap if we have one
        if (p) this.caps.putCap({ ...p, resetAt, pct: w.pct, scrapedAt: now });
        any = any || !!p;
      }
    }
    return any;
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
      const units = this.index.windowSum(resetAt - PERIOD_MS[key], now);
      return { pct: clampPct((units / row.cap) * 100), resetAt };
    };
    const session5h = compute("session5h");
    const week = compute("week");
    const stale = calibratedAt === null || now - calibratedAt > 2 * PERIOD_MS.week;
    return { session5h, week, stale, calibratedAt };
  }
}
