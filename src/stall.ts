import { readFileSync } from "node:fs";
import { latestRecordTs, parseActivity } from "./activity";

/** A minimal read of a session's most-recent tool activity, for stall detection. */
export interface ActivitySnapshot {
  /** ms epoch of the newest transcript record — tool completions and resumed
   *  output included, not just a new tool_use's start. 0 if none yet. */
  lastTs: number;
  /** the newest tool_use has no tool_result yet → a tool is still running. */
  pending: boolean;
}

export interface StallConfig {
  /** working + last tool finished + no new tool-use within this window → stalled. */
  stallMs: number;
  /** working + a tool still running with no result within this window → hung command. */
  pendingStallMs: number;
}

export const DEFAULT_STALL: StallConfig = {
  // 8m of pure think/generate time with zero new tool-use is abnormal; the
  // pending-guard below already excludes legitimate long-running commands, so
  // this only fires on a genuinely wedged turn. Single knob, easy to tune.
  stallMs: 8 * 60_000,
  // a tool that has been "running" for 20m with no result is almost certainly a
  // hung command (the pending-guard would otherwise mask it forever).
  pendingStallMs: 20 * 60_000,
};

/** Pure stall decision for a *working* agent, given its latest activity snapshot. */
export function isStalled(snap: ActivitySnapshot, now: number, cfg: StallConfig): boolean {
  if (snap.lastTs <= 0) return false; // no tool activity to measure a gap against yet
  const gap = now - snap.lastTs;
  return snap.pending ? gap > cfg.pendingStallMs : gap > cfg.stallMs;
}

/**
 * Synchronously derive a snapshot from a session JSONL. Missing/unreadable
 * (e.g. a just-spawned session with no transcript) → null, treated as "no signal".
 *
 * `lastTs` tracks the newest record of *any* kind so a completing long-running
 * tool or a resumed turn clears a stall; `pending` still keys off the newest
 * tool_use so a genuinely running command keeps its longer hung-command window.
 * A transcript with no tool_use can't stall → null.
 */
export function readSnapshot(path: string): ActivitySnapshot | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const entries = parseActivity(text, 5);
  if (entries.length === 0) return null;
  const last = entries[entries.length - 1]!;
  return { lastTs: latestRecordTs(text), pending: last.status === "pending" };
}
