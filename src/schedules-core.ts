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
 * instead — a weekend-old run is never what the operator wants on Monday morning.
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

export interface Schedule {
  id: string;
  repoPath: string;
  name: string;
  prompt: string;
  days: number;
  times: string[];
  enabled: boolean;
  launch: ScheduleLaunch;
  /** Slots before this instant never fire — stamped on create, enable and cadence edits. */
  baselineAt: number;
  createdAt: number;
  updatedAt: number;
}

export type ScheduleOutcome =
  "claimed" | "spawned" | "held" | "skipped:overlap" | "skipped:stale" | "error";

export interface ScheduleRun {
  id: number;
  scheduleId: string;
  slotKey: string;
  outcome: ScheduleOutcome;
  sessionId: string | null;
  reason: string | null;
  at: number;
}

/** The editable fields of a schedule, validated. */
export interface ScheduleInput {
  repoPath: string;
  name: string;
  prompt: string;
  days: number;
  times: string[];
  enabled: boolean;
  launch: ScheduleLaunch;
}

const DEFAULT_LAUNCH: ScheduleLaunch = {
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
const KEYS = new Set(["repoPath", "name", "prompt", "days", "times", "enabled", "launch"]);
const LAUNCH_KEYS = new Set(Object.keys(DEFAULT_LAUNCH));

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
function slotsOn(days: number, times: readonly string[], now: number, offset: number): Slot[] {
  const base = new Date(now);
  const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset);
  if (!(days & dayBit(day))) return [];
  return times.map((t) => ({ slotKey: slotKeyOf(day, t), at: slotAt(day, t) }));
}

/** The latest slot at or before `now`, or null when none falls within the last week. */
export function latestDueSlot(days: number, times: readonly string[], now: number): Slot | null {
  for (let back = 0; back <= 7; back++) {
    const due = slotsOn(days, times, now, -back).filter((s) => s.at <= now);
    if (due.length) return due.reduce((a, b) => (b.at > a.at ? b : a));
  }
  return null;
}

/** The next slot strictly after `now`, or null for an empty cadence. */
export function nextSlot(days: number, times: readonly string[], now: number): Slot | null {
  for (let ahead = 0; ahead <= 7; ahead++) {
    const later = slotsOn(days, times, now, ahead).filter((s) => s.at > now);
    if (later.length) return later.reduce((a, b) => (b.at < a.at ? b : a));
  }
  return null;
}

/** What the tick does with a schedule's latest due slot. */
export function decideFiring(args: {
  slot: Slot | null;
  baselineAt: number;
  hasRow: boolean;
  now: number;
}): "none" | "stale" | "fire" {
  const { slot, baselineAt, hasRow, now } = args;
  if (!slot || slot.at < baselineAt || hasRow) return "none";
  return now - slot.at > STALE_MS ? "stale" : "fire";
}

function validateTimes(raw: unknown): Result<string[]> {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_TIMES)
    return fail(`times must be 1–${MAX_TIMES} "HH:MM" strings`);
  if (!raw.every((t) => typeof t === "string" && TIME_RE.test(t)))
    return fail('times must be "HH:MM" (00:00–23:59)');
  return { ok: true, value: [...new Set(raw as string[])].sort() };
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
  const times = validateTimes(obj.times);
  if (!times.ok) return times;
  if (obj.enabled !== undefined && typeof obj.enabled !== "boolean")
    return fail("enabled must be a boolean");
  const launch = validateLaunch(obj.launch);
  if (!launch.ok) return launch;
  const value: ScheduleInput = {
    repoPath: obj.repoPath as string,
    name: obj.name.trim(),
    prompt: obj.prompt.trim(),
    days: obj.days as number,
    times: times.value,
    enabled: obj.enabled ?? true,
    launch: launch.value,
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
