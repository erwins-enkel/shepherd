import { isArtifactUrl } from "../../../../../shared/artifact-url";
import type { SessionArtifact } from "#lib/types.js";

/** The artifact the row shows (#3875): the most recently published one with a valid claude.ai url,
 *  or null when the session has none. The server keeps `updatedAt` strictly increasing across a
 *  session's list, so publish order decides even within one millisecond; the later entry winning a
 *  tie only matters for lists from servers before that. */
export function latestArtifact(list: SessionArtifact[] | null | undefined): SessionArtifact | null {
  let latest: SessionArtifact | null = null;
  for (const a of list ?? []) {
    if (!isArtifactUrl(a.url)) continue;
    if (!latest || a.updatedAt >= latest.updatedAt) latest = a;
  }
  return latest;
}
