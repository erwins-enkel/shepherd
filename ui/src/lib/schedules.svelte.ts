import { m } from "#lib/paraglide/messages.js";
import {
  createSchedule,
  deleteSchedule,
  listSchedules,
  patchSchedule,
  runScheduleNow,
} from "#lib/api.js";
import { SvelteMap } from "svelte/reactivity";
import { toasts } from "#lib/toasts.svelte.js";
import { basename } from "#lib/basename.js";
import type { Schedule, ScheduleInput, ScheduleInterval } from "#lib/types.js";

/**
 * Per-repo operator schedules (#3469) for the automation settings. Loaded on demand per repo and
 * re-read on `schedules:changed`. Keyed by `SvelteMap`: `repoPath` arrives off the event stream,
 * so it must never become a property name. Every write re-reads the list (the server owns
 * `nextAt` / `lastRun`); a failed write says so in a toast and returns false. The every-repo list
 * (#3475, Settings → Schedules) is loaded on demand too, and re-read alongside once loaded.
 */
class SchedulesStore {
  #revisions = new SvelteMap<string, number>();
  #lists = new SvelteMap<string, Schedule[]>();
  #all = $state<Schedule[] | null>(null);
  /** The last every-repo read failed (a list shown before it stays as it was). */
  #allFailed = $state(false);

  /** Invalidates an open history independently of whether the schedule list can reload. */
  revisionFor(repoPath: string): number {
    return this.#revisions.get(repoPath) ?? 0;
  }

  listFor(repoPath: string): Schedule[] | null {
    return this.#lists.get(repoPath) ?? null;
  }

  /** Every repo's schedules; null until `loadAll` has answered. */
  all(): Schedule[] | null {
    return this.#all;
  }

  allFailed(): boolean {
    return this.#allFailed;
  }

  async loadAll(): Promise<void> {
    try {
      this.#all = await listSchedules();
      this.#allFailed = false;
    } catch {
      this.#allFailed = true;
    }
  }

  /** The every-repo list has been asked for (loaded, or failed and still worth retrying). */
  get #allWanted(): boolean {
    return this.#all !== null || this.#allFailed;
  }

  async load(repoPath: string): Promise<void> {
    try {
      this.#lists.set(repoPath, await listSchedules(repoPath));
    } catch {
      /* unknown state renders nothing; the next open retries */
    }
  }

  /** The server says `repoPath`'s schedules changed: re-read when a view shows them. */
  refresh(repoPath: string): void {
    this.#revisions.set(repoPath, this.revisionFor(repoPath) + 1);
    if (this.#lists.has(repoPath)) void this.load(repoPath);
    if (this.#allWanted) void this.loadAll();
  }

  /** Create (no id) or update a schedule. */
  save(input: ScheduleInput, id?: string): Promise<boolean> {
    const { repoPath, ...patch } = input;
    return this.#write(repoPath, () => (id ? patchSchedule(id, patch) : createSchedule(input)));
  }

  setEnabled(s: Schedule, enabled: boolean): Promise<boolean> {
    return this.#write(s.repoPath, () => patchSchedule(s.id, { enabled }));
  }

  remove(s: Schedule): Promise<boolean> {
    return this.#write(s.repoPath, () => deleteSchedule(s.id));
  }

  async runNow(s: Schedule): Promise<void> {
    try {
      const run = await runScheduleNow(s.id);
      toasts.info(
        m.schedules_run_now_result({
          name: s.name,
          outcome: outcomeLabel(run.outcome, run.reason),
        }),
      );
    } catch {
      toasts.info(m.schedules_failed(), { alert: true });
    }
    await this.#reload(s.repoPath);
  }

  async #write(repoPath: string, op: () => Promise<unknown>): Promise<boolean> {
    try {
      await op();
      return true;
    } catch {
      toasts.info(m.schedules_failed(), { alert: true });
      return false;
    } finally {
      await this.#reload(repoPath);
    }
  }

  async #reload(repoPath: string): Promise<void> {
    this.#revisions.set(repoPath, this.revisionFor(repoPath) + 1);
    await Promise.all([this.load(repoPath), this.#allWanted && this.loadAll()]);
  }
}

export const schedules = new SchedulesStore();

/** Read-only live usage supplied by AppOverlays to both schedule-dialog entry points. */
export const SCHEDULE_USAGE = Symbol("schedule-usage");

/** Soonest next run first; disabled schedules (no next run) last, by repo then name. */
export function upcomingOrder(list: readonly Schedule[]): Schedule[] {
  const key = (s: Schedule) => `${basename(s.repoPath)}\u0000${s.name}`;
  return [...list].sort((a, b) => {
    if (a.nextAt !== b.nextAt) {
      if (a.nextAt === null) return 1;
      if (b.nextAt === null) return -1;
      return a.nextAt - b.nextAt;
    }
    return key(a).localeCompare(key(b));
  });
}

/** A run outcome as the operator reads it. */
export function outcomeLabel(outcome: string, reason?: string | null): string {
  switch (outcome) {
    case "claimed":
      return m.schedules_outcome_interrupted();
    case "spawned":
      return m.schedules_outcome_spawned();
    case "held":
      return m.schedules_outcome_held();
    case "skipped:overlap":
      return m.schedules_outcome_overlap();
    case "skipped:stale":
      return reason === "missed by more than one interval"
        ? m.schedules_outcome_interval_stale()
        : m.schedules_outcome_stale();
    case "error":
      return m.schedules_outcome_error();
    case "noop":
      return m.schedules_outcome_noop();
    default:
      return outcome;
  }
}

/** Shared by the last-run disclosure and its history entries. */
export function outcomeTone(outcome: string): "red" | "amber" | "neutral" {
  switch (outcome) {
    case "error":
    case "claimed":
      return "red";
    case "held":
    case "skipped:overlap":
    case "skipped:stale":
      return "amber";
    default:
      return "neutral";
  }
}

/** Monday-first weekday short names in the active locale (bit 0 = Monday). */
export function weekdayNames(locale?: string): string[] {
  // Formatted in UTC: the instants are UTC noons, so a browser at UTC+13 must not roll them
  // into the next day (which would put "Mon" on the Sunday bit).
  const fmt = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
  // 2024-01-01 was a Monday (UTC epoch ms; formatted, never mutated).
  return Array.from({ length: 7 }, (_, i) => fmt.format(Date.UTC(2024, 0, 1 + i, 12)));
}

export const WORKDAYS = 0b0011111;
export const ALL_DAYS = 0b1111111;

/** "Mon–Fri · 09:00, 18:00": contiguous day runs collapse to a range. */
export function cadenceSummary(
  days: number,
  times: string[],
  locale?: string,
  interval: ScheduleInterval | null = null,
): string {
  const names = weekdayNames(locale);
  const runs: string[] = [];
  let i = 0;
  while (i < 7) {
    if (!(days & (1 << i))) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < 7 && days & (1 << (j + 1))) j++;
    runs.push(j - i >= 2 ? `${names[i]}–${names[j]}` : names.slice(i, j + 1).join(", "));
    i = j + 1;
  }
  const dayLabel = runs.join(", ");
  if (interval)
    return interval.from === null
      ? m.schedules_cadence_interval_all_day({ days: dayLabel, n: interval.everyMinutes })
      : m.schedules_cadence_interval_window({
          days: dayLabel,
          n: interval.everyMinutes,
          from: interval.from,
          until: interval.until!,
        });
  return `${dayLabel} · ${times.join(", ")}`;
}

/** Nominal daily times; invalid drafts produce no slots. */
function intervalTimes(interval: ScheduleInterval): string[] {
  const { from, until, everyMinutes } = interval;
  const valid = (time: string | null): time is string =>
    time !== null && /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
  if (!(from === null && until === null) && (!valid(from) || !valid(until) || until <= from))
    return [];
  const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const start = from === null ? 0 : minutes(from);
  const end = until === null ? 1440 : minutes(until);
  const times: string[] = [];
  for (let minute = start; minute < end; minute += everyMinutes)
    times.push(
      `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`,
    );
  return times;
}

export function intervalStats(
  days: number,
  interval: ScheduleInterval,
): { perDay: number; perWeek: number; last: string } | null {
  const times = intervalTimes(interval);
  if (!times.length) return null;
  const activeDays = Array.from({ length: 7 }, (_, i) => !!(days & (1 << i))).filter(
    Boolean,
  ).length;
  return {
    perDay: times.length,
    perWeek: times.length * activeDays,
    last: times[times.length - 1]!,
  };
}

/* eslint-disable svelte/prefer-svelte-reactivity -- pure calculation; Dates/Sets are local scratch values. */
/** Browser-local preview of the server's nextSlot rule. Does not normalize saved times. */
export function upcomingSlots(
  days: number,
  times: readonly string[],
  now: number,
  n: number,
  interval: ScheduleInterval | null = null,
): number[] {
  const clockTimes = interval
    ? intervalTimes(interval)
    : [...new Set(times.filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)))];
  if (!(days & ALL_DAYS) || !clockTimes.length || n <= 0) return [];
  const base = new Date(now);
  const result: number[] = [];
  // Even one active weekday with one time supplies n slots within n weeks plus today.
  for (let ahead = 0; ahead <= 7 * n && result.length < n; ahead++) {
    const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + ahead);
    if (!(days & (1 << ((day.getDay() + 6) % 7)))) continue;
    const slots = clockTimes.map((time) => {
      const [hour, minute] = time.split(":").map(Number);
      return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute).getTime();
    });
    result.push(...[...new Set(slots)].filter((at) => at > now).sort((a, b) => a - b));
  }
  return result.slice(0, n);
}

/* eslint-enable svelte/prefer-svelte-reactivity */
