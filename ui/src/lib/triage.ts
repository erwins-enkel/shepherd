import type { Session, BlockReason, HoldReason } from "./types";

export interface BlockState {
  reason: BlockReason;
  since: number;
}

export interface BlockedEntry {
  session: Session;
  reason: BlockReason;
  since: number;
  // hold reason for this session, when present — set by sortBlocked if a holds map is passed
  hold?: HoldReason;
}

/** Blocked sessions that have a classified reason, oldest-blocked first. */
export function sortBlocked(
  sessions: Session[],
  blocks: Record<string, BlockState>,
  holds?: Record<string, HoldReason>,
): BlockedEntry[] {
  return sessions
    .filter((s) => blocks[s.id])
    .map((s) => ({
      session: s,
      reason: blocks[s.id]!.reason,
      since: blocks[s.id]!.since,
      hold: holds?.[s.id],
    }))
    .sort((a, b) => a.since - b.since);
}
