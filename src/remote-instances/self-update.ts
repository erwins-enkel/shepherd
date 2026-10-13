/**
 * A connected machine's own self-update: how far its checkout is behind the branch it tracks, as
 * its `GET /api/update` reports it. Read after every probe the machine answers, so the update
 * window can list each machine that needs an update beside this Shepherd. Starting the update and
 * following it go through the machine's own `/api/update` routes, relayed with the stored token
 * (`RemoteInstanceService.relaySelfUpdate`) — the machine stays the authority on whether and how
 * it updates.
 *
 * Those routes predate federation and keep their shape, so reading and relaying them needs no
 * federation level: a machine too old or too new to be compatible can still be brought up to date.
 */
import { isRecord } from "./client";

export interface MachineSelfUpdate {
  /** Commits the machine's tracked branch is ahead of its running checkout; 0 = up to date. */
  behind: number;
  current: string | null;
  latest: string | null;
  /** The new commits, newest first, as the machine lists them (it caps the list itself). */
  commits: { sha: string; subject: string }[];
  /** When the machine last checked, on the machine's clock. */
  checkedAt: number;
}

/** Bounds against a misbehaving machine; a real one sends 20 commits at most. */
const COMMITS_MAX = 50;
const SUBJECT_MAX = 500;
const SHA_RE = /^[0-9a-f]{4,40}$/i;

const sha = (value: unknown): string | null =>
  typeof value === "string" && SHA_RE.test(value) ? value : null;

/** The machine's `GET /api/update` body, or null when it is not one. */
export function parseSelfUpdate(body: unknown): MachineSelfUpdate | null {
  if (!isRecord(body)) return null;
  const { behind, checkedAt } = body;
  if (typeof behind !== "number" || !Number.isInteger(behind) || behind < 0) return null;
  if (typeof checkedAt !== "number" || !Number.isFinite(checkedAt)) return null;
  const commits = Array.isArray(body.commits)
    ? body.commits
        .flatMap((c: unknown) =>
          isRecord(c) && sha(c.sha) && typeof c.subject === "string"
            ? [{ sha: c.sha as string, subject: c.subject.slice(0, SUBJECT_MAX) }]
            : [],
        )
        .slice(0, COMMITS_MAX)
    : [];
  return { behind, current: sha(body.current), latest: sha(body.latest), commits, checkedAt };
}
