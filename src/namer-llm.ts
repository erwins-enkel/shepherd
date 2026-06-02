import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { HerdrDriver } from "./herdr";
import { slugifyManual } from "./namer";

/** The file the namer agent writes its slug to, in its temp cwd. */
export const NAME_FILE = ".shepherd-name";

export interface LlmNamerDeps {
  herdr: Pick<HerdrDriver, "start" | "stop">;
  makeTmpDir?: () => string;
  readName?: (cwd: string) => string | null;
  cleanup?: (cwd: string) => void;
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

/**
 * The `claude` argv for the namer spawn — mirrors the critic (src/review.ts):
 *  - CLEAN context: user's global hooks (e.g. the SessionStart superpowers preamble)
 *    would inject a "you MUST invoke a skill" message that dontAsk can't satisfy,
 *    making the agent thrash. `--disable-slash-commands` removes skills entirely.
 *    NOT `--bare`: it refuses subscription OAuth (demands ANTHROPIC_API_KEY).
 *  - Bare `Write` — NOT Write(<path>): path-scoped Write rules are silently denied
 *    under `dontAsk`, which would block the slug write. Bare Write is not cwd-scoped,
 *    so an absolute-path write is technically permitted — an accepted trade-off (same
 *    as the critic) because the only input is the user's OWN prompt, not untrusted text.
 *    The agent still has no Bash/Edit/network, so it can't exec, commit, push, or fetch.
 *  - `--permission-mode dontAsk` LAST: `--allowedTools` is variadic and eats every
 *    following token until the next flag, so a single-value flag must sit between the
 *    allowlist and the trailing prompt — else the prompt is folded into the allowlist
 *    and the agent launches with no task. Don't reorder.
 */
function namerArgv(model: string | null, taskText: string): string[] {
  const argv = [
    "claude",
    "--session-id",
    randomUUID(),
    "--settings",
    '{"disableAllHooks":true}',
    "--disable-slash-commands",
    "--allowedTools",
    "Write",
  ];
  if (model) argv.push("--model", model);
  argv.push("--permission-mode", "dontAsk");
  argv.push(namingPrompt(taskText));
  return argv;
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
    model = "haiku",
    now = Date.now,
    sleep = realSleep,
    timeoutMs = 60_000, // cold `claude` startup + a haiku turn needs headroom
    pollMs = 1_000,
  } = deps;

  let cwd: string | null = null;
  let terminalId: string | null = null;
  try {
    cwd = makeTmpDir();
    try {
      terminalId = deps.herdr.start(label, cwd, namerArgv(model, taskText)).terminalId;
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
