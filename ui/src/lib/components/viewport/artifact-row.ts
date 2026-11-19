import { isArtifactUrl } from "../../../../../shared/artifact-url";
import type { SessionArtifact } from "#lib/types.js";

/** An entry the rows can show: a mirrored machine's list reaches the UI as relayed (#3876), so an
 *  entry may be null or lack the fields the rows format. */
function showable(a: unknown): a is SessionArtifact {
  if (typeof a !== "object" || a === null) return false;
  const e = a as Partial<Record<keyof SessionArtifact, unknown>>;
  return (
    isArtifactUrl(e.url) &&
    typeof e.title === "string" &&
    typeof e.versions === "number" &&
    Number.isFinite(e.versions) &&
    typeof e.updatedAt === "number" &&
    Number.isFinite(e.updatedAt)
  );
}

/** The artifact the row shows (#3875): the most recently published one with a valid claude.ai url,
 *  or null when the session has none. The server keeps `updatedAt` strictly increasing across a
 *  session's list, so publish order decides even within one millisecond; the later entry winning a
 *  tie only matters for lists from servers before that. Malformed entries are skipped. */
export function latestArtifact(list: unknown): SessionArtifact | null {
  let latest: SessionArtifact | null = null;
  for (const a of Array.isArray(list) ? list : []) {
    if (!showable(a)) continue;
    if (!latest || a.updatedAt >= latest.updatedAt) latest = a;
  }
  return latest;
}
