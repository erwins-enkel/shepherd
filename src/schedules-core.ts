/**
 * Pure helpers for operator schedules (#3469) — no I/O, no DB, no spawn.
 *
 * A schedule fires a prompt on a weekday mask × wall-clock times, in SERVER-LOCAL time like every
 * other Shepherd cadence. Slots are keyed by their NOMINAL local date + time (`2026-10-27T09:00`):
 * a spring-forward gap normalizes forward (the `Date` constructor rolls 02:30 to 03:30, so the slot
 * fires at the first tick after it) and a fall-back repeat yields the same key (fires once).
 *
 * The scheduler only ever considers the LATEST due slot. That one rule gives on-time firing and
 * catch-up-once: a missed slot fires when Shepherd comes back, unless a newer slot already arrived
 * (then only the newer one). A missed slot older than {@link STALE_MS} is recorded as stale
 * instead — a weekend-old run is never what the operator wants on Monday morning. Intervals use
 * one interval as their stale cap and collapse spring-forward collisions to one nominal slot.
 */
import { AGENT_PROVIDERS, type AgentProvider, type StandardCreateInput } from "./types";
import type { SandboxProfile } from "./sandbox";
import { validateCreate } from "./validate";

/** A missed slot older than this is skipped (`skipped:stale`), never caught up. */
export const STALE_MS = 12 * 60 * 60 * 1000;

/** All seven days, bit 0 = Monday … bit 6 = Sunday. */
export const ALL_DAYS = 0b1111111;
/** Weekday names in bit order (bit 0 = Monday), for agent-facing tools. */
export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

/** Weekday names → bitmask, or null when the list is empty or names an unknown day. */
export function daysToMask(names: readonly unknown[]): number | null {
  let mask = 0;
  for (const n of names) {
    const i = WEEKDAYS.indexOf(n as (typeof WEEKDAYS)[number]);
    if (i < 0) return null;
    mask |= 1 << i;
  }
  return mask || null;
}

/** Bitmask → weekday names, Monday first. */
export function maskToDays(mask: number): string[] {
  return WEEKDAYS.filter((_, i) => mask & (1 << i));
}

const MAX_TIMES = 12;
const MAX_NAME = 80;

/** New Task launch options a schedule carries. `null` model/effort/provider = the default at fire
 *  time; `null` autopilot/plan gate = inherit the repo default; `null` baseBranch = the repo's
 *  default branch, resolved at fire time. */
export interface ScheduleLaunch {
  agentProvider: AgentProvider | null;
  model: string | null;
  effort: string | null;
  autopilotEnabled: boolean | null;
  planGateEnabled: boolean | null;
  research: boolean;
  sandboxProfile: SandboxProfile | null;
  baseBranch: string | null;
}

export interface ScheduleInterval {
  everyMinutes: 5 | 10 | 15 | 30 | 60;
  from: string | null;
  until: string | null;
}

export type ScheduleLimitAction = "skip" | "wait" | "otherProvider";

export type ScheduleUsageLimit = (
  | { kind: "upTo"; stopPct: number }
  | { kind: "from"; startPct: number; startWindow: "week" | "5h"; stopPct: number }
) & { onMismatch?: ScheduleLimitAction };

export interface ScheduleUsage {
  provider: AgentProvider;
  window: "week" | "5h" | "max";
  usedPct: number | null;
  thresholdPct: number;
}

export type UsageLimitReason = "below-start" | "stop-reached" | "usage-unknown";
export interface ScheduleUsageWindows {
  week: number | null;
  session5h: number | null;
}

/** Uses the same computed Claude windows as usage-hold; Codex has its own snapshot. */
export function scheduleUsageWindows(
  limits: Pick<import("./usage-limits").UsageLimits, "week" | "session5h" | "providers"> | null,
  provider: AgentProvider,
): ScheduleUsageWindows {
  const source =
    provider === "claude" ? limits : limits?.providers?.find((p) => p.provider === "codex");
  return { week: source?.week?.pct ?? null, session5h: source?.session5h?.pct ?? null };
}

/** Stop always wins; unknown windows count as zero only for the stop check. */
export function decideUsageLimit(
  limit: ScheduleUsageLimit,
  provider: AgentProvider,
  windows: ScheduleUsageWindows,
): { allowed: boolean; reason: UsageLimitReason | null; usage: ScheduleUsage } {
  const max =
    windows.week === null && windows.session5h === null
      ? null
      : Math.max(windows.week ?? 0, windows.session5h ?? 0);
  let usage: ScheduleUsage = { provider, window: "max", usedPct: max, thresholdPct: limit.stopPct };
  let reason: UsageLimitReason | null = null;
  if ((max ?? 0) >= limit.stopPct) reason = "stop-reached";
  else if (limit.kind === "from") {
    const usedPct = limit.startWindow === "week" ? windows.week : windows.session5h;
    usage = { provider, window: limit.startWindow, usedPct, thresholdPct: limit.startPct };
    if (usedPct === null) reason = "usage-unknown";
    else if (usedPct < limit.startPct) reason = "below-start";
  }
  return { allowed: reason === null, reason, usage };
}

export interface Schedule {
  id: string;
  repoPath: string;
  name: string;
  prompt: string;
  days: number;
  times: string[];
  interval: ScheduleInterval | null;
  usageLimit: ScheduleUsageLimit | null;
  enabled: boolean;
  launch: ScheduleLaunch;
  /** Slots before this instant never fire — stamped on create, enable and cadence edits. */
  baselineAt: number;
  createdAt: number;
  updatedAt: number;
}

export type ScheduleOutcome =
  | "claimed"
  | "spawned"
  | "spawned:failover"
  | "waiting:limit"
  | "skipped:limit-expired"
  | "held"
  | "skipped:overlap"
  | "skipped:stale"
  | "skipped:limit"
  | "error"
  | "noop";

export interface ScheduleRun {
  id: number;
  scheduleId: string;
  slotKey: string;
  outcome: ScheduleOutcome;
  sessionId: string | null;
  reason: string | null;
  usage: ScheduleUsage | null;
  at: number;
}

/** The editable fields of a schedule, validated. */
export interface ScheduleInput {
  repoPath: string;
  name: string;
  prompt: string;
  days: number;
  times: string[];
  interval: ScheduleInterval | null;
  usageLimit: ScheduleUsageLimit | null;
  enabled: boolean;
  launch: ScheduleLaunch;
}

export const DEFAULT_LAUNCH: ScheduleLaunch = {
  agentProvider: null,
  model: null,
  effort: null,
  // Attended by default: a scheduled prompt like /triage-feedback asks the operator to confirm.
  autopilotEnabled: false,
  planGateEnabled: null,
  research: false,
  sandboxProfile: null,
  baseBranch: null,
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const KEYS = new Set([
  "repoPath",
  "name",
  "prompt",
  "days",
  "times",
  "interval",
  "usageLimit",
  "enabled",
  "launch",
]);
/** The launch options a schedule carries, by name. */
export const SCHEDULE_LAUNCH_KEYS = Object.keys(DEFAULT_LAUNCH) as (keyof ScheduleLaunch)[];
const LAUNCH_KEYS = new Set<string>(SCHEDULE_LAUNCH_KEYS);

type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Monday = bit 0 … Sunday = bit 6 for a local date. */
function dayBit(d: Date): number {
  return 1 << ((d.getDay() + 6) % 7);
}

function slotKeyOf(day: Date, time: string): string {
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}T${time}`;
}

function slotAt(day: Date, time: string): number {
  const [h, m] = time.split(":").map(Number) as [number, number];
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).getTime();
}

export interface Slot {
  slotKey: string;
  at: number;
}

/** The slots of one local day (`offset` days from `now`'s day), in time order. */
function slotsOn(
  days: number,
  times: readonly string[],
  now: number,
  offset: number,
  interval: ScheduleInterval | null,
): Slot[] {
  const base = new Date(now);
  const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset);
  if (!(days & dayBit(day))) return [];
  if (!interval) return times.map((t) => ({ slotKey: slotKeyOf(day, t), at: slotAt(day, t) }));
  const minuteOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const start = interval.from === null ? 0 : minuteOf(interval.from);
  const end = interval.until === null ? 1440 : minuteOf(interval.until);
  const slots = new Map<number, Slot>();
  for (let minute = start; minute < end; minute += interval.everyMinutes) {
    const time = `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;
    const at = slotAt(day, time);
    // Spring-forward normalization can map two nominal times onto the same instant.
    if (!slots.has(at)) slots.set(at, { slotKey: slotKeyOf(day, time), at });
  }
  return [...slots.values()].sort((a, b) => a.at - b.at);
}

/** The latest slot at or before `now`, or null when none falls within the last week. */
export function latestDueSlot(
  days: number,
  times: readonly string[],
  now: number,
  interval: ScheduleInterval | null = null,
): Slot | null {
  for (let back = 0; back <= 7; back++) {
    const due = slotsOn(days, times, now, -back, interval).filter((s) => s.at <= now);
    if (due.length) return due.reduce((a, b) => (b.at > a.at ? b : a));
  }
  return null;
}

/** The next slot strictly after `now`, or null for an empty cadence. */
export function nextSlot(
  days: number,
  times: readonly string[],
  now: number,
  interval: ScheduleInterval | null = null,
): Slot | null {
  for (let ahead = 0; ahead <= 7; ahead++) {
    const later = slotsOn(days, times, now, ahead, interval).filter((s) => s.at > now);
    if (later.length) return later.reduce((a, b) => (b.at < a.at ? b : a));
  }
  return null;
}

/** Waiting rows use the nominal local slot, never the (possibly late) claim timestamp. */
export function waitingLimitExpiresAt(
  s: Pick<Schedule, "days" | "times" | "interval">,
  slotKey: string,
): number {
  const [date, time] = slotKey.split("T") as [string, string];
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const nominal = slotAt(new Date(year, month - 1, day), time);
  return Math.min(
    nominal + STALE_MS,
    nextSlot(s.days, s.times, nominal, s.interval)?.at ?? Infinity,
  );
}

/** What the tick does with a schedule's latest due slot. */
export function decideFiring(args: {
  slot: Slot | null;
  baselineAt: number;
  hasRow: boolean;
  now: number;
  interval?: ScheduleInterval | null;
}): "none" | "stale" | "fire" {
  const { slot, baselineAt, hasRow, now } = args;
  if (!slot || slot.at < baselineAt || hasRow) return "none";
  return now - slot.at > (args.interval ? args.interval.everyMinutes * 60_000 : STALE_MS)
    ? "stale"
    : "fire";
}

function validateUsageLimitAction(raw: unknown): Result<Pick<ScheduleUsageLimit, "onMismatch">> {
  if (raw === undefined) return { ok: true, value: {} };
  if (raw !== "skip" && raw !== "wait" && raw !== "otherProvider")
    return fail("usageLimit.onMismatch must be skip, wait or otherProvider");
  return { ok: true, value: { onMismatch: raw } };
}

function validateUsageLimit(raw: unknown): Result<ScheduleUsageLimit | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "object" || Array.isArray(raw))
    return fail("usageLimit must be an object or null");
  const obj = raw as Record<string, unknown>;
  const keys =
    obj.kind === "from" ? ["kind", "startPct", "startWindow", "stopPct"] : ["kind", "stopPct"];
  if (Object.keys(obj).some((key) => ![...keys, "onMismatch"].includes(key)))
    return fail("unknown usageLimit key");
  const action = validateUsageLimitAction(obj.onMismatch);
  if (!action.ok) return action;
  const pct = (v: unknown, min: number, max: number): v is number =>
    typeof v === "number" && Number.isInteger(v) && v % 5 === 0 && v >= min && v <= max;
  if (!pct(obj.stopPct, 5, 100)) return fail("usageLimit.stopPct must be 5–100 in steps of 5");
  if (obj.kind === "upTo")
    return { ok: true, value: { kind: "upTo", stopPct: obj.stopPct, ...action.value } };
  if (obj.kind !== "from") return fail("usageLimit.kind must be upTo or from");
  if (!pct(obj.startPct, 0, 95) || obj.startPct >= obj.stopPct)
    return fail("usageLimit.startPct must be 0–95 in steps of 5 and less than stopPct");
  if (obj.startWindow !== "week" && obj.startWindow !== "5h")
    return fail("usageLimit.startWindow must be week or 5h");
  return {
    ok: true,
    value: {
      kind: "from",
      ...action.value,
      startPct: obj.startPct,
      startWindow: obj.startWindow,
      stopPct: obj.stopPct,
    },
  };
}

function validateInterval(raw: unknown): Result<ScheduleInterval | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "object" || Array.isArray(raw))
    return fail("interval must be an object or null");
  const obj = raw as Record<string, unknown>;
  if (Object.keys(obj).some((key) => !["everyMinutes", "from", "until"].includes(key)))
    return fail("unknown interval key");
  if (![5, 10, 15, 30, 60].includes(obj.everyMinutes as number))
    return fail("interval.everyMinutes must be 5, 10, 15, 30 or 60");
  if (obj.from === null && obj.until === null)
    return {
      ok: true,
      value: {
        everyMinutes: obj.everyMinutes as ScheduleInterval["everyMinutes"],
        from: null,
        until: null,
      },
    };
  if (
    typeof obj.from !== "string" ||
    !TIME_RE.test(obj.from) ||
    typeof obj.until !== "string" ||
    !TIME_RE.test(obj.until)
  )
    return fail('interval.from and interval.until must both be "HH:MM" or both null');
  if (obj.until <= obj.from) return fail("until must be after from");
  return {
    ok: true,
    value: {
      everyMinutes: obj.everyMinutes as ScheduleInterval["everyMinutes"],
      from: obj.from,
      until: obj.until,
    },
  };
}

function validateTimes(raw: unknown, interval = false): Result<string[]> {
  if (interval) {
    if (!Array.isArray(raw) || raw.length !== 0) return fail("times must be [] with an interval");
    return { ok: true, value: [] };
  }
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_TIMES)
    return fail(`times must be 1–${MAX_TIMES} "HH:MM" strings`);
  if (!raw.every((t) => typeof t === "string" && TIME_RE.test(t)))
    return fail('times must be "HH:MM" (00:00–23:59)');
  return { ok: true, value: [...new Set(raw as string[])].sort() };
}

function validateCadence(
  timesRaw: unknown,
  intervalRaw: unknown,
): Result<{ times: string[]; interval: ScheduleInterval | null }> {
  const interval = validateInterval(intervalRaw);
  if (!interval.ok) return interval;
  const times = validateTimes(timesRaw, interval.value !== null);
  if (!times.ok) return times;
  return { ok: true, value: { times: times.value, interval: interval.value } };
}

function nullableBool(v: unknown, name: string): Result<boolean | null> {
  if (v === null || typeof v === "boolean") return { ok: true, value: v };
  return fail(`launch.${name} must be a boolean or null`);
}

function validateLaunch(raw: unknown): Result<ScheduleLaunch> {
  if (raw === undefined) return { ok: true, value: { ...DEFAULT_LAUNCH } };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return fail("launch must be an object");
  const obj = raw as Record<string, unknown>;
  const stray = Object.keys(obj).find((k) => !LAUNCH_KEYS.has(k));
  if (stray) return fail(`unknown key: launch.${stray}`);
  const merged = { ...DEFAULT_LAUNCH, ...obj } as Record<string, unknown>;
  const autopilot = nullableBool(merged.autopilotEnabled, "autopilotEnabled");
  if (!autopilot.ok) return autopilot;
  const planGate = nullableBool(merged.planGateEnabled, "planGateEnabled");
  if (!planGate.ok) return planGate;
  if (typeof merged.research !== "boolean") return fail("launch.research must be a boolean");
  if (merged.agentProvider !== null && !AGENT_PROVIDERS.includes(merged.agentProvider as never))
    return fail("launch.agentProvider must be one of: claude, codex");
  for (const k of ["model", "effort", "sandboxProfile", "baseBranch"] as const)
    if (merged[k] !== null && typeof merged[k] !== "string")
      return fail(`launch.${k} must be a string or null`);
  return { ok: true, value: merged as unknown as ScheduleLaunch };
}

function validateScheduleOptions(
  obj: Record<string, unknown>,
): Result<Pick<ScheduleInput, "launch" | "usageLimit">> {
  const launch = validateLaunch(obj.launch);
  if (!launch.ok) return launch;
  const usageLimit = validateUsageLimit(obj.usageLimit);
  if (!usageLimit.ok) return usageLimit;
  return { ok: true, value: { launch: launch.value, usageLimit: usageLimit.value } };
}

/**
 * Validate a full schedule body. The launch options and prompt are re-checked through the New
 * Task validator ({@link scheduleCreateInput}) so a schedule can never store a launch the create
 * path would refuse.
 */
export function validateScheduleInput(body: unknown, repoRoot: string): Result<ScheduleInput> {
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return fail("body must be a non-null object");
  const obj = body as Record<string, unknown>;
  const stray = Object.keys(obj).find((k) => !KEYS.has(k));
  if (stray) return fail(`unknown key: ${stray}`);
  if (typeof obj.name !== "string" || !obj.name.trim() || obj.name.trim().length > MAX_NAME)
    return fail(`name must be 1–${MAX_NAME} chars`);
  if (typeof obj.prompt !== "string") return fail("prompt must be a string");
  if (!Number.isInteger(obj.days) || (obj.days as number) < 1 || (obj.days as number) > ALL_DAYS)
    return fail("days must be a weekday bitmask 1–127 (bit 0 = Monday)");
  const cadence = validateCadence(obj.times, obj.interval);
  if (!cadence.ok) return cadence;
  if (obj.enabled !== undefined && typeof obj.enabled !== "boolean")
    return fail("enabled must be a boolean");
  const options = validateScheduleOptions(obj);
  if (!options.ok) return options;
  const value: ScheduleInput = {
    repoPath: obj.repoPath as string,
    name: obj.name.trim(),
    prompt: obj.prompt.trim(),
    days: obj.days as number,
    ...cadence.value,
    ...options.value,
    enabled: obj.enabled ?? true,
  };
  const create = scheduleCreateInput(value, value.launch.baseBranch ?? "main", repoRoot);
  if (!create.ok) return create;
  return { ok: true, value: { ...value, repoPath: create.value.repoPath } };
}

/** The New Task create input a firing launches, through the same validator as POST /api/sessions. */
export function scheduleCreateInput(
  s: Pick<ScheduleInput, "repoPath" | "prompt" | "launch">,
  baseBranch: string,
  repoRoot: string,
): Result<StandardCreateInput> {
  const { launch } = s;
  const body: Record<string, unknown> = {
    repoPath: s.repoPath,
    prompt: s.prompt,
    baseBranch,
    model: launch.model,
    effort: launch.effort,
    research: launch.research,
    ...(launch.agentProvider !== null && { agentProvider: launch.agentProvider }),
    ...(launch.autopilotEnabled !== null && { autopilotEnabled: launch.autopilotEnabled }),
    ...(launch.planGateEnabled !== null && { planGateEnabled: launch.planGateEnabled }),
    ...(launch.sandboxProfile !== null && { sandboxProfile: launch.sandboxProfile }),
  };
  const r = validateCreate(body, repoRoot);
  if (!r.ok) return r;
  if (r.value.terminal === true) return fail("not a task");
  return { ok: true, value: r.value };
}
