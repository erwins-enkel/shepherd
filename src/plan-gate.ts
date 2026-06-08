import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { SessionStore } from "./store";
import type { HerdrDriver } from "./herdr";
import type { WorktreeMgr } from "./worktree";
import type { Session, PlanGate, PlanDecision } from "./types";

/** The plan the planning agent writes in its LIVE session worktree; the reviewer reads its text. */
export const PLAN_FILE = ".shepherd-plan.md";

/** The file the adversarial plan reviewer writes its verdict JSON to, in its detached worktree. */
export const PLAN_VERDICT_FILE = ".shepherd-plan-review.json";

/** Self-contained instructions for the adversarial plan reviewer. NOT UI chrome — never i18n'd.
 *  The plan text is UNTRUSTED agent output embedded as data; the read-only dontAsk sandbox
 *  (mirrors the PR critic) contains any injection. */
export function planReviewPrompt(task: string, plan: string, priorFindings: string[] = []): string {
  const lines = [
    "You are an adversarial plan reviewer. Read-only — do NOT modify, build, commit, or run anything.",
    "A coding agent wrote the PLAN below to accomplish a TASK, BEFORE writing any code. Your job is to",
    "try to REFUTE the plan: is it the best path? Does it actually satisfy the task? What are the hidden",
    "risks, missing steps, wrong assumptions, or a materially simpler approach it ignored? You MAY inspect",
    "the codebase read-only (git log/show/diff, Read, Grep) to ground your critique.",
    "",
    "TASK:",
    task,
    "",
    "PLAN (.shepherd-plan.md):",
    plan,
    "",
  ];
  if (priorFindings.length) {
    lines.push(
      "This is a RE-REVIEW. For EACH prior point, confirm the revised plan addresses it; if it does not, re-raise it verbatim:",
      ...priorFindings.map((f, i) => `${i + 1}. ${f}`),
      "",
    );
  }
  lines.push(
    `Write your verdict as JSON to \`${PLAN_VERDICT_FILE}\` in the current directory, with EXACTLY this shape:`,
    '{"decision": "approve" | "request-changes", "summary": "<=100 char one-liner", "body": "<full markdown>", "findings": ["<discrete actionable revision>", ...]}',
    'Use "approve" ONLY when the plan is genuinely the best reasonable path and fully satisfies the task — no remaining blocking concerns. Otherwise "request-changes" with at least one finding in "findings". Write the file as your final action, then stop.',
  );
  return lines.join("\n");
}

/** Build the read-only plan reviewer's argv — deliberately NOT --dangerously-skip-permissions. It
 *  inspects UNTRUSTED agent-written plan text, so a prompt-injection hidden in that plan must not
 *  be able to run commands or escape its worktree. `dontAsk` auto-denies anything off the allowlist
 *  (an unattended PTY would otherwise hang on a permission prompt); the allowlist is
 *  read-only inspection + read-only git + writing files in its own disposable worktree. */
export function reviewerArgv(model: string | null, prompt: string): string[] {
  const argv = [
    "claude",
    "--session-id",
    randomUUID(),
    // Run the reviewer in a CLEAN context. It's a fresh `claude` startup, so it
    // would otherwise inherit the user's global hooks + plugins — notably the
    // superpowers SessionStart hook, which injects a forceful "you MUST invoke
    // a skill" preamble. Skill isn't on the allowlist, so dontAsk denies it and
    // the agent thrashes instead of reviewing. disableAllHooks strips every
    // inherited hook (also gsd/herdr/ensure-deps — none of which the reviewer
    // needs); --disable-slash-commands removes skills entirely.
    // NOT --bare: it refuses OAuth/keychain auth (strictly ANTHROPIC_API_KEY),
    // and shepherd runs on subscription OAuth with no API key — --bare would
    // break the reviewer's auth. --settings keeps OAuth while disabling hooks.
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
    // so a scoped rule would block the verdict write and the reviewer could never
    // finish → timeout. Bare Write is an acceptable widening: the worktree is
    // detached + disposable (removed right after the review) and the agent still
    // can't exec, commit, push, or reach anything outside it (no general Bash,
    // no Edit, no network).
    "Write",
  ];
  if (model) argv.push("--model", model);
  // --permission-mode LAST: `--allowedTools <tools...>` is variadic and eats
  // every following token until the next flag. The task prompt is a trailing
  // positional, so a single-value flag MUST sit between the allowlist and the
  // prompt — otherwise `claude` folds the prompt into the allowlist, launches
  // with no task, and hangs until timeout (every review). Don't reorder.
  argv.push("--permission-mode", "dontAsk");
  argv.push(prompt);
  return argv;
}

// How long an in-flight plan review may run before tick() (Task 6) gives up on the verdict.
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_CAP = 3;

/** The reviewer's verdict JSON, as written to PLAN_VERDICT_FILE — untyped fields are coerced
 *  in finalize() (Task 6). Mirrors review.ts's RawVerdict. */
export interface RawPlanVerdict {
  decision?: unknown;
  summary?: unknown;
  body?: unknown;
  findings?: unknown;
}

export interface PlanGateServiceDeps {
  store: Pick<
    SessionStore,
    | "getPlanGate"
    | "putPlanGate"
    | "dropPlanGate"
    | "snapshotPlanGates"
    | "getRepoConfig"
    | "addSignal"
    | "get"
  >;
  herdr: Pick<HerdrDriver, "start" | "stop">;
  worktree: Pick<WorktreeMgr, "createDetached" | "remove">;
  /** Steer reviewer findings into the live planning agent's PTY (SessionService.reply). */
  reply: (sessionId: string, text: string) => boolean;
  /** Release an APPROVED auto session into execution (SessionService.releasePlanGate). */
  release: (sessionId: string) => void;
  onChange: (id: string, gate: PlanGate) => void;
  /** Fired when a plan review starts (true) and when it ends (false) for a session. */
  onReviewing?: (id: string, reviewing: boolean) => void;
  /**
   * Max adversarial rounds before escalating to the human (default 3). Pass a thunk to read a
   * live, UI-configurable value per-use — resolved on every read so a settings change takes
   * effect on the next run without a restart.
   */
  cap?: number | (() => number);
  model?: string | null; // optional --model for the reviewer
  now?: () => number;
  timeoutMs?: number; // give up waiting on the verdict file
  /** default: read `.shepherd-plan.md` from the live worktree. */
  readPlan?: (worktreePath: string) => string | null;
  /** default: read PLAN_VERDICT_FILE from the reviewer's disposable worktree. */
  readVerdict?: (worktreePath: string) => RawPlanVerdict | null;
  /** default: `git rev-parse origin/<base>` (fallback `<base>`) in the repo. */
  baseSha?: (repoPath: string, base: string) => string;
}

interface PlanInFlight {
  sessionId: string;
  repoPath: string; // for the stall signal
  worktreePath: string; // the disposable reviewer worktree
  terminalId: string;
  planHash: string;
  plan: string;
  priorRound: number; // adversarial rounds already spent on this plan streak
  startedAt: number;
  finalizing?: boolean;
}

export class PlanGateService {
  private inflight = new Map<string, PlanInFlight>();
  // Session ids whose reviewer is mid-spawn but not yet in `inflight`. begin() awaits the
  // plan hash before claiming `inflight`, so this claims the slot across that await — without
  // it, a second consider() would pass the inflight guard and double-spawn, orphaning the
  // first run's worktree + terminal.
  private starting = new Set<string>();
  private now: () => number;
  private timeoutMs: number;
  // Resolve the cap on every read so a live config thunk (UI setting) takes effect on the
  // next run. A plain number or absent dep collapses to a constant thunk.
  private capFn: () => number;
  private get cap(): number {
    return this.capFn();
  }
  private readPlan: (worktreePath: string) => string | null;
  private readVerdict: (worktreePath: string) => RawPlanVerdict | null;
  private baseSha: (repoPath: string, base: string) => string;

  constructor(private deps: PlanGateServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // capture into a const so the constant-thunk closure keeps the narrowed type.
    const cap = deps.cap;
    this.capFn = typeof cap === "function" ? cap : () => cap ?? DEFAULT_CAP;
    this.readPlan = deps.readPlan ?? defaultReadPlan;
    this.readVerdict = deps.readVerdict ?? defaultReadVerdict;
    this.baseSha = deps.baseSha ?? defaultBaseSha;
  }

  /** sha256 of the plan text — dedups re-reviews of an unchanged plan. */
  static async hashPlan(plan: string): Promise<string> {
    return createHash("sha256").update(plan).digest("hex");
  }

  /** Decide whether `session`'s current plan warrants a fresh adversarial review, and start one. */
  async consider(session: Session): Promise<void> {
    if (session.planPhase !== "planning") return; // only gate before execution
    if (this.inflight.has(session.id) || this.starting.has(session.id)) return; // in flight / mid-spawn
    const plan = (this.readPlan(session.worktreePath) ?? "").trim();
    if (!plan) return; // no plan written yet → nothing to review
    // Claim the slot SYNCHRONOUSLY, before any await — hashPlan is async, so two concurrent
    // considers would otherwise both clear the guards above and double-spawn (orphaning the
    // first run's worktree + terminal). With the claim here, the second bails on the guard.
    this.starting.add(session.id);
    try {
      const planHash = await PlanGateService.hashPlan(plan);
      const prior = this.deps.store.getPlanGate(session.id);
      if (prior?.approved) return; // already cleared → execution allowed, don't re-review
      if (prior?.planHash === planHash) return; // dedupe an unchanged plan
      await this.begin(session, plan, planHash, prior);
    } finally {
      this.starting.delete(session.id);
    }
  }

  private async begin(
    session: Session,
    plan: string,
    planHash: string,
    prior: PlanGate | null,
  ): Promise<void> {
    // Resolve the base SHA so the reviewer inspects a CLEAN copy of the codebase at the base
    // branch — never the live worktree (the planning agent is still editing it). baseSha's
    // default catches internally and falls back to the base ref / name, so this won't throw.
    const sha = this.baseSha(session.repoPath, session.baseBranch);

    // Disposable detached worktree at the base: read-only codebase inspection that can't race
    // the live planning agent. The plan TEXT travels inline in the prompt, not via this tree.
    let wt;
    try {
      wt = this.deps.worktree.createDetached(session.repoPath, session.baseBranch, sha);
    } catch (err) {
      console.warn(`[plan-gate] worktree failed for ${session.id}:`, err);
      return;
    }

    const prompt = planReviewPrompt(session.prompt, plan, prior?.findings ?? []);
    const argv = reviewerArgv(this.deps.model ?? null, prompt);
    let terminalId: string;
    try {
      terminalId = this.deps.herdr.start(
        `plan-review ${session.desig}`,
        wt.worktreePath,
        argv,
      ).terminalId;
    } catch (err) {
      console.warn(`[plan-gate] spawn failed for ${session.id}:`, err);
      this.deps.worktree.remove(wt.worktreePath);
      return;
    }
    this.inflight.set(session.id, {
      sessionId: session.id,
      repoPath: session.repoPath,
      worktreePath: wt.worktreePath,
      terminalId,
      planHash,
      plan,
      priorRound: prior?.round ?? 0,
      startedAt: this.now(),
    });
    this.deps.onReviewing?.(session.id, true);
  }

  /** Finalize any in-flight plan review whose verdict file is ready or that timed out. */
  async tick(): Promise<void> {
    for (const f of [...this.inflight.values()]) {
      if (f.finalizing) continue; // already being finalized by an overlapping tick
      const raw = this.readVerdict(f.worktreePath);
      const timedOut = this.now() - f.startedAt > this.timeoutMs;
      if (!raw && !timedOut) continue;
      f.finalizing = true; // stay claimed in `inflight` so consider() won't re-spawn mid-finalize
      // Always drop the entry, even if finalize throws — otherwise it stays
      // `finalizing=true` and every later tick `continue`s past it, wedging the
      // session's gate forever (and leaking its worktree/terminal).
      try {
        await this.finalize(f, raw);
      } finally {
        this.inflight.delete(f.sessionId);
      }
    }
  }

  private async finalize(f: PlanInFlight, raw: RawPlanVerdict | null): Promise<void> {
    // Reap the reviewer terminal + disposable worktree no matter what happens above
    // (a store/steer/release failure must not strand them).
    try {
      const gate = this.buildGate(f, raw);
      if (gate.decision === "approved") {
        this.deps.store.putPlanGate(gate);
        this.deps.onChange(f.sessionId, gate);
        // Auto sessions clear the gate straight into execution; interactive sessions
        // wait for the human's explicit Go (so we do NOT release them here).
        if (this.deps.store.get(f.sessionId)?.auto === true) this.deps.release(f.sessionId);
      } else if (gate.decision === "changes_requested") {
        // Steer the findings back to the LIVE planning agent — but only while under the
        // cap. At/over the cap we stop steering and escalate to the operator instead.
        const priorRound = f.priorRound;
        let delivered = false;
        if (priorRound < this.cap) {
          try {
            delivered = this.deps.reply(f.sessionId, planSteerText(gate.findings));
          } catch (err) {
            console.warn(`[plan-gate] steer failed for ${f.sessionId}:`, err);
          }
        }
        // Round advances only when the steer actually lands; at/over the cap it holds.
        gate.round = priorRound >= this.cap ? priorRound : delivered ? priorRound + 1 : priorRound;
        // Escalate to the operator whenever the streak is at/over the cap — a plan
        // stuck at the cap (or a steer that couldn't land at the cap boundary) can't
        // make progress on its own. Fires on the crossing round and on any re-review
        // that re-enters already at the cap (each is a fresh "still stuck" event).
        if (gate.round >= this.cap) {
          this.deps.store.addSignal({
            repoPath: f.repoPath,
            sessionId: f.sessionId,
            kind: "stall",
            payload: `plan reviewer requested changes ${gate.round} rounds running and the plan still isn't approved — needs a human`,
          });
        }
        this.deps.store.putPlanGate(gate);
        this.deps.onChange(f.sessionId, gate);
        // Do NOT release: execution stays gated until the plan is approved.
      } else {
        // error (timeout / unparseable verdict): bias to surface. Persist the error
        // gate + escalate, but don't steer (no real findings) and don't release.
        this.deps.store.putPlanGate(gate);
        this.deps.onChange(f.sessionId, gate);
        this.deps.store.addSignal({
          repoPath: f.repoPath,
          sessionId: f.sessionId,
          kind: "stall",
          payload: "plan reviewer did not produce a verdict — needs a human",
        });
      }
    } finally {
      this.deps.onReviewing?.(f.sessionId, false);
      this.deps.herdr.stop(f.terminalId);
      this.deps.worktree.remove(f.worktreePath);
    }
  }

  private buildGate(f: PlanInFlight, raw: RawPlanVerdict | null): PlanGate {
    const decision = normalizeDecision(raw?.decision);
    const resolved: PlanDecision = raw && decision ? decision : "error";
    const summary =
      resolved === "error"
        ? "plan reviewer did not produce a verdict"
        : raw && typeof raw.summary === "string"
          ? raw.summary.slice(0, 100)
          : "";
    const body = raw && typeof raw.body === "string" ? raw.body : "";
    const parsed = normalizeFindings(raw?.findings);
    // a request-changes verdict with no usable findings still has something to address;
    // fall back to its summary so the steer-back isn't empty.
    const findings =
      resolved === "approved" || resolved === "error"
        ? []
        : parsed.length
          ? parsed
          : summary
            ? [summary]
            : [];
    return {
      sessionId: f.sessionId,
      planHash: f.planHash,
      decision: resolved,
      summary,
      body,
      findings,
      // approved resets the streak; changes_requested/error carry priorRound (finalize()
      // overwrites it for changes_requested once the steer outcome is known).
      round: resolved === "approved" ? 0 : f.priorRound,
      cap: this.cap, // surface the live cap so the UI badge need not mirror it
      approved: resolved === "approved",
      plan: f.plan,
      updatedAt: this.now(),
    };
  }

  snapshot(): Record<string, PlanGate> {
    return this.deps.store.snapshotPlanGates();
  }

  /** Session ids with a plan review currently in flight (for client bootstrap). */
  reviewingIds(): string[] {
    return [...this.inflight.keys()];
  }

  forget(sessionId: string): void {
    // Clear the `starting` tombstone so an archived session can't get a review after
    // forget(). Unlike ReviewService.begin (which awaits a network gh fetch and re-checks
    // `starting` to abort mid-spawn), our begin() has no post-await step that allocates a
    // worktree — its only await is the pure-CPU plan hash — so no abort re-check is needed.
    this.starting.delete(sessionId);
    const f = this.inflight.get(sessionId);
    if (f) {
      this.deps.herdr.stop(f.terminalId);
      this.deps.worktree.remove(f.worktreePath);
      this.inflight.delete(sessionId);
      this.deps.onReviewing?.(sessionId, false);
    }
    this.deps.store.dropPlanGate(sessionId);
  }
}

/** Agent-facing steer that carries the reviewer's plan findings into the planning PTY. NOT i18n'd. */
export function planSteerText(findings: string[]): string {
  return (
    "The plan reviewer raised these points on `.shepherd-plan.md`. Revise the plan to address each, then stop so it can be re-reviewed:\n\n" +
    findings.map((f, i) => `${i + 1}. ${f}`).join("\n") +
    "\n\nDon't start implementing yet — wait for the plan to be approved."
  );
}

/** Map the reviewer's raw decision string onto a PlanDecision; null = unrecognized (→ error). */
function normalizeDecision(d: unknown): PlanDecision | null {
  if (d === "approve") return "approved";
  if (d === "request-changes") return "changes_requested";
  return null;
}

/** Coerce the reviewer's `findings` field to a clean string[] (drops junk, never throws). */
function normalizeFindings(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f): f is string => typeof f === "string")
    .map((f) => f.trim())
    .filter(Boolean);
}

/** Read the live session worktree's plan text. Null when no plan has been written yet. */
function defaultReadPlan(worktreePath: string): string | null {
  const p = join(worktreePath, PLAN_FILE);
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** Read the reviewer's verdict JSON from its disposable worktree. Null until written / on a
 *  partial-write parse failure (retried next tick). */
function defaultReadVerdict(worktreePath: string): RawPlanVerdict | null {
  const p = join(worktreePath, PLAN_VERDICT_FILE);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as RawPlanVerdict;
  } catch {
    return null; // partial write; try again next tick
  }
}

/** Resolve the base branch's SHA for the disposable worktree. Prefer the freshest `origin/<base>`,
 *  fall back to the local `<base>` ref, and finally to the branch name itself (createDetached can
 *  still resolve it). `--end-of-options` guards a hostile branch name from flag-smuggling (the
 *  rev-parse-correct terminator — `--` makes rev-parse read the operand as a pathspec). Any git
 *  failure degrades to the next fallback — never throws. */
function defaultBaseSha(repoPath: string, base: string): string {
  const revParse = (ref: string): string | null => {
    try {
      return execFileSync("git", ["rev-parse", "--verify", "--end-of-options", ref], {
        cwd: repoPath,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
    } catch {
      return null;
    }
  };
  return revParse(`origin/${base}`) ?? revParse(base) ?? base;
}
