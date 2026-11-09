/**
 * The monthly GitHub Actions allowance of the signed-in account and each of its orgs, for the
 * usage panel: how much of the plan's included compute this month's private-repo runs used, the
 * Actions budget that takes over after it — and, when that budget stops usage, the date CI is
 * projected to stop before the next reset.
 *
 * Since 2026 GitHub bills hosted-runner minutes in USD per minute and includes a dollar amount
 * per plan ($12 Free, $18 Pro/Team, $300 Enterprise Cloud). Standard runners in public repos
 * are free and never draw on it, and the billing API reports their minutes discounted exactly
 * like included ones — so the usage report's per-repo items are split against the account's
 * public repos rather than read off the summary's discount.
 *
 * Sources (enhanced billing platform; the legacy `/settings/billing/actions` answers 410):
 *  - `GET /organizations/{org}/settings/billing/usage` and `GET /users/{user}/settings/billing/usage`
 *    — this month's items per day, SKU and repo (the user one needs the token's `user` scope);
 *  - `GET /organizations/{org}/settings/billing/budgets` — the Actions budget and its stop (no
 *    user-level endpoint exists);
 *  - the org / user plan, and the account's public repos.
 * Billing data moves slowly, so a reading is cached for {@link TTL_MS}.
 */

import { isRateLimitError } from "./rate-limit";

type GhRun = (args: string[]) => Promise<string>;

const DAY_MS = 86_400_000;
/** Billing readings move a few times a day; a short TTL would only spend REST calls. */
const TTL_MS = 10 * 60_000;
/** A reading with a failed account is retried sooner. */
const ERROR_TTL_MS = 60_000;
/** Private repos listed in the cost breakdown. */
const TOP_REPOS = 4;

/** Monthly included hosted-runner compute in USD, by the plan name GitHub reports. */
const INCLUDED_USD: Record<string, number> = {
  free: 12,
  pro: 18,
  team: 18,
  enterprise: 300,
};

export type ActionsAccountStatus = "ok" | "missing-scope" | "no-access" | "error";
export type ActionsRunnerOs = "linux" | "macos" | "windows" | "other";

/** One item of the billing usage report. */
export interface UsageItem {
  date?: string;
  product?: string;
  sku?: string;
  unitType?: string;
  quantity?: number;
  grossAmount?: number;
  netAmount?: number;
  repositoryName?: string;
}

export interface ActionsBudget {
  amountUsd: number;
  /** "Stop usage when budget limit is reached" — workflows stop starting once it is spent. */
  stops: boolean;
}

export interface ActionsSummary {
  /** Gross USD of this month's private/internal-repo minutes — what draws on the allowance. */
  usedUsd: number;
  /** USD actually billed for Actions minutes this month. */
  paidUsd: number;
  /** Private-repo spend at which workflows stop (included + a stopping budget); null when no
   *  stop is known. */
  stopAtUsd: number | null;
  projection: {
    /** This month's private-repo spend at the current pace. */
    monthEndUsd: number;
    /** When the included compute runs out (past: the day it did); null when it lasts. */
    includedOutAt: number | null;
    /** When workflows stop (past: the day they did); null when no stop before the reset. */
    stopAt: number | null;
  };
  /** Private-repo minutes and cost per runner OS, most expensive first. */
  runners: { os: ActionsRunnerOs; minutes: number; grossUsd: number }[];
  /** The most expensive private repos. */
  topRepos: { repo: string; minutes: number; grossUsd: number }[];
  /** Minutes in public repos — free, but worth naming. */
  publicMinutes: number;
  publicGrossUsd: number;
  topPublicRepo: { repo: string; minutes: number } | null;
}

export interface ActionsAccountBilling extends ActionsSummary {
  login: string;
  kind: "user" | "org";
  status: ActionsAccountStatus;
  /** The plan as GitHub names it; null when the token can't read it. */
  plan: string | null;
  includedUsd: number | null;
  budget: ActionsBudget | null;
}

export interface GithubActionsBillingPayload {
  fetchedAt: number;
  /** Epoch-ms start of the billed month (UTC). */
  periodStart: number;
  /** Epoch-ms of the next reset: the start of the next month (UTC). */
  resetAt: number;
  accounts: ActionsAccountBilling[];
}

export function includedUsdForPlan(plan: string | null): number | null {
  return plan === null ? null : (INCLUDED_USD[plan.toLowerCase()] ?? null);
}

/** The product-wide Actions budget from a budgets response; null when none. */
export function actionsBudget(body: unknown): ActionsBudget | null {
  const list = (body as { budgets?: unknown })?.budgets;
  if (!Array.isArray(list)) return null;
  const b = list.find(
    (x) =>
      x?.budget_type === "ProductPricing" &&
      String(x?.budget_product_sku).toLowerCase() === "actions",
  );
  if (!b || !Number.isFinite(Number(b.budget_amount))) return null;
  return { amountUsd: Number(b.budget_amount), stops: b.prevent_further_usage === true };
}

/** Which token problem a failed billing call names. */
export function classifyBillingError(err: unknown): Exclude<ActionsAccountStatus, "ok"> {
  const e = err as { stderr?: unknown; message?: unknown } | null;
  const text = String(e?.stderr ?? e?.message ?? err);
  if (/needs the "[^"]+" scope/i.test(text)) return "missing-scope";
  if (isRateLimitError(err)) return "error";
  if (/HTTP 40[34]\b/.test(text)) return "no-access";
  return "error";
}

function runnerOs(sku: string): ActionsRunnerOs {
  if (/mac/i.test(sku)) return "macos";
  if (/windows/i.test(sku)) return "windows";
  if (/linux/i.test(sku)) return "linux";
  return "other";
}

const cents = (n: number): number => Math.round(n * 100) / 100;

function isActionsMinutes(i: UsageItem): boolean {
  return i.product?.toLowerCase() === "actions" && i.unitType?.toLowerCase() === "minutes";
}

/** Add `v` to `key`'s running totals. */
function tally<K>(map: Map<K, { minutes: number; grossUsd: number }>, key: K, i: UsageItem) {
  const t = map.get(key) ?? { minutes: 0, grossUsd: 0 };
  t.minutes += i.quantity ?? 0;
  t.grossUsd += i.grossAmount ?? 0;
  map.set(key, t);
}

/**
 * When cumulative private spend reaches `threshold`: the day the daily totals reached it when
 * already past, else the projection at the month's pace (null when that lands after the reset).
 */
function crossing(
  threshold: number,
  used: number,
  daily: Map<string, number>,
  pacePerDay: number,
  now: number,
  resetAt: number,
): number | null {
  if (used >= threshold) {
    let cum = 0;
    for (const [date, usd] of [...daily].sort(([a], [b]) => a.localeCompare(b))) {
      cum += usd;
      if (cum >= threshold) return Date.parse(date);
    }
    return now;
  }
  if (pacePerDay <= 0) return null;
  const at = now + ((threshold - used) / pacePerDay) * DAY_MS;
  return at < resetAt ? Math.round(at) : null;
}

/** One account's month from its usage items. Pure; `now` is injected. */
export function summarizeActions(input: {
  items: UsageItem[];
  publicRepos: Set<string>;
  includedUsd: number | null;
  budget: ActionsBudget | null;
  periodStart: number;
  resetAt: number;
  now: number;
}): ActionsSummary {
  const { publicRepos, includedUsd, budget, periodStart, resetAt, now } = input;
  const runners = new Map<ActionsRunnerOs, { minutes: number; grossUsd: number }>();
  const repos = new Map<string, { minutes: number; grossUsd: number }>();
  const publicRepoMinutes = new Map<string, { minutes: number; grossUsd: number }>();
  const daily = new Map<string, number>();
  let used = 0;
  let paid = 0;
  for (const i of input.items.filter(isActionsMinutes)) {
    paid += i.netAmount ?? 0;
    const repo = i.repositoryName ?? "";
    if (publicRepos.has(repo)) {
      tally(publicRepoMinutes, repo, i);
      continue;
    }
    used += i.grossAmount ?? 0;
    tally(runners, runnerOs(i.sku ?? ""), i);
    tally(repos, repo, i);
    if (i.date) daily.set(i.date, (daily.get(i.date) ?? 0) + (i.grossAmount ?? 0));
  }

  const stopAtUsd = budget?.stops && includedUsd !== null ? includedUsd + budget.amountUsd : null;
  const elapsedDays = Math.max((now - periodStart) / DAY_MS, 1);
  const pace = used / elapsedDays;
  const at = (threshold: number | null) =>
    threshold === null ? null : crossing(threshold, used, daily, pace, now, resetAt);

  const byCost = <T extends { minutes: number; grossUsd: number }>(rows: T[]) =>
    rows
      .filter((r) => r.minutes > 0 || r.grossUsd > 0)
      .map((r) => ({ ...r, minutes: Math.round(r.minutes), grossUsd: cents(r.grossUsd) }))
      .sort((a, b) => b.grossUsd - a.grossUsd);
  const pub = [...publicRepoMinutes].map(([repo, t]) => ({ repo, ...t }));
  const topPublic = pub.reduce<(typeof pub)[number] | null>(
    (top, r) => (!top || r.minutes > top.minutes ? r : top),
    null,
  );

  return {
    usedUsd: cents(used),
    paidUsd: cents(paid),
    stopAtUsd,
    projection: {
      monthEndUsd: cents(pace * ((resetAt - periodStart) / DAY_MS)),
      includedOutAt: at(includedUsd),
      stopAt: at(stopAtUsd),
    },
    runners: byCost([...runners].map(([os, t]) => ({ os, ...t }))),
    topRepos: byCost([...repos].map(([repo, t]) => ({ repo, ...t }))).slice(0, TOP_REPOS),
    publicMinutes: Math.round(pub.reduce((s, r) => s + r.minutes, 0)),
    publicGrossUsd: cents(pub.reduce((s, r) => s + r.grossUsd, 0)),
    topPublicRepo: topPublic
      ? { repo: topPublic.repo, minutes: Math.round(topPublic.minutes) }
      : null,
  };
}

const EMPTY_SUMMARY: ActionsSummary = {
  usedUsd: 0,
  paidUsd: 0,
  stopAtUsd: null,
  projection: { monthEndUsd: 0, includedOutAt: null, stopAt: null },
  runners: [],
  topRepos: [],
  publicMinutes: 0,
  publicGrossUsd: 0,
  topPublicRepo: null,
};

async function getJson(run: GhRun, path: string): Promise<unknown> {
  return JSON.parse(await run(["api", path]));
}

/** The plan's name from a user/org body; null when the token can't see it. */
function planName(body: unknown): string | null {
  const name = (body as { plan?: { name?: unknown } } | null)?.plan?.name;
  return typeof name === "string" && name ? name : null;
}

async function accountBilling(
  run: GhRun,
  login: string,
  kind: "user" | "org",
  plan: string | null,
  period: { start: number; reset: number; now: number },
): Promise<ActionsAccountBilling> {
  const d = new Date(period.start);
  const month = `year=${d.getUTCFullYear()}&month=${d.getUTCMonth() + 1}`;
  const base = kind === "org" ? `organizations/${login}` : `users/${login}`;
  const includedUsd = includedUsdForPlan(plan);
  const head = { login, kind, plan, includedUsd };
  try {
    const usage = (await getJson(run, `${base}/settings/billing/usage?${month}`)) as {
      usageItems?: UsageItem[];
    };
    const [publicRepos, budget] = await Promise.all([
      listPublicRepos(run, login, kind),
      kind === "org"
        ? getJson(run, `${base}/settings/billing/budgets?per_page=100`).then(
            actionsBudget,
            () => null,
          )
        : Promise.resolve(null),
    ]);
    const summary = summarizeActions({
      items: usage.usageItems ?? [],
      publicRepos,
      includedUsd,
      budget,
      periodStart: period.start,
      resetAt: period.reset,
      now: period.now,
    });
    return { ...head, status: "ok", budget, ...summary };
  } catch (err) {
    return { ...head, status: classifyBillingError(err), budget: null, ...EMPTY_SUMMARY };
  }
}

/** The account's public repo names. Throws on failure: without them, free public minutes
 *  would count as spend. */
async function listPublicRepos(
  run: GhRun,
  login: string,
  kind: "user" | "org",
): Promise<Set<string>> {
  const path =
    kind === "org"
      ? `orgs/${login}/repos?type=public&per_page=100`
      : `users/${login}/repos?type=owner&per_page=100`;
  const out = await run([
    "api",
    "--paginate",
    path,
    "--jq",
    ".[] | select(.private | not) | .name",
  ]);
  return new Set(
    out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

async function readBilling(run: GhRun, now: number): Promise<GithubActionsBillingPayload> {
  const d = new Date(now);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const reset = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  const period = { start, reset, now };
  const empty = { fetchedAt: now, periodStart: start, resetAt: reset, accounts: [] };

  let user: unknown;
  try {
    user = await getJson(run, "user");
  } catch {
    return empty;
  }
  const login = (user as { login?: unknown })?.login;
  if (typeof login !== "string" || !login) return empty;
  const orgs = await getJson(run, "user/orgs?per_page=100").then(
    (b) => (Array.isArray(b) ? b.map((o) => String(o?.login ?? "")).filter(Boolean) : []),
    () => [] as string[],
  );

  const accounts = await Promise.all([
    accountBilling(run, login, "user", planName(user), period),
    ...orgs.map(async (org) => {
      const plan = await getJson(run, `orgs/${org}`).then(planName, () => null);
      return accountBilling(run, org, "org", plan, period);
    }),
  ]);
  return { ...empty, accounts };
}

let cache: { at: number; payload: GithubActionsBillingPayload } | null = null;
let inflight: Promise<GithubActionsBillingPayload> | null = null;

/**
 * This month's Actions allowance per account, cached for {@link TTL_MS} ({@link ERROR_TTL_MS}
 * when an account failed). Never throws: an unreadable account carries its status instead.
 */
export async function fetchGithubActionsBilling(
  run: GhRun,
  now: () => number = () => Date.now(),
): Promise<GithubActionsBillingPayload> {
  const t = now();
  if (cache) {
    const failed = cache.payload.accounts.some((a) => a.status === "error");
    if (t - cache.at < (failed ? ERROR_TTL_MS : TTL_MS)) return cache.payload;
  }
  inflight ??= readBilling(run, t)
    .then((payload) => {
      cache = { at: t, payload };
      return payload;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Test-only: drop the module cache so each case starts cold. */
export function __resetGithubActionsBillingCache(): void {
  cache = null;
  inflight = null;
}
