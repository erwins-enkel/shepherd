/**
 * A session's derived phase (issue #2586): ONE field an orchestrator can decide on — act or wait —
 * instead of piecing it together from `status`, `lastState` and `planPhase`, none of which says it
 * alone (`status: done` is "turn ended", not "task done").
 *
 * {@link derivePhase} is pure; {@link SessionPhaseService} gathers its inputs (PR cache, plan gate,
 * live block, transcript question) for the REST and MCP reads. The transcript check is async and
 * cached per session by the file's size + mtime, so listing the herd never re-reads an unchanged
 * transcript and never blocks the event loop.
 */
import { stat } from "node:fs/promises";
import { AT_REST, awaitingInput } from "./agent-messages";
import { planQuestionsUnanswered } from "./attention-core";
import type { BlockReason } from "./blocked";
import type { GitState } from "./forge/types";
import type { PlanGate, Session } from "./types";

/** Act on `plan_ready`, `needs_input`, `pr_open`, `halted`, `idle`; wait on `planning`,
 *  `working`; `finished` needs nothing. Keep in sync with `SessionPhase` in contracts/openapi.yaml. */
export type SessionPhase =
  | "planning"
  | "plan_ready"
  | "working"
  | "needs_input"
  | "pr_open"
  | "idle"
  | "finished"
  | "halted";

export interface PhaseInput {
  session: Pick<
    Session,
    "status" | "planPhase" | "haltReason" | "autopilotPaused" | "autopilotComplete"
  >;
  git?: Pick<GitState, "state">;
  gate?: PlanGate | null;
  /** The session's live BlockReason (a prompt or quota block on screen). */
  block?: BlockReason | null;
  /** The transcript ends on an open question while the session is at rest. */
  awaitingInput: boolean;
}

/** The plan reviewer requested changes and it is the operator's turn: the agent is not revising
 *  (not running) and nobody dismissed the verdict. Same rule as the `plan-rework` hold. */
function planReworkWaiting(s: PhaseInput["session"], gate: PlanGate | null | undefined): boolean {
  return gate?.decision === "changes_requested" && !gate.dismissed && s.status !== "running";
}

/** First match wins — the order IS the contract (see docs/cli.md "Session phase"). Agrees with
 *  `shepherd wait`'s states (cli/src/commands/wait.rs), which derive from the same facts. */
export function derivePhase({
  session: s,
  git,
  gate,
  block,
  awaitingInput,
}: PhaseInput): SessionPhase {
  if (
    s.status === "archived" ||
    git?.state === "merged" ||
    s.haltReason === "completed" ||
    s.autopilotComplete
  )
    return "finished";
  if (s.haltReason != null) return "halted";
  const planning = s.planPhase === "planning";
  if (
    s.status === "blocked" ||
    block ||
    s.autopilotPaused ||
    (planning && (planQuestionsUnanswered(gate) || planReworkWaiting(s, gate))) ||
    awaitingInput
  )
    return "needs_input";
  if (planning) return gate?.approved ? "plan_ready" : "planning";
  if (s.status === "running") return "working";
  if (git?.state === "open") return "pr_open";
  return "idle";
}

export interface SessionPhaseDeps {
  store: { getPlanGate(id: string): PlanGate | null | undefined };
  prCache?: { get(id: string): GitState | undefined };
  blocks?: { snapshot(): Record<string, BlockReason> };
  /** The session's transcript (Claude JSONL or Codex rollout), or null when none resolves. */
  transcriptPath: (s: Session) => string | null;
  /** Injectable for tests; defaults to agent-messages' `awaitingInput`. */
  readAwaiting?: typeof awaitingInput;
}

interface ProbeEntry {
  path: string;
  size: number;
  mtimeMs: number;
  awaiting: boolean;
}

export class SessionPhaseService {
  private probes = new Map<string, ProbeEntry>();

  constructor(private deps: SessionPhaseDeps) {}

  async phaseOf(s: Session): Promise<SessionPhase> {
    return this.derive(s, this.deps.blocks?.snapshot() ?? {});
  }

  /** `sessions` with `phase` attached; drops cached probes of sessions no longer listed. */
  async withPhases<T extends Session>(sessions: T[]): Promise<Array<T & { phase: SessionPhase }>> {
    const blocks = this.deps.blocks?.snapshot() ?? {};
    const ids = new Set(sessions.map((s) => s.id));
    for (const id of this.probes.keys()) if (!ids.has(id)) this.probes.delete(id);
    return Promise.all(sessions.map(async (s) => ({ ...s, phase: await this.derive(s, blocks) })));
  }

  private async derive(s: Session, blocks: Record<string, BlockReason>): Promise<SessionPhase> {
    if (s.status === "archived") return "finished";
    return derivePhase({
      session: s,
      git: this.deps.prCache?.get(s.id),
      gate: this.deps.store.getPlanGate(s.id),
      block: blocks[s.id] ?? null,
      awaitingInput: await this.awaiting(s),
    });
  }

  /** Never throws: an unresolvable or unreadable transcript is "not awaiting". */
  private async awaiting(s: Session): Promise<boolean> {
    if (!AT_REST.has(s.status)) return false;
    const path = this.deps.transcriptPath(s);
    if (!path) return false;
    let size: number;
    let mtimeMs: number;
    try {
      ({ size, mtimeMs } = await stat(path));
    } catch {
      this.probes.delete(s.id);
      return false;
    }
    const hit = this.probes.get(s.id);
    if (hit && hit.path === path && hit.size === size && hit.mtimeMs === mtimeMs)
      return hit.awaiting;
    const awaiting = await (this.deps.readAwaiting ?? awaitingInput)(s, path);
    this.probes.set(s.id, { path, size, mtimeMs, awaiting });
    return awaiting;
  }
}
