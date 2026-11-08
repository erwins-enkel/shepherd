/**
 * Moving a session to another machine ("Continue with…" naming another machine): the coordinator's
 * half. Three roles, each in-process when it is this Shepherd and over the machine client when it
 * is another one (`server.ts` builds the ports):
 *
 * 1. The SOURCE (the session's machine) prepares: it holds automatic resumes, stops the agent,
 *    commits what it left uncommitted and pushes the work branch (`SessionService.prepareHandoff`).
 *    A refusal here has touched nothing.
 * 2. The carried files (the plan, the uploads) are staged on this Shepherd, the way a create's
 *    attachments are: from where the session runs, one by one. A file that does not come along is
 *    named to the new agent instead of failing the move.
 * 3. The TARGET creates a session with `continuation`: the very branch, so an open PR stays the
 *    same. A remote target is a keyed dispatch (`move-<session>-<head>`), so it never starts twice.
 * 4. Started (or held there: the work is pushed, the target starts it once it has room) → the
 *    source archives the original. Refused or failed → the source resumes its agent: nothing moved.
 *    No answer → nothing is undone: the target may have started it, its dispatch keeps checking,
 *    and the original stays stopped until the operator archives or resumes it.
 */
import { basename } from "node:path";
import type { SessionHost } from "./sessions";
import type { HandoffSource } from "../session-handoff";
import type { AgentProvider, IssueRef } from "../types";
import type { HandoffMode } from "../validate";

/** What the source hands over, with the issue re-resolved there (null: none, or not carried). */
export interface HandoffPrepared extends HandoffSource {
  issueRef: IssueRef | null;
}

export interface MoveChoice {
  agentProvider?: AgentProvider;
  model: string | null;
  effort: string | null;
  handoffMode: HandoffMode;
}

/** A refusal or failure as the route answers it. */
export interface MoveReply {
  status: number;
  body: Record<string, unknown>;
}

export interface MoveSourcePort {
  host: SessionHost;
  /** Stop, snapshot and push; or why not (nothing touched). */
  prepare(
    to: SessionHost,
  ): Promise<{ ok: true; handoff: HandoffPrepared } | ({ ok: false } & MoveReply)>;
  /** Copy one carried file (worktree-relative) to `dest`; false when it did not come along. */
  fetchFile(rel: string, dest: string): Promise<boolean>;
  /** Archive the original; whether it was archived. */
  complete(carriedIssue: boolean): Promise<boolean>;
  /** Release the hold and resume the original's agent. */
  abort(): Promise<void>;
}

export type TargetOutcome =
  | { kind: "started"; session: Record<string, unknown> }
  | { kind: "held"; body: Record<string, unknown> }
  | { kind: "unknown"; body: Record<string, unknown> }
  | ({ kind: "failed" } & MoveReply);

export interface MoveTargetPort {
  host: SessionHost;
  create(body: Record<string, unknown>, key: string): Promise<TargetOutcome>;
}

export interface MoveRun {
  sessionId: string;
  source: MoveSourcePort;
  target: MoveTargetPort;
  choice: MoveChoice;
  /** The `repoPath` the create names: this Shepherd's checkout of the project when it has one
   *  (a remote target maps it by project, and clones from it when it has no checkout), else the
   *  source's. */
  repoPath: string;
  /** A fresh staging path for a carried file. */
  stagePath(rel: string): string;
}

/** The dispatch key of a move: the same source at the same pushed head is the same task. */
export function moveKey(sessionId: string, headCommit: string): string {
  return `move-${sessionId}-${headCommit}`;
}

/** The create body that continues `h` on the target. Only true task kinds are named. */
export function continuationBody(
  h: HandoffPrepared,
  run: Pick<MoveRun, "choice" | "repoPath">,
  from: SessionHost,
  staged: { images: string[]; names: string[]; missing: string[] },
): Record<string, unknown> {
  const { choice } = run;
  return {
    repoPath: run.repoPath,
    baseBranch: h.baseBranch,
    prompt: h.prompt,
    ...(choice.agentProvider && { agentProvider: choice.agentProvider }),
    model: choice.model,
    effort: choice.effort,
    ...(staged.images.length > 0 && { images: staged.images, attachmentNames: staged.names }),
    ...(h.issueRef && { issueRef: h.issueRef }),
    planGateEnabled: h.planGateEnabled,
    autopilotEnabled: h.autopilotEnabled,
    ...(h.research && { research: true }),
    ...(h.epicAuthoring && { epicAuthoring: true }),
    ...(h.plain && { plain: true }),
    continuation: {
      branch: h.branch,
      headCommit: h.headCommit,
      handoffMode: choice.handoffMode,
      from: { machine: from.name, desig: h.desig, provider: h.agentProvider },
      ...(h.amendments.length > 0 && { amendments: h.amendments }),
      ...(staged.missing.length > 0 && { missingFiles: staged.missing }),
    },
  };
}

/** Run a validated move: prepare on the source, stage, create on the target, then archive or undo. */
export async function runMove(run: MoveRun): Promise<MoveReply> {
  const { source, target } = run;
  const prepared = await source.prepare(target.host);
  if (!prepared.ok) return { status: prepared.status, body: prepared.body };
  const h = prepared.handoff;

  const staged = { images: [] as string[], names: [] as string[], missing: [] as string[] };
  for (const rel of h.files) {
    const dest = run.stagePath(rel);
    const ok = await source.fetchFile(rel, dest).catch(() => false);
    if (ok) {
      staged.images.push(dest);
      staged.names.push(basename(rel));
    } else staged.missing.push(basename(rel));
  }

  const body = continuationBody(h, run, source.host, staged);
  let outcome: TargetOutcome;
  try {
    outcome = await target.create(body, moveKey(run.sessionId, h.headCommit));
  } catch (e) {
    outcome = {
      kind: "failed",
      status: 500,
      body: { error: e instanceof Error ? e.message : "move failed", code: "move_failed" },
    };
  }

  switch (outcome.kind) {
    case "started":
    case "held": {
      const archived = await source.complete(h.issueRef !== null).catch(() => false);
      return outcome.kind === "started"
        ? { status: 201, body: { session: outcome.session, archived } }
        : { status: 200, body: { ...outcome.body, archived } };
    }
    case "unknown":
      return {
        status: 504,
        body: {
          ...outcome.body,
          error: `no answer from ${target.host.name} after sending; the session may have started there. The original stays stopped: archive it once the new session appears, or resume it.`,
          code: "move_target_unknown",
          archived: false,
        },
      };
    case "failed":
      await source.abort().catch(() => {});
      return { status: outcome.status, body: outcome.body };
  }
}
