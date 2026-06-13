/**
 * RecapService — auto-generates a one-time, head-keyed session recap via a transient
 * Sonnet spawn. Mirrors ReviewService/PlanGateService structure:
 *   sweep()      — periodic auto-fire (settled-idle debounce, head-keyed dedupe)
 *   tick()       — finalize in-flight recaps (restart-safe, reads from DB)
 *   generate()   — shared spawn path (auto + on-demand)
 *   regenerate() — on-demand force (bypasses scope/debounce/dedupe)
 *   snapshot()   — snapshot for client bootstrap
 *   forget()     — reap + drop on archive
 *
 * Spawn pattern mirrors src/namer-llm.ts: tmpdir cwd, Write-only, dontAsk,
 * disableAllHooks, disable-slash-commands. No worktree, no membrane.
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SessionStore } from "./store";
import type { HerdrDriver } from "./herdr";
import type { Session, Recap } from "./types";
import type { DiffResult } from "./types";
import type { ActivityEntry } from "./activity";
import type { SessionUsage } from "./usage";
import { readSessionUsage } from "./usage";
import { computeDiff } from "./diff";
import { parseActivity, readTranscriptTail } from "./activity";
import { jsonlPathFor } from "./usage";
import {
  parseRecapVerdict,
  buildTranscriptDigest,
  buildRecapPrompt,
  isSettledIdle,
  needsRecap,
} from "./recap-core";

const execFileAsync = promisify(execFile);

/** The file the recap agent writes its JSON verdict to, in its temp cwd. */
export const RECAP_VERDICT_FILE = ".shepherd-recap.json";

/** Plan file the agent writes in its LIVE session worktree. */
const PLAN_FILE = ".shepherd-plan.md";

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_IDLE_THRESHOLD_MS = 120_000;

// ── defaults ──────────────────────────────────────────────────────────────────

async function defaultHeadSha(worktreePath: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: worktreePath,
    encoding: "utf8",
  });
  return stdout.trim();
}

function defaultReadTranscript(worktreePath: string, claudeSessionId: string): ActivityEntry[] {
  const path = jsonlPathFor(worktreePath, claudeSessionId);
  try {
    const text = readTranscriptTail(path);
    return parseActivity(text, -1); // -1 = all entries
  } catch {
    return [];
  }
}

function defaultReadPlan(worktreePath: string): string {
  const p = join(worktreePath, PLAN_FILE);
  if (!existsSync(p)) return "";
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function defaultReadVerdict(cwd: string): unknown | null {
  const p = join(cwd, RECAP_VERDICT_FILE);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as unknown;
  } catch {
    return null; // partial write; retry next tick
  }
}

function defaultMakeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "shepherd-recap-"));
}

function defaultCleanup(cwd: string): void {
  try {
    rmSync(cwd, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * The `claude` argv for the recap spawn — mirrors namerArgv exactly, with model
 * defaulting to "sonnet" instead of "haiku".
 *
 * Layout: --session-id uuid --settings '{"disableAllHooks":true}'
 *   --disable-slash-commands --allowedTools Write [--model <m>]
 *   --permission-mode dontAsk <prompt>
 * NOTE: --allowedTools is variadic and eats tokens until the next flag, so
 * --permission-mode must follow it and the prompt must be last. Don't reorder.
 */
function recapArgv(model: string | null, prompt: string): { argv: string[]; sessionId: string } {
  const sessionId = randomUUID();
  const argv = [
    "claude",
    "--session-id",
    sessionId,
    "--settings",
    '{"disableAllHooks":true}',
    "--disable-slash-commands",
    "--allowedTools",
    "Write",
  ];
  if (model) argv.push("--model", model);
  argv.push("--permission-mode", "dontAsk");
  argv.push(prompt);
  return { argv, sessionId };
}

// ── deps interface ────────────────────────────────────────────────────────────

export interface RecapServiceDeps {
  store: Pick<
    SessionStore,
    | "getRecap"
    | "putRecap"
    | "snapshotRecaps"
    | "generatingRecaps"
    | "dropRecap"
    | "getReview"
    | "recordReviewerSpawn"
    | "completeReviewerSpawn"
    | "list"
  >;
  herdr: Pick<HerdrDriver, "start" | "stop" | "list">;
  onChange: (id: string, recap: Recap | null) => void;
  model?: string | null;
  now?: () => number;
  timeoutMs?: number;
  idleThresholdMs?: number;
  // injectables:
  computeDiff?: (worktreePath: string, base: string, branch: string | null) => Promise<DiffResult>;
  headSha?: (worktreePath: string) => Promise<string>;
  readTranscript?: (worktreePath: string, claudeSessionId: string) => ActivityEntry[];
  readPlan?: (worktreePath: string) => string;
  readVerdict?: (cwd: string) => unknown | null;
  readUsage?: (cwd: string, spawnSessionId: string) => Promise<SessionUsage | null>;
  makeTmpDir?: () => string;
  cleanup?: (cwd: string) => void;
}

// ── per-session debounce state ────────────────────────────────────────────────

interface DebounceEntry {
  stamp: number; // epoch ms when we first saw the session idle/done
  fired: boolean; // true = recap already triggered this idle episode
}

// ── service ───────────────────────────────────────────────────────────────────

export class RecapService {
  private now: () => number;
  private timeoutMs: number;
  private idleThresholdMs: number;
  private model: string | null;

  private _computeDiff: (
    worktreePath: string,
    base: string,
    branch: string | null,
  ) => Promise<DiffResult>;
  private _headSha: (worktreePath: string) => Promise<string>;
  private _readTranscript: (worktreePath: string, claudeSessionId: string) => ActivityEntry[];
  private _readPlan: (worktreePath: string) => string;
  private _readVerdict: (cwd: string) => unknown | null;
  private _readUsage: (cwd: string, spawnSessionId: string) => Promise<SessionUsage | null>;
  private _makeTmpDir: () => string;
  private _cleanup: (cwd: string) => void;

  /** Per-session settled-idle debounce: stamp + fired-this-episode flag. */
  private debounce = new Map<string, DebounceEntry>();

  /** Guards against a session being finalized twice across overlapping ticks. */
  private finalizing = new Set<string>();

  /** Guards against double-spawn when regenerate races a mid-flight sweep. */
  private inFlight = new Set<string>();

  constructor(private deps: RecapServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.idleThresholdMs = deps.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
    this.model = deps.model ?? "sonnet";
    this._computeDiff = deps.computeDiff ?? computeDiff;
    this._headSha = deps.headSha ?? defaultHeadSha;
    this._readTranscript = deps.readTranscript ?? defaultReadTranscript;
    this._readPlan = deps.readPlan ?? defaultReadPlan;
    this._readVerdict = deps.readVerdict ?? defaultReadVerdict;
    this._readUsage = deps.readUsage ?? readSessionUsage;
    this._makeTmpDir = deps.makeTmpDir ?? defaultMakeTmpDir;
    this._cleanup = deps.cleanup ?? defaultCleanup;
  }

  // ── resolveTerminal ──────────────────────────────────────────────────────────

  /** Find a recap spawn's live terminal by its tmpdir cwd. "" when gone; herdr.stop("") is a no-op. */
  private resolveTerminal(cwd: string): string {
    return this.deps.herdr.list().find((a) => a.cwd === cwd)?.terminalId ?? "";
  }

  // ── reapGenerating ───────────────────────────────────────────────────────────

  /** Reap any existing generating row for this session (stop pane + cleanup dir + drop row). */
  private reapGenerating(sessionId: string): void {
    const existing = this.deps.store.getRecap(sessionId);
    if (!existing || existing.state !== "generating") return;
    try {
      this.deps.herdr.stop(this.resolveTerminal(existing.cwd));
    } catch {
      /* best-effort */
    }
    this._cleanup(existing.cwd);
    this.deps.store.dropRecap(sessionId);
  }

  // ── sweep ────────────────────────────────────────────────────────────────────

  /**
   * Periodic auto-fire. For each active session, debounce the settled-idle window
   * then generate a recap once per idle episode (head-keyed).
   */
  async sweep(): Promise<void> {
    const sessions = this.deps.store.list({ activeOnly: true });
    const t = this.now();

    for (const s of sessions) {
      const settled = s.status === "idle" || s.status === "done";

      if (!settled) {
        // Re-activating: clear debounce so a later settle re-evaluates cleanly.
        this.debounce.delete(s.id);
        continue;
      }

      // Settled:
      const entry = this.debounce.get(s.id);
      if (!entry) {
        this.debounce.set(s.id, { stamp: t, fired: false });
        continue;
      }

      if (entry.fired) continue; // already triggered this episode

      const idleMs = t - entry.stamp;
      if (!isSettledIdle(s.status, idleMs, this.idleThresholdMs)) continue;

      // Eligibility: mark fired NOW (prevents repeated rev-parse until re-activity).
      entry.fired = true;

      // Skip drain sessions and sessions without a branch.
      if (s.auto || !s.branch) continue;

      let head: string;
      try {
        head = await this._headSha(s.worktreePath);
      } catch {
        continue; // git unavailable; retry next sweep
      }

      if (!needsRecap(this.deps.store.getRecap(s.id), head)) continue;

      await this.generate(s, head);
    }
  }

  // ── generate ─────────────────────────────────────────────────────────────────

  /**
   * Spawn a recap agent for `session`. Shared by sweep (auto) and regenerate (on-demand).
   *
   * Returns:
   *   "empty"   — diff had no files; an empty row is written and onChange is fired.
   *   "started" — spawn launched; a generating row is written.
   *   "error"   — herdr.start failed; tmpdir is cleaned, no row is left so a later
   *               auto-settle can retry. Does NOT throw.
   *
   * A synchronous in-flight guard prevents double-spawn if regenerate races sweep.
   */
  async generate(session: Session, knownHead?: string): Promise<"started" | "empty" | "error"> {
    const { id, worktreePath, baseBranch, branch, claudeSessionId } = session;

    // Synchronous guard: if already mid-flight for this session, bail immediately.
    if (this.inFlight.has(id)) return "started";
    this.inFlight.add(id);

    try {
      // Reap any in-flight row for this session first (prevents stale generating rows).
      this.reapGenerating(id);

      const head = knownHead ?? (await this._headSha(worktreePath));

      const diff = await this._computeDiff(worktreePath, baseBranch, branch);
      if (diff.files.length === 0) {
        const t = this.now();
        this.deps.store.putRecap({
          sessionId: id,
          state: "empty",
          headSha: head,
          verdict: null,
          headline: "",
          body: "",
          openItems: [],
          spawnSessionId: "",
          cwd: "",
          model: this.model,
          spawnedAt: t,
          generatedAt: t,
          updatedAt: t,
        });
        this.deps.onChange(id, null);
        return "empty";
      }

      // Build prompt inputs.
      const transcript = this._readTranscript(worktreePath, claudeSessionId);
      const digest = buildTranscriptDigest(transcript);
      const plan = this._readPlan(worktreePath);
      const changedFiles = diff.files.map((f) => f.path);

      const contextParts: string[] = [];
      const review = this.deps.store.getReview(id);
      if (review?.summary) contextParts.push(`Critic verdict: ${review.summary}`);
      if (session.readyToMerge) contextParts.push("Operator marked ready to merge.");
      if (session.planPhase) contextParts.push(`Plan phase: ${session.planPhase}`);
      const context = contextParts.join("\n");

      const prompt = buildRecapPrompt({
        taskPrompt: session.prompt,
        plan,
        changedFiles,
        digest,
        context,
      });
      const { argv, sessionId: spawnSessionId } = recapArgv(this.model, prompt);

      // Spawn.
      const cwd = this._makeTmpDir();
      try {
        this.deps.herdr.start(`recap ${session.desig}`, cwd, argv);
      } catch {
        this._cleanup(cwd);
        return "error"; // spawn failed; no row left so next settle can retry
      }

      const spawnedAt = this.now();

      this.deps.store.recordReviewerSpawn({
        reviewerSessionId: spawnSessionId,
        taskSessionId: id,
        kind: "recap",
        worktreePath: cwd,
        model: this.model,
        spawnedAt,
      });

      const row: Recap = {
        sessionId: id,
        state: "generating",
        headSha: head,
        verdict: null,
        headline: "",
        body: "",
        openItems: [],
        spawnSessionId,
        cwd,
        model: this.model,
        spawnedAt,
        generatedAt: null,
        updatedAt: spawnedAt,
      };
      this.deps.store.putRecap(row);
      this.deps.onChange(id, row);

      return "started";
    } finally {
      this.inFlight.delete(id);
    }
  }

  // ── tick ─────────────────────────────────────────────────────────────────────

  /**
   * Finalize any generating recap whose verdict file is ready or that has timed out.
   * Restart-safe: reads from the DB, not memory.
   */
  async tick(): Promise<void> {
    for (const r of this.deps.store.generatingRecaps()) {
      if (this.finalizing.has(r.sessionId)) continue;

      const raw = this._readVerdict(r.cwd);
      const timedOut = this.now() - r.spawnedAt > this.timeoutMs;
      if (!raw && !timedOut) continue;

      this.finalizing.add(r.sessionId);
      try {
        await this.finalize(r, raw);
      } finally {
        this.finalizing.delete(r.sessionId);
      }
    }
  }

  private async finalize(r: Recap, raw: unknown | null): Promise<void> {
    const t = this.now();
    let newRow: Recap;
    try {
      const parsed = raw ? parseRecapVerdict(raw) : null;
      if (parsed) {
        newRow = {
          ...r,
          state: "ready",
          verdict: parsed.verdict,
          headline: parsed.headline,
          body: parsed.body,
          openItems: parsed.openItems,
          generatedAt: t,
          updatedAt: t,
        };
      } else {
        // timeout or unparseable — fail closed, never fake a ready
        newRow = { ...r, state: "failed", generatedAt: t, updatedAt: t };
      }
      this.deps.store.putRecap(newRow);
      this.deps.onChange(r.sessionId, newRow);

      // Best-effort usage capture.
      try {
        const u = await this._readUsage(r.cwd, r.spawnSessionId);
        if (u) this.deps.store.completeReviewerSpawn(r.spawnSessionId, u, t);
      } catch (err) {
        console.warn(`[recap] usage capture failed for ${r.sessionId}:`, err);
      }
    } finally {
      // Always reap pane + tmpdir.
      try {
        this.deps.herdr.stop(this.resolveTerminal(r.cwd));
      } catch {
        /* best-effort */
      }
      this._cleanup(r.cwd);
    }
  }

  // ── regenerate ───────────────────────────────────────────────────────────────

  /**
   * Force a fresh recap for ANY session, regardless of existing row / debounce / drain.
   * Returns "empty" | "started" | "error".
   */
  async regenerate(session: Session): Promise<"started" | "empty" | "error"> {
    // Clear debounce so next sweep re-evaluates cleanly.
    this.debounce.delete(session.id);
    return this.generate(session);
  }

  // ── snapshot ─────────────────────────────────────────────────────────────────

  snapshot(): Record<string, Recap> {
    return this.deps.store.snapshotRecaps();
  }

  // ── forget ───────────────────────────────────────────────────────────────────

  /** On session archive: reap any in-flight generating row, then drop the recap row. */
  forget(sessionId: string): void {
    this.reapGenerating(sessionId);
    this.debounce.delete(sessionId);
    this.deps.store.dropRecap(sessionId);
  }
}
