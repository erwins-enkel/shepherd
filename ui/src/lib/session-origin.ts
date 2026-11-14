import type { Session } from "./types";

/** Who started a session (#3999): a repo schedule, the auto-drain queue, or the operator. */
export type SessionOrigin = "scheduled" | "drain" | "manual";

export type OriginCounts = Record<SessionOrigin, number>;

type OriginFields = Pick<Session, "auto" | "scheduleId">;

/** A scheduled run counts as scheduled even when it is also an unattended spawn. */
export function sessionOrigin(s: OriginFields): SessionOrigin {
  if (s.scheduleId) return "scheduled";
  return s.auto ? "drain" : "manual";
}

/** Narrows a list to one origin; null keeps every session. */
export function byOrigin<T extends OriginFields>(list: T[], origin: SessionOrigin | null): T[] {
  return origin == null ? list : list.filter((s) => sessionOrigin(s) === origin);
}

export function originCounts(list: readonly OriginFields[]): OriginCounts {
  const counts: OriginCounts = { scheduled: 0, drain: 0, manual: 0 };
  for (const s of list) counts[sessionOrigin(s)]++;
  return counts;
}

/** Whether the origin filter is worth offering (#3999): only on a lens that lists sessions, and
 *  only once a non-manual session is in it (or the filter is on) — a manual-only herd keeps its
 *  chrome unchanged. */
export function originFilterOffered(
  lens: string,
  filter: SessionOrigin | null,
  counts: OriginCounts,
): boolean {
  if (lens !== "all" && lens !== "ready" && lens !== "done") return false;
  return filter != null || counts.scheduled + counts.drain > 0;
}
