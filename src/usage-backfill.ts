import type { SessionStore } from "./store";
import { snapshotSessionUsage } from "./usage-snapshot";

const GUARD_KEY = "backfill:session_usage_v1";

/** One-time gap-fill: snapshot authoring spend for already-archived sessions that have no
 *  session_usage row yet, stamping each row with the session's REAL archive time
 *  (COALESCE(archivedAt, updatedAt, createdAt)) so it buckets into the correct time window.
 *  Guarded so it runs once; the guard is set only after the loop completes, so a real process
 *  crash mid-backfill resumes on the next boot (gap-fill skips rows already written).
 *
 *  Per-session `"error"` returns (an unreadable/unparseable transcript) are intentionally
 *  one-shot: the guard is still set even when `errored > 0`. Such failures are deterministic
 *  (a corrupt transcript fails identically every boot), so NOT setting the guard would re-scan
 *  every archived session on every boot forever without ever converging. This is best-effort
 *  historical backfill — we log a loud warning instead so the operator can investigate, rather
 *  than trap the migration in a permanent retry loop. Never throws. */
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
    if (errored > 0) {
      console.warn(
        `[usage-backfill] ${errored} session(s) failed to snapshot (unreadable/unparseable transcript) and will NOT be retried (one-shot migration); spend for these stays absent from the usage tree`,
      );
    }
  } catch (err) {
    console.warn("[usage-backfill] backfill failed:", err);
  }
}
