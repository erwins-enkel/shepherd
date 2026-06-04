import { readFileSync } from "node:fs";
import { parseActivity, latestRecordTs, type ActivityEntry } from "./activity";
import { snapshotFrom, type ActivitySnapshot } from "./stall";

/** Per-agent liveness + current-activity signal pushed to UI clients. */
export interface SessionActivity {
  /** ms epoch of the newest transcript record — the heartbeat. 0 if none yet. */
  lastActivityTs: number;
  /** Latest *meaningful* tool-use summary, verbatim (e.g. "edited poller.ts",
   *  "$ bun test"); null when the agent has produced no tool-use yet. */
  summary: string | null;
}

/**
 * Tools that represent internal bookkeeping rather than observable agent work.
 * When filtering for the most-meaningful recent action, these are skipped in
 * favour of the last substantive tool-use. If every entry is noise, we fall
 * back to the newest entry so we always show *something*.
 */
// Keep in sync with the bookkeeping-tool summarizers in src/activity.ts.
const NOISE_TOOLS = new Set(["TodoWrite", "TaskList", "TaskGet", "TaskUpdate", "TaskCreate"]);

/**
 * Return the summary of the newest non-noise entry in `entries` (oldest→newest).
 * Falls back to the newest entry's summary when all entries are noise.
 * Returns null for an empty list.
 */
export function latestMeaningfulSummary(entries: ActivityEntry[]): string | null {
  if (entries.length === 0) return null;
  // scan newest→oldest for the first non-noise tool
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (!NOISE_TOOLS.has(e.tool)) return e.summary;
  }
  // every entry is noise — show the newest rather than nothing
  return entries[entries.length - 1]!.summary;
}

/**
 * Pure: derive an activity signal from already-parsed tool-use entries plus the
 * newest record ts. Returns null when there's no parseable activity at all
 * (e.g. a brand-new session).
 */
export function signalFrom(
  entries: ActivityEntry[],
  lastActivityTs: number,
): SessionActivity | null {
  const summary = latestMeaningfulSummary(entries);
  // no signal yet — transcript exists but contains no parseable activity
  if (lastActivityTs === 0 && summary === null) return null;
  return { lastActivityTs, summary };
}

/** Pure: derive an activity signal from already-read transcript text. */
export function signalFromText(text: string): SessionActivity | null {
  return signalFrom(parseActivity(text), latestRecordTs(text));
}

/**
 * Synchronously derive an activity signal from a session JSONL transcript.
 * Missing/unreadable file → null ("no signal yet"). Also returns null when the
 * transcript has no parseable records at all (e.g. a brand-new session).
 */
export function readActivitySignal(path: string): SessionActivity | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  return signalFromText(text);
}

/**
 * Read a session JSONL transcript ONCE and derive BOTH the stall snapshot and
 * the activity signal from a SINGLE parse — the per-tick probe for a running
 * agent. Missing/unreadable file → both null. One `readFileSync`, one
 * `parseActivity`, one `latestRecordTs`, both builders fed from the result —
 * no duplicate disk read or in-memory parse per tick.
 */
export function readTranscriptSignals(path: string): {
  snapshot: ActivitySnapshot | null;
  activity: SessionActivity | null;
} {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { snapshot: null, activity: null };
  }
  const entries = parseActivity(text);
  const lastTs = latestRecordTs(text);
  return { snapshot: snapshotFrom(entries, lastTs), activity: signalFrom(entries, lastTs) };
}
