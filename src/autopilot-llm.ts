import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrDriver } from "./herdr";
import type { SessionStore } from "./store";
import type { AutopilotVerdict, AgentProvider } from "./types";
import type { OperatorLanguage } from "./operator-language";
import { apiKeyFailClosed, apiKeyPassthroughEnv } from "./spawn-auth";
import { buildTransientAgentArgv } from "./transient-agent-argv";
import { readSessionUsage, type SessionUsage } from "./usage";
import {
  VERDICT_FILE,
  SURFACE,
  preClassify,
  classifierPrompt,
  normalize,
  type RawVerdict,
} from "./autopilot-classify-core";

// Re-export the pure classifier-core symbols that external code + tests import from this module,
// so they keep resolving after the extraction to the leaf module (autopilot-classify-core.ts).
// `normalize` stays internal (not re-exported) — it was never part of this module's public API.
export { VERDICT_FILE, preClassify, classifierPrompt } from "./autopilot-classify-core";
export type { RawVerdict } from "./autopilot-classify-core";

export interface ClassifierDeps {
  herdr: Pick<HerdrDriver, "start" | "stop">;
  store: Pick<SessionStore, "recordReviewerSpawn" | "completeReviewerSpawn">;
  taskSessionId: string;
  makeTmpDir?: () => string;
  readVerdict?: (cwd: string) => RawVerdict | null;
  readUsage?: (
    cwd: string,
    sessionId: string,
    spawnAccountDir?: string | null,
  ) => Promise<SessionUsage | null>;
  cleanup?: (cwd: string) => void;
  warn?: (message: string, err: unknown) => void;
  provider?: AgentProvider;
  model?: string | null;
  effort?: string | null;
  /** Operator language for the classifier prompt (issue #1627). "en" (default) → byte-identical
   *  historical prompt; "de" → `summary` in German with `kind` pinned to the exact English enum. */
  operatorLanguage?: OperatorLanguage;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  pollMs?: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function defaultMakeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "shepherd-autopilot-"));
}
function defaultReadVerdict(cwd: string): RawVerdict | null {
  const p = join(cwd, VERDICT_FILE);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as RawVerdict;
  } catch {
    return null; // partial write; try again next poll
  }
}
function defaultCleanup(cwd: string): void {
  try {
    rmSync(cwd, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/** The classifier spawn's argv — the shared `writer-only` transient-agent shape. NOTE the input
 *  (the agent-stop tail) is UNTRUSTED; bare `Write` is safe here via the sandbox shape (disposable
 *  temp dir, dontAsk, no exec/Edit/network), NOT because the input is trusted. See
 *  buildTransientAgentArgv for the flag-order + isolation rationale. */
function classifierArgv(
  provider: AgentProvider,
  model: string | null,
  prompt: string,
  effort?: string | null,
): { argv: string[]; sessionId: string } {
  return buildTransientAgentArgv("writer-only", { provider, model, effort, prompt });
}

const ZEROED_USAGE: SessionUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  messageCount: 0,
  lastActivity: null,
  byModel: {},
  fullRecaches: 0,
  sidechainCount: 0,
};

interface PollClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  pollMs: number;
}

async function pollForVerdict(
  readVerdict: (cwd: string) => RawVerdict | null,
  cwd: string,
  clock: PollClock,
): Promise<RawVerdict | null> {
  const start = clock.now();
  while (clock.now() - start <= clock.timeoutMs) {
    const raw = readVerdict(cwd);
    if (raw !== null) return raw;
    await clock.sleep(clock.pollMs);
  }
  return null;
}

type ReportFailure = (message: string, err: unknown) => void;

function failureReporter(warn: NonNullable<ClassifierDeps["warn"]>): ReportFailure {
  return (message, err) => {
    try {
      warn(message, err);
    } catch {
      /* logging must not change the classifier verdict or teardown */
    }
  };
}

interface ClassifierTeardownState {
  cwd: string | null;
  terminalId: string | null;
  sessionId: string | null;
  spawnedAt: number | null;
  spawnAccountDir?: string;
}

interface ClassifierTeardownDeps {
  herdr: ClassifierDeps["herdr"];
  store: ClassifierDeps["store"];
  taskSessionId: string;
  readUsage: NonNullable<ClassifierDeps["readUsage"]>;
  cleanup: NonNullable<ClassifierDeps["cleanup"]>;
  reportFailure: ReportFailure;
  provider: AgentProvider;
  model: string | null;
  effort: string | null;
  now: () => number;
}

async function teardownClassifier(
  state: ClassifierTeardownState,
  deps: ClassifierTeardownDeps,
): Promise<void> {
  const { cwd, terminalId, sessionId, spawnedAt, spawnAccountDir } = state;
  try {
    if (!terminalId) return;

    try {
      await deps.herdr.stop(terminalId);
    } catch (err) {
      deps.reportFailure("[autopilot] classifier stop failed:", err);
    }

    if (!cwd || !sessionId) return;
    let usage = ZEROED_USAGE;
    try {
      usage = (await deps.readUsage(cwd, sessionId, spawnAccountDir)) ?? ZEROED_USAGE;
    } catch (err) {
      deps.reportFailure("[autopilot] classifier usage read failed:", err);
    }

    try {
      deps.store.recordReviewerSpawn({
        reviewerSessionId: sessionId,
        taskSessionId: deps.taskSessionId,
        kind: "classifier",
        worktreePath: cwd,
        reviewerProvider: deps.provider,
        model: deps.model,
        reviewerEffort: deps.effort,
        spawnedAt: spawnedAt ?? deps.now(),
      });
    } catch (err) {
      deps.reportFailure("[autopilot] classifier usage record failed:", err);
      return;
    }

    try {
      deps.store.completeReviewerSpawn(sessionId, usage, deps.now());
    } catch (err) {
      deps.reportFailure("[autopilot] classifier usage completion failed:", err);
    }
  } finally {
    if (cwd) {
      try {
        deps.cleanup(cwd);
      } catch (err) {
        deps.reportFailure("[autopilot] classifier cleanup failed:", err);
      }
    }
  }
}

/**
 * Classify why an agent stopped, via a transient interactive `claude` (subscription OAuth —
 * NOT `claude -p`). Spawns the classifier model in a fresh temp dir with only the Write
 * tool, polls for the verdict file, normalizes it, then tears the agent + dir down.
 * Returns `{kind:"unknown",summary:""}` on any failure/timeout/garbage — bias to surface.
 */
export async function classifyStop(
  tail: string[],
  taskPrompt: string,
  deps: ClassifierDeps,
  label: string,
): Promise<AutopilotVerdict> {
  const {
    makeTmpDir = defaultMakeTmpDir,
    readVerdict = defaultReadVerdict,
    readUsage = readSessionUsage,
    cleanup = defaultCleanup,
    warn = (message, err) => console.warn(message, err),
    provider = "claude",
    model = "haiku",
    effort = null,
    operatorLanguage = "en",
    now = Date.now,
    sleep = realSleep,
    // Deliberately shorter than the critic's 10m: this is a fast tail-triage on haiku, not a
    // full-diff review — a stuck classifier should surface to the operator (unknown→pause)
    // promptly, not block for minutes. 2m (vs the namer's 60s) gives a cold/queued spawn
    // enough headroom that a transient slow start doesn't manifest as a spurious pause.
    timeoutMs = 120_000,
    pollMs = 1_000,
  } = deps;
  const reportFailure = failureReporter(warn);

  // Fail closed: in Anthropic api-key mode without a configured key, a Claude spawn must NOT bill
  // the subscription — surface to the operator rather than auto-classifying on the wrong footing.
  // Gated on the resolved provider: a Codex classifier uses Codex's own auth, so the gate skips it.
  if (apiKeyFailClosed(provider)) return SURFACE;

  const pre = preClassify(tail);
  if (pre) return pre;

  let cwd: string | null = null;
  let terminalId: string | null = null;
  let classifierSessionId: string | null = null;
  let spawnedAt: number | null = null;
  let spawnAccountDir: string | undefined;
  try {
    cwd = makeTmpDir();
    const prompt = classifierPrompt(tail, taskPrompt, operatorLanguage);
    try {
      const built = classifierArgv(provider, model, prompt, effort);
      classifierSessionId = built.sessionId;
      const spawnEnv = apiKeyPassthroughEnv(false);
      spawnAccountDir = spawnEnv?.CLAUDE_CONFIG_DIR;
      terminalId = (await deps.herdr.start(label, cwd, built.argv, spawnEnv)).terminalId;
      spawnedAt = now();
    } catch {
      return SURFACE; // herdr/claude unavailable → surface (don't auto-proceed blind)
    }
    const raw = await pollForVerdict(readVerdict, cwd, { now, sleep, timeoutMs, pollMs });
    return normalize(raw);
  } finally {
    await teardownClassifier(
      { cwd, terminalId, sessionId: classifierSessionId, spawnedAt, spawnAccountDir },
      {
        herdr: deps.herdr,
        store: deps.store,
        taskSessionId: deps.taskSessionId,
        readUsage,
        cleanup,
        reportFailure,
        provider,
        model,
        effort,
        now,
      },
    );
  }
}
