/** Task dependencies (#2589): `shepherd new --after TASK-x` holds a task until TASK-x has LANDED.
 *
 *  Landed = its PR merged. Evidence, store-first like `deadBaseSession()` (src/dead-base.ts): the
 *  live PR snapshot says merged, or the session was archived as merged, or it is an epic child the
 *  drain already squash-merged into its integration branch (archived with reason "drain"). An
 *  archive without either never counts — the dependent keeps waiting for the operator. */
import type { GitState } from "./forge/types";
import type { SessionStore } from "./store";
import type { Session } from "./types";

export type TaskDepsStore = Pick<SessionStore, "get" | "isEpicIntegratedChild">;
export type PrSnapshot = (id: string) => Pick<GitState, "state"> | undefined;

export function predecessorLanded(store: TaskDepsStore, prGit: PrSnapshot, s: Session): boolean {
  if (prGit(s.id)?.state === "merged") return true;
  if (s.status !== "archived") return false;
  if (s.archiveReason === "merged") return true;
  return s.issueNumber != null && store.isEpicIntegratedChild(s.repoPath, s.issueNumber);
}

/** Release check for a held task's predecessor. A missing row means it was pruned — only archived
 *  rows ever are, long after the fact — so nothing will ever change: release rather than wait
 *  forever. */
export function afterGateOpen(
  store: TaskDepsStore,
  prGit: PrSnapshot,
  afterSessionId: string | undefined,
): boolean {
  if (!afterSessionId) return true;
  const s = store.get(afterSessionId);
  if (!s) {
    console.log(`[held] predecessor ${afterSessionId} is gone — releasing its dependent`);
    return true;
  }
  return predecessorLanded(store, prGit, s);
}

/** A session a connected machine reports (#2762), as far as resolving a predecessor needs it. */
export interface MirroredPredecessor {
  id: string;
  desig?: unknown;
  host: { instanceId: string; name: string };
}

export type PredecessorMatch<M extends MirroredPredecessor> =
  | { kind: "local"; session: Session }
  | { kind: "remote"; session: M }
  | { kind: "none" }
  | { kind: "ambiguous"; local: boolean; hosts: string[] };

/** Where `--after <ref>` points (#3633): a session here or one a connected machine runs. Each
 *  machine numbers its own tasks, so a designation can name a task here AND one there; any
 *  reference that matches more than once is ambiguous rather than silently picking one. An id
 *  matching here wins (the mirror never shadows a local session). */
export function resolvePredecessor<M extends MirroredPredecessor>(
  ref: string,
  local: { byId: Session | null; byDesig: Session | null },
  mirrored: readonly M[],
): PredecessorMatch<M> {
  if (local.byId) return { kind: "local", session: local.byId };
  const byId = mirrored.filter((m) => m.id === ref);
  if (byId.length > 0) return pick(null, byId);
  const matches = desigMatcher(ref);
  return pick(local.byDesig, matches ? mirrored.filter((m) => matches(m.desig)) : []);
}

function pick<M extends MirroredPredecessor>(
  here: Session | null,
  remote: M[],
): PredecessorMatch<M> {
  if (here && remote.length === 0) return { kind: "local", session: here };
  if (!here && remote.length === 1) return { kind: "remote", session: remote[0]! };
  if (!here && remote.length === 0) return { kind: "none" };
  return { kind: "ambiguous", local: here !== null, hosts: remote.map((m) => m.host.name) };
}

const DESIG_RE = /^TASK-(\d+)$/i;

/** Same matching as `SessionStore.getByDesig`: `TASK-n` by name (any case), bare digits by number. */
function desigMatcher(ref: string): ((desig: unknown) => boolean) | null {
  const key = ref.trim().toUpperCase();
  if (key.startsWith("TASK-")) return (d) => typeof d === "string" && d.toUpperCase() === key;
  if (!/^\d+$/.test(key)) return null;
  const n = Number(key);
  return (d) => {
    const m = typeof d === "string" ? DESIG_RE.exec(d) : null;
    return m !== null && Number(m[1]) === n;
  };
}
