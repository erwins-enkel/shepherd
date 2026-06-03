import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionStore } from "./store";
import type { HerdrDriver } from "./herdr";
import type { WorktreeMgr } from "./worktree";
import type { GitForge, GitState } from "./forge/types";
import { CRITIC_REVIEW_MARKER } from "./forge/types";
import type { ReviewVerdict, ReviewDecision, Session } from "./types";

/** Self-contained instructions for the critic agent. NOT UI chrome — never i18n'd. */
export function reviewPrompt(
  base: string,
  taskPrompt: string,
  priorFindings: string[] = [],
): string {
  const lines = [
    "You are a code critic reviewing a pull request. Do NOT modify, build, commit, or run anything — read-only inspection only.",
    `The PR branch is checked out here at its head commit. Review the changes with: git diff ${base}...HEAD`,
    "",
    "The task this PR is meant to accomplish:",
    taskPrompt,
    "",
  ];
  if (priorFindings.length) {
    lines.push(
      "This is a RE-REVIEW. The previous revision raised the points below. For EACH, confirm the new diff actually addresses it; if it does not, re-raise it verbatim in your findings — do not let it slide:",
      ...priorFindings.map((f, i) => `${i + 1}. ${f}`),
      "",
    );
  }
  lines.push(
    "Judge ONLY whether the implementation satisfies that task and is free of bugs, security issues, and clear quality problems. Tests and lint are handled by CI — do not run them.",
    "When done, write your verdict as JSON to the file `.shepherd-review.json` in the repository root, with EXACTLY this shape:",
    '{"decision": "request-changes" | "comment", "summary": "<=100 char one-liner", "body": "<full markdown review>", "findings": ["<discrete actionable item>", ...]}',
    'The "findings" array lists every discrete change the author must make — one entry per point, blocking or not. A non-blocking nit STILL goes in "findings" (under a "comment" decision). Use [] ONLY when there is genuinely nothing to address; "request-changes" requires at least one finding.',
    'Use "request-changes" ONLY for blocking problems (does not satisfy the task, logic bug, security hole). Otherwise use "comment". Never approve. Write the file as your final action, then stop.',
  );
  return lines.join("\n");
}

/** Agent-facing steer that carries critic findings into the task PTY. NOT i18n'd. */
function steerText(findings: string[]): string {
  return [
    "The PR critic reviewed your latest push. Address each point below in this PR:",
    "",
    ...findings.map((f, i) => `${i + 1}. ${f}`),
    "",
    "Fix what's valid; if you genuinely disagree with a point, address the rest and proceed — don't silently skip it. Then commit & push so CI and the critic re-run.",
  ].join("\n");
}

const VERDICT_FILE = ".shepherd-review.json";
const DEFAULT_CAP = 3; // max auto-address steers per outstanding-findings streak

interface InFlight {
  sessionId: string;
  headSha: string;
  prNumber: number;
  repoPath: string;
  worktreePath: string;
  terminalId: string;
  startedAt: number;
  priorRound: number; // auto-address steers already spent on this findings streak
  finalizing?: boolean;
}

export interface ReviewServiceDeps {
  store: Pick<
    SessionStore,
    "getRepoConfig" | "getReview" | "putReview" | "dropReview" | "snapshotReviews" | "addSignal"
  >;
  herdr: Pick<HerdrDriver, "start" | "stop">;
  worktree: Pick<WorktreeMgr, "createDetached" | "remove">;
  resolveForge: (repoPath: string) => GitForge | null;
  onChange: (id: string, verdict: ReviewVerdict) => void;
  /** Fired when a critic run starts (true) and when it ends (false) for a session. */
  onReviewing?: (id: string, reviewing: boolean) => void;
  /**
   * Steer critic findings into a session's live PTY (typically SessionService.reply).
   * Returns false when the agent pane is gone (the steer never landed). Absent → the
   * auto-address loop is disabled regardless of per-repo config.
   */
  autoAddress?: (sessionId: string, text: string) => boolean;
  cap?: number; // max auto-address rounds before escalating to the human (default 3)
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
  findings?: unknown;
}

export class ReviewService {
  private inflight = new Map<string, InFlight>();
  private now: () => number;
  private timeoutMs: number;
  private cap: number;
  private readVerdict: (worktreePath: string) => RawVerdict | null;

  constructor(private deps: ReviewServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.timeoutMs = deps.timeoutMs ?? 10 * 60 * 1000;
    this.cap = deps.cap ?? DEFAULT_CAP;
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
    // The prior verdict (an earlier head — consider() never re-reviews the same head)
    // carries this streak's accountability state: its findings get fed to the critic
    // to verify they were addressed, and its addressRound bounds the auto-address loop.
    const prior = this.deps.store.getReview(session.id);
    const priorFindings = prior?.findings ?? [];
    const priorRound = prior?.addressRound ?? 0;
    let wt;
    try {
      wt = this.deps.worktree.createDetached(session.repoPath, session.branch!, git.headSha!);
    } catch (err) {
      console.warn(`[review] worktree failed for ${session.id}:`, err);
      return;
    }
    // Read-only critic — deliberately NOT --dangerously-skip-permissions. It
    // inspects an UNTRUSTED PR diff, so a prompt-injection hidden in that diff
    // must not be able to run commands or escape its worktree. `dontAsk`
    // auto-denies anything off the allowlist (an unattended PTY would otherwise
    // hang on a permission prompt); the allowlist is read-only inspection +
    // read-only git + writing files in its own disposable worktree.
    const argv = [
      "claude",
      "--session-id",
      randomUUID(),
      // Run the critic in a CLEAN context. It's a fresh `claude` startup, so it
      // would otherwise inherit the user's global hooks + plugins — notably the
      // superpowers SessionStart hook, which injects a forceful "you MUST invoke
      // a skill" preamble. Skill isn't on the allowlist, so dontAsk denies it and
      // the agent thrashes instead of reviewing. disableAllHooks strips every
      // inherited hook (also gsd/herdr/ensure-deps — none of which the critic
      // needs); --disable-slash-commands removes skills entirely.
      // NOT --bare: it refuses OAuth/keychain auth (strictly ANTHROPIC_API_KEY),
      // and shepherd runs on subscription OAuth with no API key — --bare would
      // break the critic's auth. --settings keeps OAuth while disabling hooks.
      "--settings",
      '{"disableAllHooks":true}',
      "--disable-slash-commands",
      "--allowedTools",
      "Read",
      "Grep",
      "Glob",
      "Bash(git diff *)",
      "Bash(git log *)",
      "Bash(git show *)",
      "Bash(git status)",
      // Bare `Write` — NOT Write(<path>). Path-scoped Write rules are silently
      // denied under --permission-mode dontAsk (every scoped form fails to match),
      // so a scoped rule would block the verdict write and the critic could never
      // finish → timeout. Bare Write is an acceptable widening: the worktree is
      // detached + disposable (removed right after the review) and the agent still
      // can't exec, commit, push, or reach anything outside it (no general Bash,
      // no Edit, no network).
      "Write",
    ];
    if (this.deps.model) argv.push("--model", this.deps.model);
    // --permission-mode LAST: `--allowedTools <tools...>` is variadic and eats
    // every following token until the next flag. The task prompt is a trailing
    // positional, so a single-value flag MUST sit between the allowlist and the
    // prompt — otherwise `claude` folds the prompt into the allowlist, launches
    // with no task, and hangs until timeout (every review). Don't reorder.
    argv.push("--permission-mode", "dontAsk");
    argv.push(reviewPrompt(session.baseBranch, session.prompt, priorFindings));
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
      priorRound,
    });
    this.deps.onReviewing?.(session.id, true);
  }

  /** Finalize any in-flight review whose verdict file is ready or that timed out. */
  async tick(): Promise<void> {
    for (const f of [...this.inflight.values()]) {
      if (f.finalizing) continue; // already being finalized by an overlapping tick
      const raw = this.readVerdict(f.worktreePath);
      const timedOut = this.now() - f.startedAt > this.timeoutMs;
      if (!raw && !timedOut) continue;
      f.finalizing = true; // stay claimed in `inflight` so consider() won't re-spawn mid-finalize
      await this.finalize(f, raw);
      this.inflight.delete(f.sessionId);
    }
  }

  private async finalize(f: InFlight, raw: RawVerdict | null): Promise<void> {
    const verdict = this.buildVerdict(f, raw);
    if (verdict.decision !== "error") {
      const forge = this.deps.resolveForge(f.repoPath);
      if (forge) {
        try {
          const event = verdict.decision === "changes_requested" ? "REQUEST_CHANGES" : "COMMENT";
          const { url } = await forge.postReview(f.prNumber, {
            event,
            body: `${verdict.body}\n\n${CRITIC_REVIEW_MARKER}`,
          });
          verdict.url = url;
        } catch (err) {
          console.warn(`[review] postReview failed for ${f.sessionId}:`, err);
        }
      }
    }
    verdict.addressRound = this.runAutoAddress(f, verdict);
    this.deps.store.putReview(verdict);
    if (verdict.decision === "changes_requested") {
      this.deps.store.addSignal({
        repoPath: f.repoPath,
        sessionId: f.sessionId,
        kind: "critic",
        payload: `${verdict.summary}\n\n${verdict.body}`,
      });
    }
    this.deps.onChange(f.sessionId, verdict);
    this.deps.onReviewing?.(f.sessionId, false);
    this.deps.herdr.stop(f.terminalId);
    this.deps.worktree.remove(f.worktreePath);
  }

  /**
   * Close the loop: feed the verdict's findings back to the task agent and return the
   * new streak round. Empty findings = clean → reset to 0. Otherwise, if auto-address
   * is enabled and the prior round is under the cap, steer once and advance — but only
   * if the steer actually reached the agent (a dead pane holds the round). At/over the
   * cap we stop steering and leave the round in place; the posted review + critic signal
   * escalate it to the human.
   */
  private runAutoAddress(f: InFlight, verdict: ReviewVerdict): number {
    if (verdict.findings.length === 0) return 0; // clean → streak resets
    const enabled =
      !!this.deps.autoAddress && this.deps.store.getRepoConfig(f.repoPath).autoAddressEnabled;
    if (!enabled || f.priorRound >= this.cap) return f.priorRound; // off, or gave up → hold
    const delivered = this.deps.autoAddress!(f.sessionId, steerText(verdict.findings));
    return delivered ? f.priorRound + 1 : f.priorRound; // no progress if the pane is gone
  }

  private buildVerdict(f: InFlight, raw: RawVerdict | null): ReviewVerdict {
    const decision = normalizeDecision(raw?.decision);
    const resolved: ReviewDecision = raw && decision ? decision : "error";
    const summary =
      raw && typeof raw.summary === "string"
        ? raw.summary.slice(0, 100)
        : "critic did not produce a verdict";
    const parsed = normalizeFindings(raw?.findings);
    // a blocking verdict with no usable findings list still has something to address;
    // fall back to its summary so the loop doesn't mistake it for "clean".
    const findings =
      parsed.length || resolved !== "changes_requested" ? parsed : summary ? [summary] : [];
    return {
      sessionId: f.sessionId,
      headSha: f.headSha,
      decision: resolved,
      summary,
      body: raw && typeof raw.body === "string" ? raw.body : "",
      findings,
      addressRound: 0, // finalize() overwrites with the streak round
      updatedAt: this.now(),
    };
  }

  snapshot(): Record<string, ReviewVerdict> {
    return this.deps.store.snapshotReviews();
  }

  /** Session ids with a critic run currently in flight (for client bootstrap). */
  reviewingIds(): string[] {
    return [...this.inflight.keys()];
  }

  forget(sessionId: string): void {
    const f = this.inflight.get(sessionId);
    if (f) {
      this.deps.herdr.stop(f.terminalId);
      this.deps.worktree.remove(f.worktreePath);
      this.inflight.delete(sessionId);
      this.deps.onReviewing?.(sessionId, false);
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

/** Coerce the critic's `findings` field to a clean string[] (drops junk, never throws). */
function normalizeFindings(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f): f is string => typeof f === "string")
    .map((f) => f.trim())
    .filter(Boolean);
}
