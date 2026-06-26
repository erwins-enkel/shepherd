/**
 * RecapService — auto-generates a one-time, head-keyed session recap via a transient
 * Sonnet spawn. Mirrors ReviewService/PlanGateService structure:
 *   sweep()      — periodic auto-fire (settled-idle debounce, head-keyed dedupe)
 *   tick()       — finalize in-flight recaps (restart-safe, reads from DB)
 *   generate()   — shared spawn path (auto + on-demand)
 *   regenerate() — on-demand force (bypasses scope/debounce/dedupe)
 *   snapshot()   — snapshot for client bootstrap
 *
 * Spawn pattern mirrors src/namer-llm.ts: tmpdir cwd, Write-only, dontAsk,
 * disableAllHooks, disable-slash-commands. No worktree, no membrane.
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTransientAgentArgv } from "./transient-agent-argv";
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
import { isApiKeyMode, isApiKeyConfigured, apiKeyPassthroughEnv } from "./spawn-auth";
import {
  parseRecapVerdict,
  buildTranscriptDigest,
  buildRecapPrompt,
  isSettledIdle,
  needsRecap,
} from "./recap-core";
import { groundBlocks, type VisualBlock } from "./visual-blocks";
import { tolerantParseJson, isSpawnWorking, decideVerdictAction } from "./json-tolerant";
import type { VerdictRead } from "./json-tolerant";

const execFileAsync = promisify(execFile);

/** The file the recap agent writes its JSON verdict to, in its temp cwd. */
const RECAP_VERDICT_FILE = ".shepherd-recap.json";

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

/**
 * Read the recap verdict file as a 3-way result. `absent` (not yet written) is distinct from
 * `unparseable` (present but unrecoverable even after repair) so tick() can fail fast on the latter
 * without waiting out the timeout. A repaired parse carries `repaired: true` so it is trusted only
 * once the spawn has finished (see RecapService.tick). Exported for the read-path regression test.
 */
export function defaultReadVerdict(cwd: string): VerdictRead<unknown> {
  const p = join(cwd, RECAP_VERDICT_FILE);
  if (!existsSync(p)) return { status: "absent" };
  let text: string;
  try {
    text = readFileSync(p, "utf8");
  } catch {
    return { status: "absent" }; // unreadable mid-write — treat as not-yet-written, retry next tick
  }
  const r = tolerantParseJson(text);
  return r.status === "ok"
    ? { status: "parsed", value: r.value, repaired: r.repaired }
    : { status: "unparseable", raw: text }; // carry bytes so tick() can log WHY it failed
}

/** Bounded, single-line snippet of a raw verdict for diagnostic logs (recap content is agent
 *  summaries, redacted by prompt — never secrets). Keeps server logs grep-able without dumping 20KB. */
function recapSnippet(s: string | undefined, max = 300): string {
  if (!s) return "<empty>";
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
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

/** The recap spawn's argv — the shared `writer-only` transient-agent shape (model defaults to
 *  "sonnet" at the call site). The input is the session transcript (UNTRUSTED); bare `Write` is safe
 *  via the sandbox shape, not an input-trust claim. See buildTransientAgentArgv for the rationale. */
function recapArgv(model: string | null, prompt: string): { argv: string[]; sessionId: string } {
  return buildTransientAgentArgv("writer-only", { model, prompt });
}

// ── deps interface ────────────────────────────────────────────────────────────

export interface RecapServiceDeps {
  store: Pick<
    SessionStore,
    | "get"
    | "getRecap"
    | "putRecap"
    | "snapshotRecaps"
    | "generatingRecaps"
    | "dropRecap"
    | "getReview"
    | "recordReviewerSpawn"
    | "completeReviewerSpawn"
    | "list"
    | "setRecapPendingDiff"
  >;
  herdr: Pick<HerdrDriver, "start" | "stop" | "list">;
  onChange: (id: string, recap: Recap | null) => void;
  model?: string | null;
  now?: () => number;
  timeoutMs?: number;
  idleThresholdMs?: number;
  // injectables:
  /** Resolve the base branch to diff against (the PR's real base when resolvable) plus whether
   *  that resolution was authoritative. Default: the session's stored baseBranch (non-authoritative). */
  resolveBase?: (session: Session) => Promise<{ base: string; resolved: boolean }>;
  computeDiff?: (worktreePath: string, base: string, branch: string | null) => Promise<DiffResult>;
  headSha?: (worktreePath: string) => Promise<string>;
  readTranscript?: (worktreePath: string, claudeSessionId: string) => ActivityEntry[];
  readPlan?: (worktreePath: string) => string;
  readVerdict?: (cwd: string) => VerdictRead<unknown>;
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

  private _resolveBase: (session: Session) => Promise<{ base: string; resolved: boolean }>;
  private _computeDiff: (
    worktreePath: string,
    base: string,
    branch: string | null,
  ) => Promise<DiffResult>;
  private _headSha: (worktreePath: string) => Promise<string>;
  private _readTranscript: (worktreePath: string, claudeSessionId: string) => ActivityEntry[];
  private _readPlan: (worktreePath: string) => string;
  private _readVerdict: (cwd: string) => VerdictRead<unknown>;
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
    this._resolveBase =
      deps.resolveBase ?? ((s) => Promise.resolve({ base: s.baseBranch, resolved: false }));
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

  /**
   * Has the recap spawn at `cwd` finished producing output? True when its herdr agent is gone or no
   * longer "working" — used to gate acting on a repaired/unparseable verdict (don't trust/fail on a
   * file that may still be mid-write). See isSpawnWorking for the residual-flicker race; the hard
   * timeout in tick() is the true backstop.
   */
  private spawnFinished(cwd: string): boolean {
    return !isSpawnWorking(this.deps.herdr.list(), cwd);
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
   * Per-session debounce + eligibility decision. Called by sweep() for each settled session.
   */
  private async considerSession(s: Session, now: number): Promise<void> {
    const entry = this.debounce.get(s.id);
    if (!entry) {
      this.debounce.set(s.id, { stamp: now, fired: false });
      return;
    }

    if (entry.fired) return; // already triggered this episode

    const idleMs = now - entry.stamp;
    if (!isSettledIdle(s.status, idleMs, this.idleThresholdMs)) return;

    // Skip drain sessions and sessions without a branch — stable for the episode, so
    // burn the marker (no point re-checking until the session re-activates).
    if (s.auto || !s.branch) {
      entry.fired = true;
      return;
    }

    let head: string;
    try {
      head = await this._headSha(s.worktreePath);
    } catch {
      return; // git unavailable; leave fired=false so the next sweep retries
    }

    // rev-parse succeeded → mark fired so we don't re-rev-parse until re-activity.
    entry.fired = true;

    const { base, resolved } = await this._resolveBase(s);
    if (!needsRecap(this.deps.store.getRecap(s.id), head, base, resolved)) return;

    await this.generate(s, head, base);
  }

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

      await this.considerSession(s, t);
    }
  }

  // ── considerForArchive ─────────────────────────────────────────────────────────

  /**
   * Archive-hook entry point. Unlike sweep()/considerSession, this fires for EVERY
   * finishing session — including `auto`/drain — with NO debounce and NO auto-skip,
   * so every session gets a durable recap row for the Done lens (the live-sweep's
   * skip of `auto` sessions would otherwise starve drained sessions of a recap).
   *
   * `(head, base)`-keyed dedup (see {@link needsRecap}): if a recap already exists for the
   * current HEAD *and* the same base we return "skip" (the common case — the live sweep usually
   * already generated one), so we never double-spawn. A recap baked against a stale base before
   * the PR's real base was resolvable regenerates here once that base becomes known. Otherwise we
   * generate synchronously.
   *
   * Does NOT throw: a git/worktree-unavailable rev-parse failure self-heals to "error"
   * rather than throwing out of the archive hook.
   */
  async considerForArchive(session: Session): Promise<"started" | "empty" | "error" | "skip"> {
    let head: string;
    try {
      head = await this._headSha(session.worktreePath);
    } catch {
      return "error"; // git/worktree unavailable — don't throw out of the hook
    }

    const { base, resolved } = await this._resolveBase(session);
    if (!needsRecap(this.deps.store.getRecap(session.id), head, base, resolved)) return "skip";

    return await this.generate(session, head, base);
  }

  // ── onArchived ─────────────────────────────────────────────────────────────────

  /**
   * Slim archive cleanup: frees ONLY the per-session debounce entry. Without this the
   * `debounce` Map would leak entries for archived sessions (they never re-enter the
   * sweep's active-session list to be cleared).
   *
   * Deliberately does NOT reapGenerating — an in-flight spawn must be allowed to finish
   * (it's worktree-independent once launched, and tick() finalizes it post-archive) —
   * and does NOT dropRecap — the row must persist for the Done lens.
   */
  onArchived(sessionId: string): void {
    this.debounce.delete(sessionId);
  }

  // ── generate ─────────────────────────────────────────────────────────────────

  /**
   * Spawn a recap agent for `session`. Shared by sweep (auto) and regenerate (on-demand).
   *
   * Returns:
   *   "empty"   — diff had no files; an empty row is written and onChange is fired.
   *   "started" — spawn launched; a generating row is written.
   *   "error"   — git (rev-parse/diff) failed, or herdr.start failed; any tmpdir is
   *               cleaned and no row is left so a later auto-settle can retry.
   *
   * Does NOT throw — git/diff rejections are caught and surface as "error" — so callers
   * (incl. the bare-`void` sweep loop) need not guard it.
   * A synchronous in-flight guard prevents double-spawn if regenerate races sweep.
   */
  async generate(
    session: Session,
    knownHead?: string,
    knownBase?: string,
  ): Promise<"started" | "empty" | "error"> {
    // Fail closed: api-key mode without a configured key must NOT bill the subscription.
    if (isApiKeyMode() && !isApiKeyConfigured()) {
      console.warn(
        "[recap] api-key mode enabled but no API key configured — skipping (fail closed, not billing subscription)",
      );
      return "error";
    }
    const { id, worktreePath, branch, claudeSessionId } = session;

    // Synchronous guard: if already mid-flight for this session, bail immediately.
    if (this.inFlight.has(id)) return "started";
    this.inFlight.add(id);

    try {
      // Reap any in-flight row for this session first (prevents stale generating rows).
      this.reapGenerating(id);

      // Resolve HEAD + base + diff up front; a git/diff rejection self-heals to "error"
      // (no row left) rather than throwing out of this bare-`void`-called method.
      // Resolving the base HERE (not just in the dedup callers) covers regenerate(),
      // which bypasses dedup — so a forced regenerate never re-bakes the stored base.
      let head: string;
      let base: string;
      let diff: DiffResult;
      try {
        head = knownHead ?? (await this._headSha(worktreePath));
        base = knownBase ?? (await this._resolveBase(session)).base;
        diff = await this._computeDiff(worktreePath, base, branch);
      } catch {
        return "error";
      }

      if (diff.files.length === 0) {
        const t = this.now();
        this.deps.store.putRecap({
          sessionId: id,
          state: "empty",
          headSha: head,
          base,
          verdict: null,
          headline: "",
          body: "",
          openItems: [],
          changedFiles: [],
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
      const changedFilesWithStatus = diff.files.map((f) => ({ path: f.path, status: f.status }));

      const contextParts: string[] = [];
      const review = this.deps.store.getReview(id);
      if (review?.summary) contextParts.push(`Critic verdict: ${review.summary}`);
      if (session.readyToMerge) contextParts.push("Operator marked ready to merge.");
      if (session.planPhase) contextParts.push(`Plan phase: ${session.planPhase}`);
      // #1059: hint the prose about detected manual operator steps (the authoritative copy is the
      // deterministic checklist block injected at finalize; this just lets the body reference them).
      if (session.manualSteps.length > 0)
        contextParts.push(
          `Manual operator steps required (surfaced as a checklist): ${session.manualSteps
            .map((s) => (s.postMerge ? `POST-MERGE: ${s.text}` : s.text))
            .join("; ")}`,
        );
      const context = contextParts.join("\n");

      const prompt = buildRecapPrompt({
        taskPrompt: session.prompt,
        plan,
        changedFiles: changedFilesWithStatus,
        digest,
        context,
      });
      const { argv, sessionId: spawnSessionId } = recapArgv(this.model, prompt);

      // Spawn.
      const cwd = this._makeTmpDir();
      try {
        this.deps.herdr.start(`recap ${session.desig}`, cwd, argv, apiKeyPassthroughEnv(false));
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
        base,
        verdict: null,
        headline: "",
        body: "",
        openItems: [],
        changedFiles,
        spawnSessionId,
        cwd,
        model: this.model,
        spawnedAt,
        generatedAt: null,
        updatedAt: spawnedAt,
      };
      this.deps.store.putRecap(row);
      this.deps.onChange(id, row);
      this.deps.store.setRecapPendingDiff(id, diff.files);

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

      const read = this._readVerdict(r.cwd);
      const timedOut = this.now() - r.spawnedAt > this.timeoutMs;
      const action = decideVerdictAction(read, this.spawnFinished(r.cwd), timedOut);
      if (action === "wait") continue; // not-yet-written / repaired-or-unparseable while still working
      // finalize-value carries the parsed verdict; finalize-null (timeout / fail-fast) → `failed`.
      const raw = action === "finalize-value" && read.status === "parsed" ? read.value : null;

      // Observability: a `failed` recap used to be a black hole (no log, raw discarded), so an
      // intermittent malformed write was undiagnosable. Surface WHY before finalizing.
      if (action === "finalize-null") {
        if (read.status === "unparseable") {
          console.warn(
            `[recap] ${r.sessionId}: verdict file present but unparseable even after jsonrepair — failing. snippet: ${recapSnippet(read.raw)}`,
          );
        } else {
          console.warn(
            `[recap] ${r.sessionId}: no verdict file after ${Math.round(this.timeoutMs / 1000)}s — agent produced nothing.`,
          );
        }
      }

      this.finalizing.add(r.sessionId);
      try {
        await this.finalize(r, raw);
      } finally {
        this.finalizing.delete(r.sessionId);
      }
    }
  }

  /** Build a deterministic checklist block from a session's persisted manual operator steps
   *  (#1059), or null when there are none. Read at finalize (latest possible point) so a
   *  detection write racing in around merge time is most likely to have landed. */
  private buildManualStepsBlock(sessionId: string): VisualBlock | null {
    const steps = this.deps.store.get(sessionId)?.manualSteps ?? [];
    if (steps.length === 0) return null;
    return {
      type: "checklist",
      id: "manual-steps",
      items: steps.map((s) => ({
        id: s.id,
        label: s.text,
        ...(s.postMerge ? { note: "POST-MERGE" } : {}),
      })),
    };
  }

  private async finalize(r: Recap, raw: unknown | null): Promise<void> {
    const t = this.now();
    // Strip the server-only carrier so it never reaches putRecap or onChange.
    const { pendingDiff = [], ...rBase } = r;
    // Manual operator steps (#1059): deterministically carry the session's persisted manual steps
    // into the recap as a checklist block, so the durability win never depends on the LLM choosing
    // to emit it. Prepended in BOTH branches below — the failure branch must keep it too, since a
    // recap failure is exactly the case where these otherwise-lost steps matter most.
    const manualBlock = this.buildManualStepsBlock(r.sessionId);
    let newRow: Recap;
    try {
      const parsed = raw ? parseRecapVerdict(raw) : null;
      if (parsed) {
        const grounded = groundBlocks(parsed.blocks, pendingDiff, rBase.changedFiles);
        newRow = {
          ...rBase,
          state: "ready",
          verdict: parsed.verdict,
          headline: parsed.headline,
          body: parsed.body,
          openItems: parsed.openItems,
          blocks: manualBlock ? [manualBlock, ...grounded] : grounded,
          generatedAt: t,
          updatedAt: t,
        };
      } else {
        // timeout or unparseable — fail closed, never fake a ready. When raw was non-null the JSON
        // parsed but failed recap-shape validation (bad verdict, unrecoverable structure); log it
        // so the otherwise-silent failure is diagnosable (tick() already logged the raw==null cases).
        if (raw != null) {
          const v = (raw as { verdict?: unknown })?.verdict;
          console.warn(
            `[recap] ${r.sessionId}: verdict parsed as JSON but failed recap-shape validation (verdict=${JSON.stringify(v)}) — failing. snippet: ${recapSnippet(JSON.stringify(raw))}`,
          );
        }
        newRow = {
          ...rBase,
          state: "failed",
          blocks: manualBlock ? [manualBlock] : [],
          generatedAt: t,
          updatedAt: t,
        };
      }
      this.deps.store.putRecap(newRow);
      this.deps.onChange(r.sessionId, newRow);
      this.deps.store.setRecapPendingDiff(r.sessionId, []);

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
}
