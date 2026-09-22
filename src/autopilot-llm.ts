import {
  CodexCapacityWait,
  type CapacityInterruptionCheck,
  type CapacityCheck,
} from "./codex-capacity";
import { readRoleResultText, CODEX_LAST_MESSAGE_FILE } from "./codex-last-message";
import type { HerdrDriver } from "./herdr";
import {
  cleanupHelperDir,
  makeHelperTmpDir,
  reapHelperRun,
  realSleep,
} from "./transient-helper-lifecycle";
import type { SessionStore } from "./store";
import type { AutopilotVerdict, AgentProvider } from "./types";
import type { OperatorLanguage } from "./operator-language";
import type { TaskAmendment } from "./task-amendments";
import { apiKeyFailClosed, apiKeyPassthroughEnv } from "./spawn-auth";
import { buildTransientAgentArgv } from "./transient-agent-argv";
import { CODEX_ROLE_OUTPUT_SCHEMAS } from "./codex-role-output-schema";
import type { SessionUsage } from "./usage";
import { readReviewerSpawnUsage } from "./reviewer-usage";
import {
  VERDICT_FILE,
  SURFACE,
  preClassify,
  classifierPrompt,
  normalize,
  judgeClassifierQuestion,
  judgeVerdict,
  JUDGE_QUESTION_ID,
  type RawVerdict,
} from "./autopilot-classify-core";
import type { Judge } from "./judge";
import type { JudgeSpendLedger } from "./judge-spend";
import { timedAsync } from "./instrument";

// Re-export the pure classifier-core symbols that external code + tests import from this module,
// so they keep resolving after the extraction to the leaf module (autopilot-classify-core.ts).
// `normalize` stays internal (not re-exported) — it was never part of this module's public API.
export { VERDICT_FILE, preClassify, classifierPrompt } from "./autopilot-classify-core";
export type { RawVerdict } from "./autopilot-classify-core";

export interface ClassifierDeps {
  capacity?: CapacityCheck;
  capacityInterrupted?: CapacityInterruptionCheck;
  herdr: Pick<HerdrDriver, "start" | "stop">;
  store: Pick<
    SessionStore,
    | "recordReviewerSpawn"
    | "completeReviewerSpawn"
    | "listReviewerSpawns"
    | "setReviewerSpawnProviderSessionId"
  >;
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
  /** #2225: the session's standing operator task amendments, resolved by the caller (the binding
   *  site already holds the store + the task session id). Absent/empty ⇒ byte-identical prompt. */
  amendments?: readonly TaskAmendment[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  pollMs?: number;
  /** #2369: the decision-model judge. Absent — which is the default, and what an operator gets
   *  unless they BOTH turn the setting on and supply a key — means the spawn path below runs
   *  exactly as it always has. */
  judge?: Judge | null;
  /** #2369: the daily spend ceiling. Absent ⇒ unmetered, which only happens in tests; production
   *  always wires one alongside the judge. */
  judgeSpend?: JudgeSpendLedger | null;
}

const defaultMakeTmpDir = (): string => makeHelperTmpDir("shepherd-autopilot-");
function defaultReadVerdict(cwd: string): RawVerdict | null {
  // Result file first, Codex `-o` last-message fallback when absent (a Codex classifier that answers
  // in chat never writes the result file — see codex-last-message.ts).
  // Disposable-tmpdir role → fixed fallback name (fresh empty cwd, no pre-seed risk).
  const text = readRoleResultText(cwd, VERDICT_FILE, CODEX_LAST_MESSAGE_FILE);
  if (text === null) return null;
  try {
    return JSON.parse(text) as RawVerdict;
  } catch {
    return null; // partial write; try again next poll
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
  // The autopilot classifier READS the `-o` last-message fallback → opt in.
  return buildTransientAgentArgv("writer-only", {
    provider,
    model,
    effort,
    prompt,
    captureLastMessage: true,
    outputSchemaFile: CODEX_ROLE_OUTPUT_SCHEMAS.autopilot,
  });
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

    let usage: SessionUsage | null = deps.provider === "codex" ? null : ZEROED_USAGE;
    try {
      usage = (await deps.readUsage(cwd, sessionId, spawnAccountDir)) ?? usage;
    } catch (err) {
      deps.reportFailure("[autopilot] classifier usage read failed:", err);
    }

    try {
      deps.store.completeReviewerSpawn(sessionId, usage, deps.now());
    } catch (err) {
      deps.reportFailure("[autopilot] classifier usage completion failed:", err);
    }
  } finally {
    if (cwd) {
      try {
        await reapHelperRun(deps.herdr, null, cwd, deps.cleanup);
      } catch (err) {
        deps.reportFailure("[autopilot] classifier cleanup failed:", err);
      }
    }
  }
}

/**
 * The judge leg (#2369): one HTTP request in place of a spawn, a PTY pane and a 1 s disk poll under
 * a 120 s budget. Returns null for EVERY failure — unarmed, over the ceiling, transport error,
 * deadline, missing answer, off-enum answer — and null always means "fall back to the spawn below",
 * so there is no path on which arming the judge can cost a capability.
 */
async function classifyViaJudge(
  tail: string[],
  prompt: string,
  judge: Judge,
  spend: JudgeSpendLedger | null | undefined,
  reportFailure: (message: string, err: unknown) => void,
): Promise<AutopilotVerdict | null> {
  try {
    // Inside the try, deliberately: `allow` reads the DB, and a locked database must degrade to the
    // spawn like every other failure here rather than escape `classifyStop` to its caller.
    if (spend && !spend.allow()) return null;
    const result = await timedAsync("judge classifyStop", () =>
      judge.ask(prompt, { [JUDGE_QUESTION_ID]: judgeClassifierQuestion() }),
    );
    // Booked before the answer is inspected: an unusable answer was still billed, and a ceiling
    // that only counts answers it liked is not a ceiling. A ledger write must never lose a verdict
    // we already paid for, so it is best-effort.
    try {
      spend?.record(result.costUsd);
    } catch (err) {
      reportFailure("[autopilot] judge spend record failed:", err);
    }
    const raw = judgeVerdict(result.answers[JUDGE_QUESTION_ID], tail);
    return raw === null ? null : normalize(raw);
  } catch (err) {
    reportFailure("[autopilot] judge classify failed (falling back to spawn):", err);
    return null;
  }
}

/**
 * Classify why an agent stopped.
 *
 * Two legs. When a judge is wired (#2369) it answers first — one HTTP request, bounded by its own
 * wall-clock deadline. On ANY judge failure, and whenever no judge is wired, this falls back to the
 * historical path: a transient interactive `claude` (subscription OAuth — NOT `claude -p`) spawned
 * into a fresh temp dir with only the Write tool, polled for its verdict file, then torn down.
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
    cleanup = cleanupHelperDir,
    readUsage = (cwd, id, accountDir) => readReviewerSpawnUsage(deps.store, cwd, id, accountDir),
    warn = (message, err) => console.warn(message, err),
    provider = "claude",
    model = "haiku",
    effort = null,
    operatorLanguage = "en",
    amendments = [],
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
  //
  // #2369 scoped this to the SPAWN rather than to classification as a whole. The judge bills its own
  // vendor on its own key, so a missing Anthropic key is no reason for it not to answer; what the
  // gate must still prevent is the fallback silently billing the subscription. So: judge first,
  // then surface instead of spawning.
  const spawnBarred = apiKeyFailClosed(provider);

  // Still ahead of the judge: an empty tail has nothing to classify, and surfacing costs nothing.
  const pre = preClassify(tail);
  if (pre) return pre;

  // One prompt, both legs: the judge is asked the production prompt VERBATIM as its state, which is
  // what the measurement picked — so the two classifiers cannot drift apart by construction.
  const prompt = classifierPrompt(tail, taskPrompt, operatorLanguage, amendments);

  if (deps.judge) {
    const viaJudge = await classifyViaJudge(
      tail,
      prompt,
      deps.judge,
      deps.judgeSpend,
      reportFailure,
    );
    if (viaJudge) return viaJudge;
  }

  if (spawnBarred) return SURFACE;
  if (
    deps.capacity &&
    !(await deps.capacity({
      owner: "classifier",
      key: `classifier:${deps.taskSessionId}`,
      target: deps.taskSessionId,
      provider,
      model,
    }))
  )
    throw new CodexCapacityWait();

  let cwd: string | null = null;
  let terminalId: string | null = null;
  let classifierSessionId: string | null = null;
  let spawnedAt: number | null = null;
  let spawnAccountDir: string | undefined;
  try {
    cwd = makeTmpDir();
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
    if (
      !raw &&
      (await deps.capacityInterrupted?.(
        {
          owner: "classifier",
          key: `classifier:${deps.taskSessionId}`,
          target: deps.taskSessionId ?? "",
          provider,
          model: model ?? null,
        },
        cwd,
        classifierSessionId!,
      ))
    )
      throw new CodexCapacityWait();
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
