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
  const makeTmpDir = deps.makeTmpDir ?? defaultMakeTmpDir;
  const readName = deps.readName ?? defaultReadName;
  const cleanup = deps.cleanup ?? defaultCleanup;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? realSleep;
  const timeoutMs = deps.timeoutMs ?? 30_000;
  const pollMs = deps.pollMs ?? 1_000;
  const model = deps.model ?? "haiku";

  let cwd: string | null = null;
  let terminalId: string | null = null;
  try {
    cwd = makeTmpDir();
    const argv = [
      "claude",
      "--session-id",
      randomUUID(),
      // Run in a CLEAN context — same rationale as the critic: user's global hooks
      // (e.g. SessionStart superpowers preamble) would inject a "you MUST invoke a
      // skill" message that dontAsk can't satisfy, causing the agent to thrash.
      // NOT --bare: it refuses subscription OAuth (strictly ANTHROPIC_API_KEY).
      "--settings",
      '{"disableAllHooks":true}',
      "--disable-slash-commands",
      "--allowedTools",
      // Bare `Write` — NOT Write(<path>). Path-scoped Write rules are silently
      // denied under --permission-mode dontAsk (every scoped form fails to match),
      // so a scoped rule would block the slug write. Bare Write is an acceptable
      // widening: the cwd is a disposable temp dir and the agent can't exec, commit,
      // push, or reach anything outside it (no general Bash, no Edit, no network).
      "Write",
    ];
    if (model) argv.push("--model", model);
    // --permission-mode LAST: `--allowedTools <tools...>` is variadic and eats
    // every following token until the next flag. The task prompt is a trailing
    // positional, so a single-value flag MUST sit between the allowlist and the
    // prompt — otherwise `claude` folds the prompt into the allowlist, launches
    // with no task, and hangs until timeout. Don't reorder.
    argv.push("--permission-mode", "dontAsk");
    argv.push(namingPrompt(taskText));

    const start = now();
    try {
      terminalId = deps.herdr.start(label, cwd, argv).terminalId;
    } catch {
      return null; // herdr/claude unavailable → fall back to heuristic
    }

    let raw: string | null = null;
    while (now() - start <= timeoutMs) {
      raw = readName(cwd);
      if (raw !== null) break;
      await sleep(pollMs);
    }
    if (raw === null) return null; // timed out

    const firstLine =
      raw
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length > 0) ?? "";
    const slug = slugifyManual(firstLine);
    return slug && slug !== "task" ? slug : null;
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
