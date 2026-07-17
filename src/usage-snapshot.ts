import type { Session } from "./types";
import type { SessionStore } from "./store";
import type { SessionUsageBucket } from "./types";
import { isOperationalArchetype } from "./usage-archetype";
import { jsonlPathFor, foldSessionBuckets, dominantModelOf } from "./usage";
import type { SessionBucket } from "./usage";

/** Sum all buckets (incl. bucket 0) into a flat aggregate. */
function sumBuckets(buckets: Map<number, SessionBucket>): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  weightedUnits: number;
  cacheReadUnits: number;
  byModel: Record<string, number>;
} {
  let input = 0,
    output = 0,
    cacheRead = 0,
    cacheWrite = 0,
    weightedUnits = 0,
    cacheReadUnits = 0;
  const byModel: Record<string, number> = {};
  for (const b of buckets.values()) {
    input += b.input;
    output += b.output;
    cacheRead += b.cacheRead;
    cacheWrite += b.cacheWrite;
    weightedUnits += b.weightedUnits;
    cacheReadUnits += b.cacheReadUnits;
    for (const [model, units] of Object.entries(b.byModel)) {
      byModel[model] = (byModel[model] ?? 0) + units;
    }
  }
  return { input, output, cacheRead, cacheWrite, weightedUnits, cacheReadUnits, byModel };
}

/** Persist a session's authoring spend into the session_usage table.
 *  Never throws — the whole body is wrapped so archive teardown is never blocked.
 *  Pass `opts.asOf` to stamp both archivedAt and snapshotAt with a historical time (backfill). */
export async function snapshotSessionUsage(
  s: Session,
  store: SessionStore,
  opts?: { asOf?: number },
): Promise<"snapshotted" | "skipped" | "error"> {
  try {
    // 1. Skip operational archetypes and sessions without a pinned session id.
    if (isOperationalArchetype(s) || !s.claudeSessionId) return "skipped";

    // 2. Resolve and read the JSONL file; skip if absent.
    const path = jsonlPathFor(s.worktreePath, s.claudeSessionId, s.spawnAccountDir);
    const file = Bun.file(path);
    if (!(await file.exists())) return "skipped";
    const text = await file.text();

    // 3. Single-pass fold into per-hour buckets.
    const fold = foldSessionBuckets(text.split("\n"));

    // 4. Skip empty transcripts.
    if (fold.messageCount === 0) return "skipped";

    // 5. Aggregate from buckets (Σ incl. bucket 0).
    const agg = sumBuckets(fold.buckets);
    const total = agg.input + agg.output + agg.cacheRead + agg.cacheWrite;

    // 6. Resolve dominant model.
    const model = dominantModelOf(fold.rawByModel) ?? s.model ?? "unknown";

    // 7. Timestamp — use opts.asOf when provided (backfill), otherwise now.
    const asOf = opts?.asOf ?? Date.now();

    // 8. Upsert the parent session_usage row FIRST (FK parent must exist before buckets).
    store.upsertSessionUsage({
      sessionId: s.id,
      desig: s.desig,
      name: s.name,
      // Provenance: ties this snapshot to the agent lineage it measured, so the archived-
      // usage read can reject it after a restore → replace → re-archive cycle.
      claudeSessionId: s.claudeSessionId,
      repoPath: s.repoPath,
      model,
      input: agg.input,
      output: agg.output,
      cacheRead: agg.cacheRead,
      cacheWrite: agg.cacheWrite,
      total,
      weightedUnits: agg.weightedUnits,
      cacheReadUnits: agg.cacheReadUnits,
      messageCount: fold.messageCount,
      byModel: agg.byModel,
      createdAt: s.createdAt,
      archivedAt: asOf,
      snapshotAt: asOf,
    });

    // 9. Persist per-hour buckets (FK child — parent row must already exist).
    const buckets: SessionUsageBucket[] = Array.from(fold.buckets.values()).map((b) => ({
      sessionId: s.id,
      bucketStart: b.bucketStart,
      input: b.input,
      output: b.output,
      cacheRead: b.cacheRead,
      cacheWrite: b.cacheWrite,
      weightedUnits: b.weightedUnits,
      cacheReadUnits: b.cacheReadUnits,
      byModel: b.byModel,
    }));
    store.replaceSessionUsageBuckets(s.id, buckets);

    return "snapshotted";
  } catch (err) {
    console.warn("[usage-snapshot] error snapshotting session", s.id, err);
    return "error";
  }
}
