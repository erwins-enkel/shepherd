import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { HerdrDriver } from "./herdr";
import {
  cleanupHelperDir,
  makeHelperTmpDir,
  reapHelperRun,
  realSleep,
} from "./transient-helper-lifecycle";
import { isApiKeyMode, isApiKeyConfigured, apiKeyPassthroughEnv } from "./spawn-auth";
import { buildTransientAgentArgv } from "./transient-agent-argv";

/** Label for the transient API-key verifier spawn. A multi-word phrase with SPACES, so it can't
 *  collide with an `[a-z0-9-]` session slug — which is what lets the boot label-reap in index.ts
 *  close prior-lifetime orphans with an EMPTY owned set. Exported so the spawn site here, that
 *  boot reap, and tab-reaper.ts's husk filter all bind to ONE constant (#1147). */
export const VERIFY_KEY_LABEL = "verify api key";

/**
 * Token the verify agent must write to {@link VERIFY_FILE}. Distinctive + unlikely
 * to appear in benign pane chatter — so its presence in the file is unambiguous proof
 * the spawned `claude` completed a real authenticated turn end-to-end.
 */
export const SENTINEL = "SHEPHERD_KEY_OK_8F3A";

/** The file the verify agent writes {@link SENTINEL} to, in its temp cwd. */
export const VERIFY_FILE = ".shepherd-verify";

/**
 * Conservative, auth-SPECIFIC signatures that flag an authentication failure in the
 * agent's pane text. Kept narrow so benign output (or a successful turn) never matches:
 * each pattern names an unambiguous auth condition, not a generic error. Used to
 * FAST-FAIL `verifyApiKey` the instant a 401/login error renders, instead of waiting
 * out the full timeout.
 */
export const AUTH_ERROR_SIGNATURES: RegExp[] = [
  /invalid x-api-key/i,
  /authentication_error/i,
  /(api error|status)[: ]+401/i,
  /invalid api key/i,
  /please run \/login/i,
  /oauth token has expired/i,
];

/**
 * First pane line matching any {@link AUTH_ERROR_SIGNATURES} signature, trimmed (for
 * surfacing as `detail`); null when nothing matches. Line-scoped so the returned detail
 * is a single readable line, not the whole buffer.
 */
export function matchAuthError(paneText: string): string | null {
  for (const rawLine of paneText.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (AUTH_ERROR_SIGNATURES.some((re) => re.test(line))) return line;
  }
  return null;
}

export interface VerifyKeyDeps {
  herdr: Pick<HerdrDriver, "start" | "stop" | "readAsync">;
  makeTmpDir?: () => string;
  readSentinel?: (cwd: string) => string | null;
  cleanup?: (cwd: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  pollMs?: number;
}

export interface VerifyKeyResult {
  ok: boolean;
  reason?: string;
  detail?: string;
}

/** Self-contained instructions for the verify agent. NOT UI chrome — never i18n'd. */
function verifyPrompt(): string {
  return [
    `Write EXACTLY the token \`${SENTINEL}\` (and nothing else — no quotes, no newline preamble)`,
    `to the file \`${VERIFY_FILE}\` in the current directory, then stop.`,
    "Do not read or modify any other file.",
  ].join(" ");
}

const defaultMakeTmpDir = (): string => makeHelperTmpDir("shepherd-verify-");
function defaultReadSentinel(cwd: string): string | null {
  const p = join(cwd, VERIFY_FILE);
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null; // partial write; try again next poll
  }
}

/** The verify spawn's argv — the shared `writer-only` transient-agent shape, pinned to `haiku` (a
 *  cheap, fast end-to-end auth check). The input is a fixed sentinel prompt (trusted). See
 *  buildTransientAgentArgv for the flag-order + isolation rationale. */
function verifyArgv(): string[] {
  return buildTransientAgentArgv("writer-only", { model: "haiku", prompt: verifyPrompt() }).argv;
}

/** Single readable line for `detail`: newlines collapsed, clipped to ~500 chars. */
function clipDetail(line: string): string {
  return line.replace(/\s+/g, " ").trim().slice(0, 500);
}

/**
 * Verify the configured Anthropic API key actually authenticates, END-TO-END through
 * the same api-key spawn wiring real agents use: a transient interactive `claude`
 * (subscription-style OAuth spawn — NOT `claude -p`) with the key supplied via the
 * `apiKeyHelper` + credential-less CLAUDE_CONFIG_DIR. Spawns haiku in a fresh temp dir
 * with only Write, instructed to write {@link SENTINEL} to {@link VERIFY_FILE}; polls
 * for that file, fast-fails on an auth error in the pane, then tears the agent + dir down.
 *
 * WHY the sentinel-file + pane-matcher discriminator: a `claude` spawned this way does
 * NOT exit after its turn — on success it writes the file and goes idle; on a 401 it
 * renders the error and ALSO stays idle. herdr exposes no liveness/exit field, so the
 * ONLY way to tell the two apart is the sentinel file (good) vs an auth-error in the pane
 * (bad). Hence {@link matchAuthError} is load-bearing, not a nicety.
 *
 * Fail-closed: never spawns unless api-key mode is selected AND a key is configured.
 * Secret hygiene: this function never receives the raw key (only the helper PATH via
 * config) and never logs pane text / detail verbatim — `detail` is clipped.
 */
export async function verifyApiKey(deps: VerifyKeyDeps): Promise<VerifyKeyResult> {
  // Guards (fail-closed): do NOT spawn outside a configured api-key setup.
  if (!isApiKeyMode()) return { ok: false, reason: "not-api-key-mode" };
  if (!isApiKeyConfigured()) return { ok: false, reason: "not-configured" };

  const {
    makeTmpDir = defaultMakeTmpDir,
    readSentinel = defaultReadSentinel,
    cleanup = cleanupHelperDir,
    now = Date.now,
    sleep = realSleep,
    timeoutMs = 60_000, // cold `claude` startup + a haiku turn needs headroom
    pollMs = 750,
  } = deps;

  let cwd: string | null = null;
  let terminalId: string | null = null;
  try {
    cwd = makeTmpDir();
    try {
      terminalId = (
        await deps.herdr.start(VERIFY_KEY_LABEL, cwd, verifyArgv(), apiKeyPassthroughEnv(false))
      ).terminalId;
    } catch {
      return { ok: false, reason: "spawn-failed" };
    }

    const start = now();
    while (now() - start <= timeoutMs) {
      // 1. Sentinel file = unambiguous success.
      const raw = readSentinel(cwd);
      if (raw !== null && raw.includes(SENTINEL)) return { ok: true };

      // 2. Auth error in the pane = unambiguous failure — fast-fail before the deadline.
      let pane = "";
      try {
        pane = await deps.herdr.readAsync(terminalId, "visible");
      } catch {
        pane = ""; // transient read failure → just keep polling
      }
      const authError = matchAuthError(pane);
      if (authError) {
        return { ok: false, reason: "not-authenticated", detail: clipDetail(authError) };
      }

      // 3. Neither yet — wait and re-probe.
      await sleep(pollMs);
    }
    return { ok: false, reason: "timeout" };
  } finally {
    await reapHelperRun(deps.herdr, terminalId, cwd, cleanup);
  }
}
