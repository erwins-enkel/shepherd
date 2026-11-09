import type { ActionsAccountBilling } from "#lib/types.js";

const DAY_MS = 86_400_000;
/** A stop this close (or already passed) leaves the panel's quiet register. */
export const STOP_SOON_MS = 3 * DAY_MS;

/**
 * How an account's month reads. The forecast decides, not the percentage: 41 % is alarming when
 * the pace runs into a stop before the reset.
 *  - `stopped`: a stopping budget is spent — workflows no longer start;
 *  - `warn`: that stop is projected before the reset;
 *  - `paid`: past (or heading past) the included amount, billed on without reaching a stop;
 *  - `ok` / `quiet`: lasts until the reset; `quiet` had no private runs at all.
 */
export type ActionsTone = "stopped" | "warn" | "paid" | "ok" | "quiet";

/** Each tone's hue — semantic: red stopped, warn-orange a stop ahead, amber billed on. */
export const TONE_COLOR: Record<ActionsTone, string> = {
  stopped: "var(--color-red)",
  warn: "var(--color-warn)",
  paid: "var(--color-amber)",
  ok: "var(--color-ink)",
  quiet: "var(--color-muted)",
};

export function actionsTone(a: ActionsAccountBilling, nowMs: number): ActionsTone {
  const stopAt = a.projection.stopAt;
  if (stopAt !== null) return stopAt <= nowMs ? "stopped" : "warn";
  const over =
    a.paidUsd > 0 || (a.includedUsd !== null && a.projection.monthEndUsd > a.includedUsd);
  if (over) return "paid";
  return a.usedUsd > 0 ? "ok" : "quiet";
}

/** The account's row, severest first: what needs the operator leads. */
function rank(a: ActionsAccountBilling, nowMs: number): number {
  if (a.status === "missing-scope") return 3;
  if (a.status === "error") return 6;
  if (a.status === "no-access") return 7;
  return { stopped: 0, warn: 1, paid: 2, ok: 4, quiet: 5 }[actionsTone(a, nowMs)];
}

export function sortAccounts(
  accounts: readonly ActionsAccountBilling[],
  nowMs: number,
): ActionsAccountBilling[] {
  return accounts
    .map((a, i) => ({ a, i, r: rank(a, nowMs) }))
    .sort((x, y) => x.r - y.r || x.i - y.i)
    .map(({ a }) => a);
}

/** The bar's geometry, every value a percentage of its scale: up to the stop when one is known,
 *  else wide enough for the included amount and the forecast. */
export interface ActionsBar {
  /** Spend inside the included amount. */
  usedPct: number;
  /** Spend past it (budget or billed), drawn in the tone's color; null when none. */
  over: { from: number; to: number } | null;
  /** The forecast to the month's end, from the spend's end. */
  forecastToPct: number;
  /** The included amount's edge when the bar runs past it. */
  includedTickPct: number | null;
  /** Where the stopping budget's hatched zone starts (it runs to the stop at 100). */
  budgetFromPct: number | null;
  /** The bar ends in a stop. */
  stop: boolean;
}

export function actionsBar(a: ActionsAccountBilling): ActionsBar {
  const included = a.includedUsd;
  const used = a.usedUsd;
  const forecast = Math.max(a.projection.monthEndUsd, used);
  const scale = a.stopAtUsd ?? Math.max(included ?? 0, forecast, 0.01);
  const pct = (usd: number) => Math.min(Math.max((usd / scale) * 100, 0), 100);
  const inside = included === null ? used : Math.min(used, included);
  const includedPct = included === null ? null : pct(included);
  return {
    usedPct: pct(inside),
    over: included !== null && used > included ? { from: pct(included), to: pct(used) } : null,
    forecastToPct: pct(forecast),
    includedTickPct: includedPct !== null && includedPct < 100 ? includedPct : null,
    budgetFromPct:
      a.stopAtUsd !== null && included !== null && a.stopAtUsd > included ? includedPct : null,
    stop: a.stopAtUsd !== null,
  };
}

/** USD the way the credit gauge writes it: whole dollars from $10, cents below. */
export function usd(n: number): string {
  if (n === 0) return "$0";
  return n >= 10 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`;
}

/** The "used" cell: the share of the included amount while inside it, then the share of the
 *  stopping budget, then what was billed. */
export function usedLabel(a: ActionsAccountBilling): string {
  const included = a.includedUsd;
  if (included === null) return usd(a.usedUsd);
  if (a.usedUsd < included) return `${Math.round((a.usedUsd / included) * 100)}%`;
  const budget = a.budget;
  if (budget?.stops) {
    if (budget.amountUsd <= 0) return "100%";
    return `${Math.min(Math.round(((a.usedUsd - included) / budget.amountUsd) * 100), 100)}%`;
  }
  return `+${usd(a.paidUsd)}`;
}

/** Whole days CI stands still between a stop and the reset; null without a stop. */
export function daysWithoutCi(a: ActionsAccountBilling, resetAt: number): number | null {
  const stopAt = a.projection.stopAt;
  return stopAt === null ? null : Math.max(Math.ceil((resetAt - stopAt) / DAY_MS), 0);
}

/** A runner that costs far beyond its share of minutes (macOS, typically) — worth one line. */
export function costlyRunner(a: ActionsAccountBilling): {
  os: ActionsAccountBilling["runners"][number]["os"];
  minutesPct: number;
  costPct: number;
} | null {
  const minutes = a.runners.reduce((s, r) => s + r.minutes, 0);
  const cost = a.runners.reduce((s, r) => s + r.grossUsd, 0);
  if (minutes <= 0 || cost <= 0) return null;
  for (const r of a.runners) {
    const minutesPct = Math.round((r.minutes / minutes) * 100);
    const costPct = Math.round((r.grossUsd / cost) * 100);
    if (costPct >= 25 && costPct >= 2 * Math.max(minutesPct, 1))
      return { os: r.os, minutesPct, costPct };
  }
  return null;
}
