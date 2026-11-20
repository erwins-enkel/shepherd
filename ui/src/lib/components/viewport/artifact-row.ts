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

const shown = (list: unknown): SessionArtifact[] =>
  (Array.isArray(list) ? list : []).filter(showable);

/** Whether the operator hid the session's artifact row (#3877): it has showable entries and every
 *  one of them carries the stamp of a hide. A new url arrives without one, which shows the row
 *  again; a re-publish keeps it. */
export function artifactsHidden(list: unknown): boolean {
  const entries = shown(list);
  return entries.length > 0 && entries.every((a) => typeof a.hiddenAt === "number");
}

/** What the rows show (#3877): the showable artifacts, newest first — none while hidden. The
 *  server keeps `updatedAt` strictly increasing across a session's list, so publish order decides
 *  even within one millisecond; a later entry winning a tie only matters for lists from servers
 *  before that. Malformed entries are skipped. */
export function rowArtifacts(list: unknown): SessionArtifact[] {
  if (artifactsHidden(list)) return [];
  return shown(list)
    .map((a, i) => ({ a, i }))
    .sort((x, y) => y.a.updatedAt - x.a.updatedAt || y.i - x.i)
    .map(({ a }) => a);
}

/** The artifact the row shows (#3875): the most recently published one, or null when the session
 *  has none or the operator hid them (#3877). */
export function latestArtifact(list: unknown): SessionArtifact | null {
  return rowArtifacts(list)[0] ?? null;
}

/** The Chat calls that carry the "in the bar" chip (#3877): every recorded publish of the artifacts
 *  the row shows — earlier versions of a url included — and none while the row is hidden. An entry
 *  from a server before #3877 contributes its `toolUseId`. */
export function publishToolIds(list: unknown): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const a of rowArtifacts(list)) {
    const known = Array.isArray(a.toolUseIds) ? a.toolUseIds : a.toolUseId ? [a.toolUseId] : [];
    for (const id of known) if (typeof id === "string") ids.add(id);
  }
  return ids;
}
