import type { Session, BlockReason } from "./types";

export interface BlockState {
  reason: BlockReason;
  since: number;
}

export interface BlockedEntry {
  session: Session;
  reason: BlockReason;
  since: number;
}

/** Blocked sessions that have a classified reason, oldest-blocked first. */
export function sortBlocked(
  sessions: Session[],
  blocks: Record<string, BlockState>,
): BlockedEntry[] {
  return sessions
    .filter((s) => blocks[s.id])
    .map((s) => ({ session: s, reason: blocks[s.id]!.reason, since: blocks[s.id]!.since }))
    .sort((a, b) => a.since - b.since);
}
