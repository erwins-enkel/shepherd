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
import type {
  Session,
  Recap,
  AgentProvider,
  RecapEvidenceKind,
  RecapSkip,
  RecapFailure,
  RecapFailureCode,
  RecapDiffState,
} from "./types";
import type { DiffFile, DiffResult } from "./types";
import type { RoleEnvironment } from "./default-model";
import type { OperatorLanguage } from "./operator-language";
import type { ActivityEntry } from "./activity";
import type { SessionUsage } from "./usage";
import { readSessionUsage } from "./usage";
import { computeDiff } from "./diff";
import { parseActivity, readTranscriptTail } from "./activity";
import { jsonlPathFor } from "./usage";
import { apiKeyFailClosed, apiKeyPassthroughEnv } from "./spawn-auth";
import {
  parseRecapVerdict,
  buildTranscriptDigest,
  buildRecapPrompt,
  isSettledIdle,
  needsRecap,
} from "./recap-core";
import { groundBlocks, type VisualBlock } from "./visual-blocks";
import {
  tolerantParseJson,
  isSpawnAlive,
  decideVerdictAction,
  STARTUP_GRACE_MS,
} from "./json-tolerant";
import type { VerdictAction, VerdictRead } from "./json-tolerant";

const execFileAsync = promisify(execFile);

/** The file the recap agent writes its JSON verdict to, in its temp cwd. */
const RECAP_VERDICT_FILE = ".shepherd-recap.json";

/** Plan file the agent writes in its LIVE session worktree. */
const PLAN_FILE = ".shepherd-plan.md";

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_IDLE_THRESHOLD_MS = 120_000;

type AncestryResult = "contained" | "not-contained" | "unknown";

export interface LandedWorkEvidence {
  kind: RecapEvidenceKind; // "merged_pr" | "review" | "existing_recap"
  summary: string;
  /** PR number for `merged_pr` evidence, when known — carried into a recap-skip's localized body as
   *  a typed param (never the English `summary` string). Absent → the UI renders "merged PR" w/o #N. */
  pr?: number;
}

type EmptyDiffAction =
  | { kind: "continue"; landedContext: string; diffState: "none" | "landed" }
  | { kind: "done"; result: "error" };

// ── defaults ──────────────────────────────────────────────────────────────────

function optional<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}

async function defaultHeadSha(worktreePath: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: worktreePath,
    encoding: "utf8",
  });
  return stdout.trim();
}

async function defaultCurrentBranch(worktreePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
      cwd: worktreePath,
      encoding: "utf8",
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function defaultHeadContainedInBase(
  worktreePath: string,
  baseRef: string,
): Promise<AncestryResult> {
  try {
    await execFileAsync("git", ["merge-base", "--is-ancestor", "HEAD", baseRef], {
      cwd: worktreePath,
      encoding: "utf8",
    });
    return "contained";
  } catch (err) {
    return (err as { code?: unknown }).code === 1 ? "not-contained" : "unknown";
  }
}

function defaultReadTranscript(
  worktreePath: string,
  claudeSessionId: string,
  spawnAccountDir?: string | null,
): ActivityEntry[] {
  const path = jsonlPathFor(worktreePath, claudeSessionId, spawnAccountDir);
  try {
    const text = readTranscriptTail(path);
    return parseActivity(text, -1); // -1 = all entries
  } catch {
    return [];
  }
}

/** Reduce landed-work evidence to the typed skip params the UI localizes (kind + optional PR
 *  number) — never the authored English `summary` string, which would embed English in a DE body. */
function evidenceParams(evidence: LandedWorkEvidence): {
  evidenceKind: RecapEvidenceKind;
  evidencePr?: number;
} {
  return {
    evidenceKind: evidence.kind,
    ...(evidence.pr != null ? { evidencePr: evidence.pr } : {}),
  };
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

/**
 * Recap's diff visual block renders via `hunks`, never the raw `patch` text (that's the
 * session-endpoint-only wire shape — see toSessionDiff in diff.ts). Strip it before the
 * files land in the pendingDiff carrier so a stored/reconstructed recap block never ships
 * both representations.
 */
export function stripPatchForRecap(files: DiffFile[]): DiffFile[] {
  return files.map(({ patch, ...f }) => {
    void patch; // intentionally dropped — recap keeps `hunks` only
    return f as DiffFile;
  });
}

/** Bounded, single-line snippet of a raw verdict for diagnostic logs (recap content is agent
 *  summaries, redacted by prompt — never secrets). Keeps server logs grep-able without dumping 20KB. */
function recapSnippet(s: string | undefined, max = 300): string {
  if (!s) return "<empty>";
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** Collapse and redact a bounded technical detail before it reaches persistence or the UI. */
export function sanitizeRecapFailureDetail(value: unknown): string | undefined {
  const raw =
    value instanceof Error
      ? value.message
      : typeof value === "string"
        ? value
        : String(value ?? "");
  const detail = raw
    .replace(
      /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/g,
      "$1$2<redacted>",
    )
    .replace(
      /\b(authorization|api[_ -]?key|token|password)(\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi,
      "$1$2<redacted>",
    )
    .replace(/\bbearer\s+[^\s,;]+/gi, "Bearer <redacted>")
    .replace(/\b(?:sk|gh[pousr]|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/gi, "<redacted>")
    .replace(/:\/\/([^\s/:@]+):([^\s/@]+)@/g, "://$1:<redacted>@")
    .replace(/\s+/g, " ")
    .trim();
  if (!detail) return undefined;
  return detail.length > 300 ? `${detail.slice(0, 299)}…` : detail;
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
function recapArgv(
  provider: AgentProvider,
  model: string | null,
  prompt: string,
  effort?: string | null,
): { argv: string[]; sessionId: string } {
  return buildTransientAgentArgv("writer-only", { provider, model, effort, prompt });
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
    | "listReviewerSpawns"
    | "list"
    | "setRecapPendingDiff"
  >;
  herdr: Pick<HerdrDriver, "start" | "stop" | "list" | "paneForegroundProcs" | "readAsync">;
  onChange: (id: string, recap: Recap | null) => void;
  // optional environment thunk (CLI + model, read per spawn → live settings)
  env?: () => RoleEnvironment;
  // optional operator-language thunk (read per spawn → live settings; default "en")
  operatorLanguage?: () => OperatorLanguage;
  now?: () => number;
  timeoutMs?: number;
  idleThresholdMs?: number;
  // injectables:
  /** Resolve the base branch to diff against (the PR's real base when resolvable) plus whether
   *  that resolution was authoritative. Default: the session's stored baseBranch (non-authoritative). */
  resolveBase?: (session: Session) => Promise<{ base: string; resolved: boolean }>;
  computeDiff?: (worktreePath: string, base: string, branch: string | null) => Promise<DiffResult>;
  headSha?: (worktreePath: string) => Promise<string>;
  readTranscript?: (
    worktreePath: string,
    claudeSessionId: string,
    spawnAccountDir?: string | null,
  ) => ActivityEntry[];
  readPlan?: (worktreePath: string) => string;
  readVerdict?: (cwd: string) => VerdictRead<unknown>;
  readUsage?: (cwd: string, spawnSessionId: string) => Promise<SessionUsage | null>;
  currentBranch?: (worktreePath: string) => Promise<string | null>;
  headContainedInBase?: (worktreePath: string, baseRef: string) => Promise<AncestryResult>;
  landedWorkEvidence?: (
    session: Session,
    headSha: string,
  ) => Promise<LandedWorkEvidence | null> | LandedWorkEvidence | null;
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
  private env: () => RoleEnvironment;
  private operatorLanguage: () => OperatorLanguage;

  private _resolveBase: (session: Session) => Promise<{ base: string; resolved: boolean }>;
  private _computeDiff: (
    worktreePath: string,
    base: string,
    branch: string | null,
  ) => Promise<DiffResult>;
  private _headSha: (worktreePath: string) => Promise<string>;
  private _readTranscript: (
    worktreePath: string,
    claudeSessionId: string,
    spawnAccountDir?: string | null,
  ) => ActivityEntry[];
  private _readPlan: (worktreePath: string) => string;
  private _readVerdict: (cwd: string) => VerdictRead<unknown>;
  private _readUsage: (cwd: string, spawnSessionId: string) => Promise<SessionUsage | null>;
  private _currentBranch: (worktreePath: string) => Promise<string | null>;
  private _headContainedInBase: (worktreePath: string, baseRef: string) => Promise<AncestryResult>;
  private _landedWorkEvidence: (
    session: Session,
    headSha: string,
  ) => Promise<LandedWorkEvidence | null> | LandedWorkEvidence | null;
  private _makeTmpDir: () => string;
  private _cleanup: (cwd: string) => void;

  /** Per-session settled-idle debounce: stamp + fired-this-episode flag. */
  private debounce = new Map<string, DebounceEntry>();

  /** Guards against a session being finalized twice across overlapping ticks. */
  private finalizing = new Set<string>();

  /** Guards against double-spawn when regenerate races a mid-flight sweep. */
  private inFlight = new Set<string>();

  constructor(private deps: RecapServiceDeps) {
    this.now = optional(deps.now, Date.now);
    this.timeoutMs = optional(deps.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.idleThresholdMs = optional(deps.idleThresholdMs, DEFAULT_IDLE_THRESHOLD_MS);
    // No service-internal model default — the sonnet default now lives in config.recapModel seeding
    // (config.recapCli="claude"), resolved by roleEnv at the call site in index.ts.
    this.env = optional(deps.env, () => ({ provider: "claude", model: null }));
    this.operatorLanguage = optional(deps.operatorLanguage, () => "en");
    this._resolveBase = optional(deps.resolveBase, (s) =>
      Promise.resolve({ base: s.baseBranch, resolved: false }),
    );
    this._computeDiff = optional(deps.computeDiff, computeDiff);
    this._headSha = optional(deps.headSha, defaultHeadSha);
    this._readTranscript = optional(deps.readTranscript, defaultReadTranscript);
    this._readPlan = optional(deps.readPlan, defaultReadPlan);
    this._readVerdict = optional(deps.readVerdict, defaultReadVerdict);
    this._readUsage = optional(deps.readUsage, readSessionUsage);
    this._currentBranch = optional(deps.currentBranch, defaultCurrentBranch);
    this._headContainedInBase = optional(deps.headContainedInBase, defaultHeadContainedInBase);
    this._landedWorkEvidence = optional(deps.landedWorkEvidence, () => null);
    this._makeTmpDir = optional(deps.makeTmpDir, defaultMakeTmpDir);
    this._cleanup = optional(deps.cleanup, defaultCleanup);
  }

  // ── resolveTerminal ──────────────────────────────────────────────────────────

  /** Find a recap spawn's live terminal by its tmpdir cwd. "" when gone; herdr.stop("") is a no-op. */
  private resolveTerminal(cwd: string): string {
    return this.deps.herdr.list().find((a) => a.cwd === cwd)?.terminalId ?? "";
  }

  private putTerminalRecap(
    session: Session,
    input: {
      state: "empty" | "failed";
      headSha: string;
      base: string;
      skip?: RecapSkip;
      failure?: RecapFailure;
    },
  ): void {
    const t = this.now();
    const env = this.env();
    const row: Recap = {
      sessionId: session.id,
      state: input.state,
      headSha: input.headSha,
      base: input.base,
      verdict: null,
      // A coded skip leaves headline/body empty — the UI renders both per-locale from `skip`.
      headline: "",
      body: "",
      skip: input.skip ?? null,
      failure: input.failure ?? null,
      openItems: [],
      changedFiles: [],
      blocks: [],
      spawnSessionId: "",
      cwd: "",
      model: input.failure?.model ?? env.model,
      spawnedAt: t,
      generatedAt: t,
      updatedAt: t,
    };
    this.deps.store.putRecap(row);
    this.deps.onChange(session.id, row);
  }

  private failureFor(
    recap: Pick<Recap, "spawnSessionId" | "model">,
    code: RecapFailureCode,
    detail?: unknown,
  ): RecapFailure {
    const spawn = this.deps.store
      .listReviewerSpawns()
      .find((s) => s.reviewerSessionId === recap.spawnSessionId);
    const provider =
      spawn?.reviewerProvider === "claude" || spawn?.reviewerProvider === "codex"
        ? spawn.reviewerProvider
        : this.env().provider;
    const safeDetail = sanitizeRecapFailureDetail(detail);
    return {
      code,
      provider,
      model: recap.model ?? null,
      ...(safeDetail ? { detail: safeDetail } : {}),
    };
  }

  private putFailureRecap(
    session: Session,
    code: RecapFailureCode,
    detail?: unknown,
    headSha = "",
    base = "",
  ): void {
    const env = this.env();
    const safeDetail = sanitizeRecapFailureDetail(detail);
    this.putTerminalRecap(session, {
      state: "failed",
      headSha,
      base,
      failure: {
        code,
        provider: env.provider,
        model: env.model,
        ...(safeDetail ? { detail: safeDetail } : {}),
      },
    });
  }

  private async resolveGenerateSource(
    session: Session,
    knownHead?: string,
    knownBase?: string,
  ): Promise<{ head: string; base: string; diff: DiffResult }> {
    const head = knownHead || (await this._headSha(session.worktreePath));
    const base = knownBase || (await this._resolveBase(session)).base;
    const diff = await this._computeDiff(session.worktreePath, base, session.branch);
    return { head, base, diff };
  }

  private async classifyEmptyDiff(
    session: Session,
    head: string,
    diff: DiffResult,
  ): Promise<
    | { kind: "empty" }
    | { kind: "landed"; evidence: LandedWorkEvidence }
    | { kind: "failed"; skip: RecapSkip }
  > {
    if (!session.isolated || !session.branch) return { kind: "empty" };

    const current = await this._currentBranch(session.worktreePath);
    if (current && current !== session.branch) {
      return {
        kind: "failed",
        skip: {
          code: "metadata-mismatch",
          params: { branch: session.branch, current },
        },
      };
    }

    const evidence = await this._landedWorkEvidence(session, head);
    if (!evidence) return { kind: "empty" };

    if (diff.fetchFailed) {
      return {
        kind: "failed",
        skip: { code: "base-refresh-failed", params: evidenceParams(evidence) },
      };
    }

    const ancestry = await this._headContainedInBase(session.worktreePath, diff.baseRef);
    if (ancestry === "contained") return { kind: "landed", evidence };
    if (ancestry === "unknown") {
      return {
        kind: "failed",
        skip: {
          code: "ancestry-check-failed",
          params: { ...evidenceParams(evidence), baseRef: diff.baseRef },
        },
      };
    }
    return {
      kind: "failed",
      skip: {
        code: "empty-diff-contradicted",
        params: { ...evidenceParams(evidence), baseRef: diff.baseRef },
      },
    };
  }

  private async handleEmptyDiff(
    session: Session,
    head: string,
    base: string,
    diff: DiffResult,
  ): Promise<EmptyDiffAction> {
    const classified = await this.classifyEmptyDiff(session, head, diff);
    if (classified.kind === "empty") {
      return {
        kind: "continue",
        diffState: "none",
        landedContext:
          "No files were changed in this session, so no code diff exists. Summarize the task, plan, and transcript outcome, clearly state that there are no file changes, and do not invent changed files or implementation details.",
      };
    }
    if (classified.kind === "failed") {
      this.putTerminalRecap(session, {
        state: "failed",
        headSha: head,
        base,
        skip: classified.skip,
      });
      return { kind: "done", result: "error" };
    }
    return {
      kind: "continue",
      diffState: "landed",
      landedContext: `The code diff is empty because this session's HEAD is already contained in the resolved base. Landed-work evidence: ${classified.evidence.summary}. Summarize the completed work from the task, plan, review/PR context, and transcript digest; do not invent changed files.`,
    };
  }

  // ── reapGenerating ───────────────────────────────────────────────────────────

  /** Reap any existing generating row for this session (stop pane + cleanup dir + drop row). */
  private reapGenerating(sessionId: string): void {
    const existing = this.deps.store.getRecap(sessionId);
    if (!existing || existing.state !== "generating") return;
    try {
      void this.deps.herdr.stop(this.resolveTerminal(existing.cwd)).catch(() => {});
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
    } catch (err) {
      this.putFailureRecap(session, "source-unavailable", err);
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
   *   "empty"   — retained for API compatibility; new no-diff sessions now generate a recap.
   *   "started" — spawn launched; a generating row is written.
   *   "error"   — git/auth/spawn failed; a structured failed row records why.
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
    // Fail closed: in Anthropic api-key mode without a configured key, a Claude spawn must NOT bill
    // the subscription. Gated on the resolved provider — a Codex recap uses Codex's own auth.
    if (apiKeyFailClosed(this.env().provider)) {
      console.warn(
        "[recap] api-key mode enabled but no API key configured — skipping (fail closed, not billing subscription)",
      );
      this.putFailureRecap(
        session,
        "auth-unavailable",
        "API-key mode is enabled, but no API key is configured.",
      );
      return "error";
    }
    const { id, worktreePath, claudeSessionId, spawnAccountDir } = session;

    // Synchronous guard: if already mid-flight for this session, bail immediately.
    if (this.inFlight.has(id)) return "started";
    this.inFlight.add(id);

    try {
      // Reap any in-flight row for this session first (prevents stale generating rows).
      this.reapGenerating(id);

      // Resolve HEAD + base + diff up front; a rejection records a structured visible failure
      // rather than throwing out of this bare-`void`-called method.
      // Resolving the base HERE (not just in the dedup callers) covers regenerate(),
      // which bypasses dedup — so a forced regenerate never re-bakes the stored base.
      let source: { head: string; base: string; diff: DiffResult };
      try {
        source = await this.resolveGenerateSource(session, knownHead, knownBase);
      } catch (err) {
        this.putFailureRecap(session, "source-unavailable", err);
        return "error";
      }
      const { head, base, diff } = source;

      let landedContext = "";
      let diffState: RecapDiffState = "present";
      if (diff.files.length === 0) {
        const action = await this.handleEmptyDiff(session, head, base, diff);
        if (action.kind === "done") return action.result;
        landedContext = action.landedContext;
        diffState = action.diffState;
      }

      // Build prompt inputs.
      const transcript = this._readTranscript(worktreePath, claudeSessionId, spawnAccountDir);
      const digest = buildTranscriptDigest(transcript);
      const plan = this._readPlan(worktreePath);
      const changedFiles = diff.files.map((f) => f.path);
      const changedFilesWithStatus = diff.files.map((f) => ({ path: f.path, status: f.status }));

      const contextParts: string[] = [];
      const review = this.deps.store.getReview(id);
      if (review?.summary) contextParts.push(`Critic verdict: ${review.summary}`);
      if (landedContext) contextParts.push(landedContext);
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
        operatorLanguage: this.operatorLanguage(),
      });
      const env = this.env();
      const { argv, sessionId: spawnSessionId } = recapArgv(
        env.provider,
        env.model,
        prompt,
        env.effort,
      );

      // Spawn.
      const cwd = this._makeTmpDir();
      try {
        await this.deps.herdr.start(
          `recap ${session.desig}`,
          cwd,
          argv,
          apiKeyPassthroughEnv(false),
        );
      } catch (err) {
        this._cleanup(cwd);
        this.putFailureRecap(session, "launch-failed", err, head, base);
        return "error";
      }

      const spawnedAt = this.now();

      this.deps.store.recordReviewerSpawn({
        reviewerSessionId: spawnSessionId,
        taskSessionId: id,
        kind: "recap",
        worktreePath: cwd,
        reviewerProvider: env.provider,
        model: env.model,
        reviewerEffort: env.effort ?? null,
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
        diffState,
        spawnSessionId,
        cwd,
        model: env.model,
        spawnedAt,
        generatedAt: null,
        updatedAt: spawnedAt,
      };
      this.deps.store.putRecap(row);
      this.deps.onChange(id, row);
      // Recap renders diff blocks via `hunks`, never `patch` — strip it before it lands
      // in the pendingDiff carrier so the stored/reconstructed block never carries both
      // representations (the session endpoint is the only consumer of raw `patch`).
      this.deps.store.setRecapPendingDiff(id, stripPatchForRecap(diff.files));

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
      this.finalizing.add(r.sessionId); // claim BEFORE the first await — race-safe (mirrors review.ts)
      let action: VerdictAction;
      let read: VerdictRead<unknown>;
      let elapsed: number;
      let finished: boolean;
      let timedOut: boolean;
      try {
        elapsed = this.now() - r.spawnedAt;
        read = this._readVerdict(r.cwd);
        timedOut = elapsed > this.timeoutMs;
        // Ground-truth liveness via paneForegroundProcs (same signal as tab-reaper): a live-but-idle
        // recap spawn between API turns reads "idle" in agentStatus but still has non-shell procs.
        // isSpawnAlive never throws; herdr errors → fail-closed alive.
        finished = !(await isSpawnAlive(this.deps.herdr, r.cwd));
        action = decideVerdictAction(read, finished, timedOut, elapsed > STARTUP_GRACE_MS);
      } catch (err) {
        // _readVerdict or decideVerdictAction threw; isSpawnAlive itself never throws.
        // Release the flag so the next tick retries — otherwise stays in finalizing forever,
        // wedging the session's recap and leaking its tmpdir/terminal.
        this.finalizing.delete(r.sessionId);
        console.warn(`[recap] liveness/read failed for ${r.sessionId}, retrying next tick:`, err);
        continue;
      }
      if (action === "wait") {
        this.finalizing.delete(r.sessionId); // release: not finalizing this tick
        continue; // not-yet-written / repaired-or-unparseable while still working
      }
      // finalize-value carries the parsed verdict; finalize-null (timeout / fail-fast) → `failed`.
      const raw = action === "finalize-value" && read.status === "parsed" ? read.value : null;
      const failure =
        action === "finalize-null"
          ? await this.failureForUnproducedVerdict(r, read, elapsed, finished, timedOut)
          : undefined;

      // finalizing flag stays set; always delete in finally so entry doesn't wedge after a throw.
      try {
        await this.finalize(r, raw, failure);
      } finally {
        this.finalizing.delete(r.sessionId);
      }
    }
  }

  private async failureForUnproducedVerdict(
    recap: Recap,
    read: VerdictRead<unknown>,
    elapsed: number,
    finished: boolean,
    timedOut: boolean,
  ): Promise<RecapFailure> {
    const detail = await this.logUnproducedVerdict(recap, read, elapsed, finished);
    if (read.status === "unparseable") return this.failureFor(recap, "invalid-result", detail);
    return this.failureFor(recap, timedOut ? "timed-out" : "no-result", detail);
  }

  /** Observability for a finalize-null recap (timeout / fail-fast): a `failed` recap used to be a
   *  black hole (no log, raw discarded), so an intermittent malformed write was undiagnosable —
   *  surface WHY before finalizing. Extracted from tick() to keep its cognitive complexity in bound. */
  private async logUnproducedVerdict(
    r: Recap,
    read: VerdictRead<unknown>,
    elapsed: number,
    finished: boolean,
  ): Promise<string | undefined> {
    const spawn = this.deps.store
      .listReviewerSpawns()
      .find((s) => s.reviewerSessionId === r.spawnSessionId);
    const paneId = this.resolveTerminal(r.cwd);
    const ctx =
      `spawn=${r.spawnSessionId || "<none>"} cwd=${r.cwd || "<none>"} model=${r.model ?? "<default>"} ` +
      `provider=${spawn?.reviewerProvider ?? "<unknown>"} effort=${spawn?.reviewerEffort ?? "<default>"} ` +
      `elapsed=${Math.round(elapsed / 1000)}s pane=${paneId ? "present" : "absent"} ` +
      `finished=${finished}`;
    if (read.status === "unparseable") {
      console.warn(
        `[recap] ${r.sessionId}: verdict file present but unparseable even after jsonrepair — failing. ${ctx} snippet: ${recapSnippet(sanitizeRecapFailureDetail(read.raw))}`,
      );
      return sanitizeRecapFailureDetail(read.raw);
    }
    // No verdict file — capture the spawn's terminal tail (best-effort) so the reason is diagnosable
    // instead of a black hole: a chatgpt-account-incompatible codex model prints its 400
    // ("… not supported when using Codex with a ChatGPT account") here before exiting. The pane may
    // already be reaped (husk gone) → empty tail, unchanged behaviour.
    const tail = paneId ? await this.readPaneTail(paneId) : "";
    console.warn(
      `[recap] ${r.sessionId}: no verdict file (spawn exited or hard timeout) — agent produced nothing. ${ctx}${
        tail ? ` pane-tail: ${tail}` : ""
      }`,
    );
    return sanitizeRecapFailureDetail(
      tail || `Agent produced no verdict after ${Math.round(elapsed / 1000)} seconds.`,
    );
  }

  /** Best-effort, bounded tail of a spawn's terminal buffer for diagnostics. Takes the LAST ~300
   *  chars (a CLI error appears at the end, unlike recapSnippet's head slice). Never throws. */
  private async readPaneTail(paneId: string): Promise<string> {
    try {
      const buf = await this.deps.herdr.readAsync(paneId, "recent", 20);
      const oneLine = buf.replace(/\s+/g, " ").trim();
      return (
        sanitizeRecapFailureDetail(oneLine.length > 300 ? `…${oneLine.slice(-300)}` : oneLine) ?? ""
      );
    } catch {
      return "";
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

  private async finalize(r: Recap, raw: unknown | null, failure?: RecapFailure): Promise<void> {
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
          failure: null,
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
          console.warn(
            `[recap] ${r.sessionId}: verdict parsed as JSON but failed recap-shape validation — failing. snippet: ${recapSnippet(sanitizeRecapFailureDetail(JSON.stringify(raw)))}`,
          );
        }
        newRow = {
          ...rBase,
          state: "failed",
          failure:
            failure ??
            this.failureFor(
              r,
              "invalid-result",
              raw == null ? undefined : recapSnippet(JSON.stringify(raw)),
            ),
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
        await this.deps.herdr.stop(this.resolveTerminal(r.cwd));
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
