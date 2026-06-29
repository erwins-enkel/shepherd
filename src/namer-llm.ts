import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrDriver } from "./herdr";
import type { AgentProvider } from "./types";
import { slugifyManual } from "./namer";
import { apiKeyFailClosed, apiKeyPassthroughEnv } from "./spawn-auth";
import { buildTransientAgentArgv } from "./transient-agent-argv";

/** The file the namer agent writes its slug to, in its temp cwd. */
export const NAME_FILE = ".shepherd-name";

export interface LlmNamerDeps {
  herdr: Pick<HerdrDriver, "start" | "stop">;
  makeTmpDir?: () => string;
  readName?: (cwd: string) => string | null;
  cleanup?: (cwd: string) => void;
  provider?: AgentProvider;
  model?: string | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  pollMs?: number;
}

/** Self-contained instructions for the namer agent. NOT UI chrome — never i18n'd. */
export function namingPrompt(taskText: string): string {
  const clipped = taskText.slice(0, 2000);
  return [
    "You are naming a coding task. Read the task description below and produce a short slug for it.",
    "",
    "Task description:",
    clipped,
    "",
    `Write a 2-4 word, kebab-case slug naming the SUBJECT of the task — what it is about — to the file \`${NAME_FILE}\` in the current directory, then stop.`,
    "Rules: no filler words, no articles, no quotes, no file extension. Use the SAME language as the task description. The file must contain ONLY the slug and nothing else.",
    "Do not read or modify any other file.",
  ].join("\n");
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function defaultMakeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "shepherd-namer-"));
}
function defaultReadName(cwd: string): string | null {
  const p = join(cwd, NAME_FILE);
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, "utf8");
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

/** The namer spawn's argv — the shared `writer-only` transient-agent shape (Write-only, dontAsk,
 *  clean context). The only input is the user's OWN task prompt (trusted), so bare `Write` is an
 *  accepted trade-off; see buildTransientAgentArgv for the full flag-order + posture rationale. */
function namerArgv(provider: AgentProvider, model: string | null, taskText: string): string[] {
  return buildTransientAgentArgv("writer-only", { provider, model, prompt: namingPrompt(taskText) })
    .argv;
}

interface PollClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  pollMs: number;
}

/** Poll `readName(cwd)` until it yields content or the deadline passes; null on timeout. */
async function pollForRaw(
  readName: (cwd: string) => string | null,
  cwd: string,
  clock: PollClock,
): Promise<string | null> {
  const start = clock.now();
  while (clock.now() - start <= clock.timeoutMs) {
    const raw = readName(cwd);
    if (raw !== null) return raw;
    await clock.sleep(clock.pollMs);
  }
  return null;
}

/** First non-empty line of the slug file → sanitized slug; null if nothing usable.
 *  slugifyManual emits "task" for empty/symbol-only input (and contains any prompt
 *  injection to a safe `[a-z0-9-]` slug) — we reject that generic fallback so the
 *  caller keeps its better heuristic name. */
function extractSlug(raw: string): string | null {
  const firstLine =
    raw
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const slug = slugifyManual(firstLine);
  return slug && slug !== "task" ? slug : null;
}

/**
 * Comprehend a session's subject via a transient interactive `claude` (subscription
 * OAuth — NOT `claude -p`, which bills as extra API usage). Spawns haiku in a fresh
 * temp dir with only the Write tool, polls for the slug file, sanitizes it, then tears
 * the agent + dir down. Returns a clean slug, or null on any failure/timeout/empty —
 * the caller then keeps the heuristic name. `label` is the herdr tab label (e.g.
 * "name TASK-07"), mirroring the critic's "review TASK-07".
 */
export async function llmName(
  taskText: string,
  deps: LlmNamerDeps,
  label: string,
): Promise<string | null> {
  const {
    makeTmpDir = defaultMakeTmpDir,
    readName = defaultReadName,
    cleanup = defaultCleanup,
    provider = "claude",
    model = "haiku",
    now = Date.now,
    sleep = realSleep,
    timeoutMs = 60_000, // cold `claude` startup + a haiku turn needs headroom
    pollMs = 1_000,
  } = deps;

  // Fail closed: in Anthropic api-key mode without a configured key, a Claude spawn must NOT bill
  // the subscription — skip the LLM namer and keep the heuristic name. Gated on the resolved
  // provider: a Codex namer uses Codex's own auth, so the Anthropic-key gate doesn't apply to it.
  if (apiKeyFailClosed(provider)) return null;

  let cwd: string | null = null;
  let terminalId: string | null = null;
  try {
    cwd = makeTmpDir();
    try {
      terminalId = deps.herdr.start(
        label,
        cwd,
        namerArgv(provider, model, taskText),
        apiKeyPassthroughEnv(false),
      ).terminalId;
    } catch {
      return null; // herdr/claude unavailable → fall back to heuristic
    }
    const raw = await pollForRaw(readName, cwd, { now, sleep, timeoutMs, pollMs });
    return raw === null ? null : extractSlug(raw);
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
