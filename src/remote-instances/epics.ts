/**
 * Epics a connected machine leads: read from what that machine already serves — its
 * `GET /api/drain` names the epic each repo's drain leads (`epicParent`), its `GET /api/epic`
 * answers the epic itself, and its `drain:status` / `epic:update` frames keep both current. Held by
 * the session mirror (`sessions.ts`) next to the machine's sessions, so the herd can group a
 * machine's epic children under their epic. View-only: nothing here acts on them.
 */
import { isRecord } from "./client";

/** A drain status exactly as its machine reported it (that machine's own DrainStatus JSON). */
export type RemoteDrain = Record<string, unknown> & { repoPath: string };

/** An epic exactly as its machine reported it (that machine's own Epic JSON). */
export type RemoteEpicRow = Record<string, unknown> & {
  repoPath: string;
  parentIssueNumber: number;
};

const isParent = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;

/** A drain status: a record with a string `repoPath`. `parent` is its led epic, null for none. */
export function asDrain(value: unknown): { drain: RemoteDrain; parent: number | null } | null {
  if (!isRecord(value) || typeof value.repoPath !== "string") return null;
  return {
    drain: value as RemoteDrain,
    parent: isParent(value.epicParent) ? value.epicParent : null,
  };
}

/** Repo path → the epic its drain leads, with that drain status, from a `GET /api/drain` body. */
export function activeParents(body: unknown): Map<string, { parent: number; drain: RemoteDrain }> {
  const active = new Map<string, { parent: number; drain: RemoteDrain }>();
  if (!Array.isArray(body)) return active;
  for (const entry of body) {
    const status = asDrain(entry);
    if (status?.parent != null)
      active.set(status.drain.repoPath, { parent: status.parent, drain: status.drain });
  }
  return active;
}

/** An epic as a machine serves it. A `host` means a mirrored record, which is never passed on. */
export function asEpic(value: unknown): RemoteEpicRow | null {
  if (!isRecord(value) || "host" in value) return null;
  if (typeof value.repoPath !== "string" || !isParent(value.parentIssueNumber)) return null;
  if (!Array.isArray(value.children) || !isRecord(value.run)) return null;
  return value as RemoteEpicRow;
}
