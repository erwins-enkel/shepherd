import type { Session } from "./types";
import type { SessionStore } from "./store";
import { isOperationalArchetype } from "./usage-archetype";
import { jsonlPathFor, sessionCost, dominantModel } from "./usage";

/** Persist a session's authoring spend into the session_usage table.
 *  Never throws — the whole body is wrapped so archive teardown is never blocked. */
export async function snapshotSessionUsage(s: Session, store: SessionStore): Promise<void> {
  try {
    // 1. Skip operational archetypes and sessions without a pinned session id.
    if (isOperationalArchetype(s) || !s.claudeSessionId) return;

    // 2. Resolve and read the JSONL file; skip if absent.
    const path = jsonlPathFor(s.worktreePath, s.claudeSessionId);
    const file = Bun.file(path);
    if (!(await file.exists())) return;
    const text = await file.text();

    // 3. Compute cost from the full transcript.
    const sc = sessionCost(text.split("\n"));

    // 4. Skip empty transcripts.
    if (sc.usage.messageCount === 0) return;

    // 5. Resolve dominant model.
    const model = dominantModel(sc.usage) ?? s.model ?? "unknown";

    // 6. Timestamp.
    const now = Date.now();

    // 7. Upsert the snapshot row.
    store.upsertSessionUsage({
      sessionId: s.id,
      desig: s.desig,
      repoPath: s.repoPath,
      model,
      input: sc.usage.input,
      output: sc.usage.output,
      cacheRead: sc.usage.cacheRead,
      cacheWrite: sc.usage.cacheWrite,
      total: sc.usage.total,
      weightedUnits: sc.weightedUnits,
      cacheReadUnits: sc.cacheReadUnits,
      messageCount: sc.usage.messageCount,
      byModel: sc.weightedByModel,
      createdAt: s.createdAt,
      archivedAt: now,
      snapshotAt: now,
    });
  } catch (err) {
    console.warn("[usage-snapshot] error snapshotting session", s.id, err);
  }
}
