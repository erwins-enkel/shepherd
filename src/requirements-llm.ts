import { CODEX_LAST_MESSAGE_FILE, readRoleResultText } from "./codex-last-message";
import { CODEX_ROLE_OUTPUT_SCHEMAS } from "./codex-role-output-schema";
import type { HerdrDriver } from "./herdr";
import {
  REQUIREMENTS_FILE,
  normalizeDerivation,
  requirementsPrompt,
  type AnsweredDerivation,
  type TaskText,
} from "./requirements-classify-core";
import { apiKeyFailClosed, apiKeyPassthroughEnv } from "./spawn-auth";
import { buildTransientAgentArgv } from "./transient-agent-argv";
import {
  cleanupHelperDir,
  makeHelperTmpDir,
  reapHelperRun,
  realSleep,
} from "./transient-helper-lifecycle";
import type { AgentProvider } from "./types";

/**
 * Reading a task's requirements with a transient helper (issue #2773) — the spawn leg of the
 * autopilot classifier's seam (`autopilot-llm.ts`), not the judge: the judge answers faster but is
 * opt-in and needs a vendor key, while this runs wherever the classifier does, on the same role
 * CLI and model. A fresh temp dir, the shared `writer-only` argv, a poll for the answer file, then
 * the pane and the dir are torn down. Never throws: every failure is a `failed` derivation, so the
 * caller derives nothing and says so.
 *
 * The helper reads only the task text. It gets no `--add-dir`, so the repository — a `native/`
 * folder, a `Package.swift` — can never call for anything.
 */

/** Label prefix of the helper's herdr tab (`requirements <id>`). Space-prefixed so a session slug
 *  can never collide; registered with the tab reaper and boot-reaped in index.ts. */
export const REQUIREMENTS_LABEL = "requirements ";

export interface RequirementsAgentDeps {
  herdr: Pick<HerdrDriver, "start" | "stop">;
  provider?: AgentProvider;
  model?: string | null;
  effort?: string | null;
  /** Ends the wait early (the form moved on); the helper is torn down all the same. */
  signal?: AbortSignal;
  makeTmpDir?: () => string;
  readAnswer?: (cwd: string) => string | null;
  cleanup?: (cwd: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  pollMs?: number;
}

const UNAVAILABLE: AnsweredDerivation = { status: "failed", cause: "unavailable" };
const ERROR: AnsweredDerivation = { status: "failed", cause: "error" };
const TIMEOUT: AnsweredDerivation = { status: "failed", cause: "timeout" };

const defaultMakeTmpDir = (): string => makeHelperTmpDir("shepherd-requirements-");

/** The answer file first, Codex's `-o` last message when the helper answered in chat instead. */
function defaultReadAnswer(cwd: string): string | null {
  return readRoleResultText(cwd, REQUIREMENTS_FILE, CODEX_LAST_MESSAGE_FILE);
}

interface PollClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  pollMs: number;
  signal?: AbortSignal;
}

async function pollForAnswer(
  readAnswer: (cwd: string) => string | null,
  cwd: string,
  clock: PollClock,
): Promise<AnsweredDerivation> {
  const start = clock.now();
  // An answer that never parses is a broken answer, not a slow one.
  let unparseable = false;
  while (clock.now() - start <= clock.timeoutMs) {
    if (clock.signal?.aborted) return ERROR;
    const text = readAnswer(cwd);
    if (text !== null) {
      try {
        return normalizeDerivation(JSON.parse(text));
      } catch {
        unparseable = true; // partial write; try again next poll
      }
    }
    await clock.sleep(clock.pollMs);
  }
  return unparseable ? ERROR : TIMEOUT;
}

/** What `task` calls for, read by a transient helper; `failed` on any failure, timeout or abort. */
export async function deriveRequirementsViaAgent(
  task: TaskText,
  deps: RequirementsAgentDeps,
  label: string,
): Promise<AnsweredDerivation> {
  const {
    provider = "claude",
    model = "haiku",
    effort = null,
    makeTmpDir = defaultMakeTmpDir,
    readAnswer = defaultReadAnswer,
    cleanup = cleanupHelperDir,
    now = Date.now,
    sleep = realSleep,
    // The form waits on this before a task can start: well above the classifier's measured p90
    // (13.6 s), far below its 120 s — a stuck helper must turn into "add them yourself" quickly.
    timeoutMs = 30_000,
    pollMs = 500,
    signal,
  } = deps;

  // Fail closed: in api-key mode without a key, a Claude helper must not bill the subscription.
  if (apiKeyFailClosed(provider)) return UNAVAILABLE;
  if (signal?.aborted) return ERROR;

  let cwd: string | null = null;
  let terminalId: string | null = null;
  try {
    cwd = makeTmpDir();
    try {
      const { argv } = buildTransientAgentArgv("writer-only", {
        provider,
        model,
        effort,
        prompt: requirementsPrompt(task),
        captureLastMessage: true,
        outputSchemaFile: CODEX_ROLE_OUTPUT_SCHEMAS.requirements,
      });
      terminalId = (await deps.herdr.start(label, cwd, argv, apiKeyPassthroughEnv(false)))
        .terminalId;
    } catch {
      return UNAVAILABLE; // herdr or the CLI is not there
    }
    return await pollForAnswer(readAnswer, cwd, { now, sleep, timeoutMs, pollMs, signal });
  } catch {
    return ERROR;
  } finally {
    await reapHelperRun(deps.herdr, terminalId, cwd, cleanup);
  }
}
