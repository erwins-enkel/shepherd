import { mkdtempSync, rmSync } from "node:fs";
import { readRoleResultText, CODEX_LAST_MESSAGE_FILE } from "./codex-last-message";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrDriver } from "./herdr";
import type { AutopilotVerdict, AgentProvider } from "./types";
import type { OperatorLanguage } from "./operator-language";
import { apiKeyFailClosed, apiKeyPassthroughEnv } from "./spawn-auth";
import { buildTransientAgentArgv } from "./transient-agent-argv";
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
  makeTmpDir?: () => string;
  readVerdict?: (cwd: string) => RawVerdict | null;
  cleanup?: (cwd: string) => void;
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
): string[] {
  return buildTransientAgentArgv("writer-only", { provider, model, effort, prompt }).argv;
}

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
    cleanup = defaultCleanup,
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

  // Fail closed: in Anthropic api-key mode without a configured key, a Claude spawn must NOT bill
  // the subscription — surface to the operator rather than auto-classifying on the wrong footing.
  // Gated on the resolved provider: a Codex classifier uses Codex's own auth, so the gate skips it.
  if (apiKeyFailClosed(provider)) return SURFACE;

  const pre = preClassify(tail);
  if (pre) return pre;

  let cwd: string | null = null;
  let terminalId: string | null = null;
  try {
    cwd = makeTmpDir();
    const prompt = classifierPrompt(tail, taskPrompt, operatorLanguage);
    try {
      terminalId = (
        await deps.herdr.start(
          label,
          cwd,
          classifierArgv(provider, model, prompt, effort),
          apiKeyPassthroughEnv(false),
        )
      ).terminalId;
    } catch {
      return SURFACE; // herdr/claude unavailable → surface (don't auto-proceed blind)
    }
    const raw = await pollForVerdict(readVerdict, cwd, { now, sleep, timeoutMs, pollMs });
    return normalize(raw);
  } finally {
    if (terminalId) {
      try {
        await deps.herdr.stop(terminalId);
      } catch {
        /* best-effort */
      }
    }
    if (cwd) cleanup(cwd);
  }
}
