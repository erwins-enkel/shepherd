import { readFileSync } from "node:fs";
import type { SessionStore } from "./store";
import { createCodexRolloutResolver, parseCodexUsage } from "./codex-activity";
import { readSessionUsage, type SessionUsage } from "./usage";

/** Finalize-time reader for helpers whose provider is recorded on their spawn row. */
export async function readReviewerSpawnUsage(
  store: Pick<SessionStore, "listReviewerSpawns" | "setReviewerSpawnProviderSessionId">,
  worktreePath: string,
  trackingId: string,
  spawnAccountDir?: string | null,
  resolver = createCodexRolloutResolver(),
): Promise<SessionUsage | null> {
  const row = store.listReviewerSpawns().find((spawn) => spawn.reviewerSessionId === trackingId);
  if (row?.reviewerProvider !== "codex") {
    return readSessionUsage(worktreePath, trackingId, spawnAccountDir);
  }
  try {
    const hit = resolver.resolve(
      { trackingId, worktreePath, source: "exec", providerSessionId: row.providerSessionId },
      { bypassBackoff: true },
    );
    if (!hit) return null;
    store.setReviewerSpawnProviderSessionId(trackingId, hit.rolloutId);
    return parseCodexUsage(readFileSync(hit.path, "utf8"), row.model);
  } catch {
    return null;
  } finally {
    resolver.reset(trackingId);
  }
}
