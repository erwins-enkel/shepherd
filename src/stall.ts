import { readFileSync } from "node:fs";
import { latestRecordTs, parseActivity, type ActivityEntry } from "./activity";

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
  // 8m of transcript silence with the last tool *finished* makes a turn a stall
  // *candidate*, not a confirmed stall: a long pure-generation turn (plan/deep-
  // think) is also tool-silent. The poller confirms these !pending candidates with
  // a live-terminal liveness diff before alarming.
  stallMs: 8 * 60_000,
  // a tool that has been "running" for 20m with no result is almost certainly a
  // hung command. The poller fires these pending candidates directly, bypassing
  // the liveness diff — a hung command's "esc to interrupt" timer keeps the
  // terminal ticking, so the diff would otherwise mask the hang forever.
  pendingStallMs: 20 * 60_000,
};

/**
 * Pure transcript-silence decision for a *working* agent: true when its latest
 * snapshot shows no forward progress within the window. This is a stall
 * *candidate* — the poller confirms it against the live terminal before alarming,
 * since a long tool-silent generation turn trips this too.
 */
export function isStalled(snap: ActivitySnapshot, now: number, cfg: StallConfig): boolean {
  if (snap.lastTs <= 0) return false; // no tool activity to measure a gap against yet
  const gap = now - snap.lastTs;
  return snap.pending ? gap > cfg.pendingStallMs : gap > cfg.stallMs;
}

/**
 * Pure: derive a snapshot from already-parsed tool-use entries (oldest→newest)
 * plus the newest record ts.
 *
 * `lastTs` tracks the newest record of *any* kind so a completing long-running
 * tool or a resumed turn clears a stall; `pending` still keys off the newest
 * tool_use so a genuinely running command keeps its longer hung-command window.
 * A transcript with no tool_use can't stall → null.
 */
export function snapshotFrom(entries: ActivityEntry[], lastTs: number): ActivitySnapshot | null {
  if (entries.length === 0) return null;
  const last = entries[entries.length - 1]!;
  return { lastTs, pending: last.status === "pending" };
}

/** Pure: derive a snapshot from already-read transcript text. */
export function snapshotFromText(text: string): ActivitySnapshot | null {
  return snapshotFrom(parseActivity(text, 5), latestRecordTs(text));
}

/**
 * Synchronously derive a snapshot from a session JSONL. Missing/unreadable
 * (e.g. a just-spawned session with no transcript) → null, treated as "no signal".
 */
export function readSnapshot(path: string): ActivitySnapshot | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  return snapshotFromText(text);
}
