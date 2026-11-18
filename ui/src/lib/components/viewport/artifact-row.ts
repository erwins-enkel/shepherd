import { isArtifactUrl } from "../../../../../shared/artifact-url";
import type { SessionArtifact } from "#lib/types.js";

/** The artifact the row shows (#3875): the most recently updated one with a valid claude.ai url
 *  (a later entry wins a tie), or null when the session has none. */
export function latestArtifact(list: SessionArtifact[] | null | undefined): SessionArtifact | null {
  let latest: SessionArtifact | null = null;
  for (const a of list ?? []) {
    if (!isArtifactUrl(a.url)) continue;
    if (!latest || a.updatedAt >= latest.updatedAt) latest = a;
  }
  return latest;
}
