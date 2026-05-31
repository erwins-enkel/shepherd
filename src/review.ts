import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionStore } from "./store";
import type { HerdrDriver } from "./herdr";
import type { WorktreeMgr } from "./worktree";
import type { GitForge, GitState } from "./forge/types";
import type { ReviewVerdict, ReviewDecision, Session } from "./types";

/** Self-contained instructions for the critic agent. NOT UI chrome — never i18n'd. */
export function reviewPrompt(base: string, taskPrompt: string): string {
  return [
    "You are a code critic reviewing a pull request. Do NOT modify, build, commit, or run anything — read-only inspection only.",
    `The PR branch is checked out here at its head commit. Review the changes with: git diff ${base}...HEAD`,
    "",
    "The task this PR is meant to accomplish:",
    taskPrompt,
    "",
    "Judge ONLY whether the implementation satisfies that task and is free of bugs, security issues, and clear quality problems. Tests and lint are handled by CI — do not run them.",
    "When done, write your verdict as JSON to the file `.shepherd-review.json` in the repository root, with EXACTLY this shape:",
    '{"decision": "request-changes" | "comment", "summary": "<=100 char one-liner", "body": "<full markdown review>"}',
    'Use "request-changes" ONLY for blocking problems (does not satisfy the task, logic bug, security hole). Otherwise use "comment". Never approve. Write the file as your final action, then stop.',
  ].join("\n");
}

const VERDICT_FILE = ".shepherd-review.json";

interface InFlight {
  sessionId: string;
  headSha: string;
  prNumber: number;
  repoPath: string;
  worktreePath: string;
  terminalId: string;
  startedAt: number;
}

export interface ReviewServiceDeps {
  store: Pick<
    SessionStore,
    "getRepoConfig" | "getReview" | "putReview" | "dropReview" | "snapshotReviews"
  >;
  herdr: Pick<HerdrDriver, "start" | "stop">;
  worktree: Pick<WorktreeMgr, "createDetached" | "remove">;
  resolveForge: (repoPath: string) => GitForge | null;
  onChange: (id: string, verdict: ReviewVerdict) => void;
  model?: string | null; // optional --model for the critic
  now?: () => number;
  timeoutMs?: number; // give up waiting on the verdict file
  /** Injectable verdict reader (default: read VERDICT_FILE from the worktree). */
  readVerdict?: (worktreePath: string) => RawVerdict | null;
}

interface RawVerdict {
  decision?: unknown;
  summary?: unknown;
  body?: unknown;
}

export class ReviewService {
  private inflight = new Map<string, InFlight>();
  private now: () => number;
  private timeoutMs: number;
  private readVerdict: (worktreePath: string) => RawVerdict | null;

  constructor(private deps: ReviewServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.timeoutMs = deps.timeoutMs ?? 10 * 60 * 1000;
    this.readVerdict = deps.readVerdict ?? defaultReadVerdict;
  }

  /** Decide whether `git` warrants a fresh critic run for `session`, and start one. */
  consider(session: Session, git: GitState): void {
    if (git.state !== "open" || git.checks !== "success" || !git.headSha || !git.number) return;
    if (!session.branch) return;
    if (!this.deps.store.getRepoConfig(session.repoPath).criticEnabled) return;
    if (this.inflight.has(session.id)) return; // a run is already in flight
    if (this.deps.store.getReview(session.id)?.headSha === git.headSha) return; // head already reviewed
    this.begin(session, git);
  }

  private begin(session: Session, git: GitState): void {
    let wt;
    try {
      wt = this.deps.worktree.createDetached(session.repoPath, session.branch!, git.headSha!);
    } catch (err) {
      console.warn(`[review] worktree failed for ${session.id}:`, err);
      return;
    }
    const argv = ["claude", "--dangerously-skip-permissions", "--session-id", randomUUID()];
    if (this.deps.model) argv.push("--model", this.deps.model);
    argv.push(reviewPrompt(session.baseBranch, session.prompt));
    let terminalId: string;
    try {
      terminalId = this.deps.herdr.start(
        `review ${session.desig}`,
        wt.worktreePath,
        argv,
      ).terminalId;
    } catch (err) {
      console.warn(`[review] spawn failed for ${session.id}:`, err);
      this.deps.worktree.remove(wt.worktreePath);
      return;
    }
    this.inflight.set(session.id, {
      sessionId: session.id,
      headSha: git.headSha!,
      prNumber: git.number!,
      repoPath: session.repoPath,
      worktreePath: wt.worktreePath,
      terminalId,
      startedAt: this.now(),
    });
  }

  /** Finalize any in-flight review whose verdict file is ready or that timed out. */
  async tick(): Promise<void> {
    for (const f of [...this.inflight.values()]) {
      const raw = this.readVerdict(f.worktreePath);
      const timedOut = this.now() - f.startedAt > this.timeoutMs;
      if (!raw && !timedOut) continue;
      this.inflight.delete(f.sessionId); // claim it before any await
      await this.finalize(f, raw);
    }
  }

  private async finalize(f: InFlight, raw: RawVerdict | null): Promise<void> {
    const verdict = this.buildVerdict(f, raw);
    if (verdict.decision !== "error") {
      const forge = this.deps.resolveForge(f.repoPath);
      if (forge) {
        try {
          const event = verdict.decision === "changes_requested" ? "REQUEST_CHANGES" : "COMMENT";
          const { url } = await forge.postReview(f.prNumber, { event, body: verdict.body });
          verdict.url = url;
        } catch (err) {
          console.warn(`[review] postReview failed for ${f.sessionId}:`, err);
        }
      }
    }
    this.deps.store.putReview(verdict);
    this.deps.onChange(f.sessionId, verdict);
    this.deps.herdr.stop(f.terminalId);
    this.deps.worktree.remove(f.worktreePath);
  }

  private buildVerdict(f: InFlight, raw: RawVerdict | null): ReviewVerdict {
    const decision = normalizeDecision(raw?.decision);
    return {
      sessionId: f.sessionId,
      headSha: f.headSha,
      decision: raw && decision ? decision : "error",
      summary:
        raw && typeof raw.summary === "string"
          ? raw.summary.slice(0, 100)
          : "critic did not produce a verdict",
      body: raw && typeof raw.body === "string" ? raw.body : "",
      updatedAt: this.now(),
    };
  }

  snapshot(): Record<string, ReviewVerdict> {
    return this.deps.store.snapshotReviews();
  }

  forget(sessionId: string): void {
    const f = this.inflight.get(sessionId);
    if (f) {
      this.deps.herdr.stop(f.terminalId);
      this.deps.worktree.remove(f.worktreePath);
      this.inflight.delete(sessionId);
    }
    this.deps.store.dropReview(sessionId);
  }
}

function defaultReadVerdict(worktreePath: string): RawVerdict | null {
  const p = join(worktreePath, VERDICT_FILE);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as RawVerdict;
  } catch {
    return null; // partial write; try again next tick
  }
}

function normalizeDecision(d: unknown): ReviewDecision | null {
  if (d === "request-changes") return "changes_requested";
  if (d === "comment") return "commented";
  return null;
}
