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
import type { Schedule, ScheduleInput, ScheduleOutcome } from "#lib/types.js";

/**
 * Per-repo operator schedules (#3469) for the automation settings. Loaded on demand per repo and
 * re-read on `schedules:changed`. Keyed by `SvelteMap`: `repoPath` arrives off the event stream,
 * so it must never become a property name. Every write re-reads the list (the server owns
 * `nextAt` / `lastRun`); a failed write says so in a toast and returns false. The every-repo list
 * (#3475, Settings → Schedules) is loaded on demand too, and re-read alongside once loaded.
 */
class SchedulesStore {
  #lists = new SvelteMap<string, Schedule[]>();
  #all = $state<Schedule[] | null>(null);
  /** The last every-repo read failed (a list shown before it stays as it was). */
  #allFailed = $state(false);

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
      toasts.info(m.schedules_run_now_result({ name: s.name, outcome: outcomeLabel(run.outcome) }));
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
    await Promise.all([this.load(repoPath), this.#allWanted && this.loadAll()]);
  }
}

export const schedules = new SchedulesStore();

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
export function outcomeLabel(outcome: ScheduleOutcome): string {
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
      return m.schedules_outcome_stale();
    case "error":
      return m.schedules_outcome_error();
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
export function cadenceSummary(days: number, times: string[], locale?: string): string {
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
  return `${runs.join(", ")} · ${times.join(", ")}`;
}
