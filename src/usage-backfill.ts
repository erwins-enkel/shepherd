import type { SessionStore } from "./store";
import { snapshotSessionUsage } from "./usage-snapshot";

const GUARD_KEY = "backfill:session_usage_v1";

/** One-time gap-fill: snapshot authoring spend for already-archived sessions that have no
 *  session_usage row yet, stamping each row with the session's REAL archive time
 *  (COALESCE(archivedAt, updatedAt, createdAt)) so it buckets into the correct time window.
 *  Guarded so it runs once; the guard is set only after the loop completes, so a crash
 *  mid-backfill resumes on the next boot (gap-fill skips rows already written). Never throws. */
export async function runSessionUsageBackfill(store: SessionStore): Promise<void> {
  try {
    if (store.getSetting(GUARD_KEY) === "done") return;
    const existing = new Set(store.listSessionUsage().map((u) => u.sessionId));
    const archived = store.listArchivedSessions();
    let snapshotted = 0;
    let skipped = 0;
    let errored = 0;
    for (const s of archived) {
      if (existing.has(s.id)) {
        skipped++;
        continue;
      }
      const asOf = s.archivedAt ?? s.updatedAt ?? s.createdAt;
      const r = await snapshotSessionUsage(s, store, { asOf });
      if (r === "snapshotted") snapshotted++;
      else if (r === "error") errored++;
      else skipped++;
    }
    store.setSetting(GUARD_KEY, "done");
    console.log(
      `[usage-backfill] archived=${archived.length} snapshotted=${snapshotted} skipped=${skipped} errored=${errored}`,
    );
  } catch (err) {
    console.warn("[usage-backfill] backfill failed:", err);
  }
}
