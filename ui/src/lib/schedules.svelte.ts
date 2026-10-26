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
import type { Schedule, ScheduleInput, ScheduleOutcome } from "#lib/types.js";

/**
 * Per-repo operator schedules (#3469) for the automation settings. Loaded on demand per repo and
 * re-read on `schedules:changed`. Keyed by `SvelteMap`: `repoPath` arrives off the event stream,
 * so it must never become a property name. Every write re-reads the list (the server owns
 * `nextAt` / `lastRun`); a failed write says so in a toast and returns false.
 */
class SchedulesStore {
  #lists = new SvelteMap<string, Schedule[]>();

  listFor(repoPath: string): Schedule[] | null {
    return this.#lists.get(repoPath) ?? null;
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
    await this.load(s.repoPath);
  }

  async #write(repoPath: string, op: () => Promise<unknown>): Promise<boolean> {
    try {
      await op();
      return true;
    } catch {
      toasts.info(m.schedules_failed(), { alert: true });
      return false;
    } finally {
      await this.load(repoPath);
    }
  }
}

export const schedules = new SchedulesStore();

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
