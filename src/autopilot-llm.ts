import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { HerdrDriver } from "./herdr";
import type { AutopilotVerdict, AutopilotKind } from "./types";
import {
  isApiKeyMode,
  isApiKeyConfigured,
  apiKeySettingsFragment,
  apiKeyPassthroughEnv,
} from "./spawn-auth";

/** The file the classifier agent writes its verdict JSON to, in its temp cwd. */
export const VERDICT_FILE = ".shepherd-autopilot.json";

const KINDS: AutopilotKind[] = ["gate", "question", "finished", "complete", "unknown"];
/** Uncertain → surface. A wrongly-surfaced gate costs one click; a wrongly-answered
 *  question costs a bad product decision. */
const SURFACE: AutopilotVerdict = { kind: "unknown", summary: "" };

export interface ClassifierDeps {
  herdr: Pick<HerdrDriver, "start" | "stop">;
  makeTmpDir?: () => string;
  readVerdict?: (cwd: string) => RawVerdict | null;
  cleanup?: (cwd: string) => void;
  model?: string | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  pollMs?: number;
}

interface RawVerdict {
  kind?: unknown;
  summary?: unknown;
}

/**
 * Deterministic pre-filter for classifyStop: when there is no terminal tail to
 * classify (the no-tail onDone path, autopilot.ts readTail throws/empties), there is
 * nothing for Haiku to read, so conservatively surface (unknown — never auto-proceed)
 * without paying for a spawn. Returns SURFACE for an empty/whitespace-only tail, else
 * null (→ caller proceeds to the Haiku spawn, unchanged). NOT an identical-verdict
 * optimization: today's empty-tail spawn still sees the task prompt and could return
 * complete/finished — this conservative override always surfaces instead.
 */
export function preClassify(tail: string[]): AutopilotVerdict | null {
  if (tail.every((l) => l.trim() === "")) return SURFACE;
  return null;
}

/**
 * Self-contained instructions for the classifier agent. NOT UI chrome — never i18n'd.
 * The tail is UNTRUSTED agent output; it is embedded as data the agent only classifies,
 * never executes — the Write-only / dontAsk / no-Bash sandbox contains any injection.
 */
export function classifierPrompt(tail: string[], taskPrompt: string): string {
  const clippedTask = taskPrompt.slice(0, 1500);
  const clippedTail = tail.slice(-20).join("\n").slice(0, 3000);
  return [
    "You are triaging why a coding agent has stopped. Read its task and the tail of its terminal,",
    "then classify WHY it is waiting. Do not do the task. Do not run anything.",
    "",
    "The agent's task:",
    clippedTask,
    "",
    "The tail of the agent's terminal (most recent last):",
    clippedTail,
    "",
    "Classify into exactly one `kind`:",
    '- "gate": a procedural/workflow stop the agent could resolve itself and the answer is obviously "yes, keep going" — e.g. "shall I write the spec first?", "ready to start implementing?", "want me to commit now?". Choose this ONLY when proceeding is clearly correct.',
    '- "question": a real decision that needs a human — a product/requirements fork, ambiguous intent, a choice between materially different approaches, or anything the agent should not decide unilaterally.',
    '- "finished": the agent has done code/implementation work whose deliverable is a pull request, believes it is done, but has not opened the PR yet. (It still needs to be driven to a PR.)',
    '- "complete": the agent has fully delivered a task whose deliverable is NOT a pull request — research/investigation/analysis, creating a GitHub issue, or a one-off answer — and there is nothing to turn into a PR. Judge by the TASK: if it never asked for code changes, a finished agent is "complete", not "finished".',
    '- "unknown": you cannot confidently tell. When in doubt, use this — never guess "gate".',
    "",
    `Write your verdict as JSON to the file \`${VERDICT_FILE}\` in the current directory, with EXACTLY this shape, then stop:`,
    '{"kind": "gate" | "question" | "finished" | "complete" | "unknown", "summary": "<1-2 sentence plain description of what the agent is waiting for, or for \\"complete\\" what it delivered>"}',
    "Do not read or modify any other file.",
  ].join("\n");
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

/**
 * The `claude` argv for the classifier spawn — identical isolation to the namer
 * (src/namer-llm.ts) and critic: clean context (disableAllHooks + disable-slash-commands),
 * subscription OAuth (NOT --bare), bare `Write` (scoped Write denied under dontAsk),
 * and --permission-mode dontAsk LAST (after the variadic --allowedTools, before the
 * trailing prompt). Don't reorder. In api-key auth mode the key arrives via apiKeyHelper
 * in --settings (folded in) + a credential-less CLAUDE_CONFIG_DIR — still NOT --bare.
 */
function classifierArgv(model: string | null, prompt: string): string[] {
  const argv = [
    "claude",
    "--session-id",
    randomUUID(),
    "--settings",
    // subscription → byte-identical `{"disableAllHooks":true}`; api-key folds in apiKeyHelper.
    JSON.stringify({ disableAllHooks: true, ...apiKeySettingsFragment() }),
    "--disable-slash-commands",
    "--allowedTools",
    "Write",
  ];
  if (model) argv.push("--model", model);
  argv.push("--permission-mode", "dontAsk");
  argv.push(prompt);
  return argv;
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

function normalize(raw: RawVerdict | null): AutopilotVerdict {
  if (!raw || typeof raw.kind !== "string" || !KINDS.includes(raw.kind as AutopilotKind)) {
    return SURFACE;
  }
  const summary = typeof raw.summary === "string" ? raw.summary.slice(0, 280) : "";
  return { kind: raw.kind as AutopilotKind, summary };
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
    model = "haiku",
    now = Date.now,
    sleep = realSleep,
    // Deliberately shorter than the critic's 10m: this is a fast tail-triage on haiku, not a
    // full-diff review — a stuck classifier should surface to the operator (unknown→pause)
    // promptly, not block for minutes. 2m (vs the namer's 60s) gives a cold/queued spawn
    // enough headroom that a transient slow start doesn't manifest as a spurious pause.
    timeoutMs = 120_000,
    pollMs = 1_000,
  } = deps;

  // Fail closed: api-key mode without a configured key must NOT bill the subscription —
  // surface to the operator rather than auto-classifying on the wrong footing.
  if (isApiKeyMode() && !isApiKeyConfigured()) return SURFACE;

  const pre = preClassify(tail);
  if (pre) return pre;

  let cwd: string | null = null;
  let terminalId: string | null = null;
  try {
    cwd = makeTmpDir();
    const prompt = classifierPrompt(tail, taskPrompt);
    try {
      terminalId = deps.herdr.start(
        label,
        cwd,
        classifierArgv(model, prompt),
        apiKeyPassthroughEnv(false),
      ).terminalId;
    } catch {
      return SURFACE; // herdr/claude unavailable → surface (don't auto-proceed blind)
    }
    const raw = await pollForVerdict(readVerdict, cwd, { now, sleep, timeoutMs, pollMs });
    return normalize(raw);
  } finally {
    if (terminalId) {
      try {
        deps.herdr.stop(terminalId);
      } catch {
        /* best-effort */
      }
    }
    if (cwd) cleanup(cwd);
  }
}
