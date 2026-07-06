import type { Session } from "./types";

export function doneSessionsForRepoFilter(
  sessions: Session[],
  repoFilter: ReadonlySet<string>,
): Session[] {
  if (repoFilter.size === 0) return sessions;
  return sessions.filter((s) => repoFilter.has(s.repoPath));
}

export function resolveDoneSelected(
  sessions: Session[],
  selectedId: string | null,
): Session | null {
  return sessions.find((s) => s.id === selectedId) ?? null;
}

export function nextDoneSelectedId(sessions: Session[], selectedId: string | null): string | null {
  if (sessions.length === 0) return null;
  if (sessions.some((s) => s.id === selectedId)) return selectedId;
  return sessions[0].id;
}

export function doneRailIds(sessions: Session[]): string[] {
  return sessions.map((s) => s.id);
}
