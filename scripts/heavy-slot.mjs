#!/usr/bin/env node
// Shepherd's heavy-check runner (issue #3181).
//
// The PreToolUse tool guard (scripts/tool-guard.mjs) rewrites an agent's heavy Bash command —
// tests, type checks, builds — to `<node> heavy-slot.mjs -- '<command>'`. This runner asks the
// Shepherd server for the host-wide heavy-check slot BEFORE anything starts:
//   - granted  → run the command with SHEPHERD_HEAVY_JOB=<job> stamped on it (every descendant
//                inherits it; the server holds the slot while any process carrying it lives), then
//                report the exit and pass the command's exit code through;
//   - queued   → do NOT run it: print the server's message (place, estimated wait, what to do) and
//                exit 75. Shepherd steers the agent when the slot is its turn;
//   - disabled → run it unmanaged.
//
// Plain `.mjs` for the same reason as the guard: it runs under the node binary the sandbox membrane
// already binds, and it reaches the server over the agent ingress with the session's key header
// file — the `shepherd` CLI has no credentials inside a membrane.
//
// Every failure FAILS OPEN: no ingress coordinates, an unreachable or overloaded server, an
// unexpected answer — the command runs unmanaged with a one-line note. A broken slot must never
// stop an agent from running its checks at all.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";

/** Exit code when the check was queued and did NOT run (sysexits EX_TEMPFAIL). */
export const EXIT_QUEUED = 75;
/** How long the acquire may take before the runner gives up and runs unmanaged. */
const ACQUIRE_TIMEOUT_MS = 15_000;
const REPORT_TIMEOUT_MS = 5_000;
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

/** The command after `--` (the guard passes it as ONE argument), or null. */
export function commandFrom(argv) {
  if (argv.length !== 2 || argv[0] !== "--") return null;
  const command = argv[1];
  return typeof command === "string" && command.length > 0 && !command.includes("\0")
    ? command
    : null;
}

/**
 * The agent-ingress endpoint and key header for this session, or null when this process does not
 * run inside a Shepherd session (or its key file is unreadable).
 */
export function ingressConfig(env, readFile = (p) => readFileSync(p, "utf8")) {
  const base = env.SHEPHERD_AGENT_API_URL;
  const id = env.SHEPHERD_SESSION_ID;
  const headerFile = env.SHEPHERD_INGRESS_HEADER_FILE;
  if (!base || !id || !headerFile) return null;
  try {
    const url = new URL(base);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !["127.0.0.1", "localhost", "[::1]", "10.0.2.2"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      id === "." ||
      id === ".." ||
      id.includes("\0")
    )
      return null;
    url.pathname = `/api/sessions/${encodeURIComponent(id)}/heavy-slot`;

    // The file carries this session's auth header, deliberately sent only to the configured local
    // ingress (10.0.2.2 is the sandbox's gateway to host loopback). Never follow redirects with it.
    const line = readFile(headerFile).replace(/\r?\n$/, "");
    const colon = line.indexOf(":");
    if (colon <= 0) return null;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!/^[\t\x20-\x7e\x80-\xff]*$/.test(line) || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name))
      return null;
    return { endpoint: url.href, header: [name, value] };
  } catch {
    return null;
  }
}

async function post(cfg, body, timeoutMs) {
  const res = await fetch(cfg.endpoint, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json", [cfg.header[0]]: cfg.header[1] },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function shellPath() {
  return existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
}

/**
 * Run the selected executable and its unchanged arguments with stdio passed straight through.
 * `detached` (macOS) puts it in its own process group, whose id the server then watches. Signals
 * are forwarded so a Bash-tool timeout or Ctrl-C still reaches the command. Resolves its exit code
 * (128 + signal number when it was killed).
 */
function run(executable, args, env, extraEnv = {}, { detached = false, onSpawn } = {}) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      shell: false,
      stdio: "inherit",
      env: { ...env, ...extraEnv },
      detached,
    });
    const forward = (sig) => {
      try {
        if (detached) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        // already gone
      }
    };
    for (const sig of FORWARDED_SIGNALS) process.on(sig, forward);
    if (child.pid) onSpawn?.(child.pid);
    const cleanup = () => {
      for (const sig of FORWARDED_SIGNALS) process.off(sig, forward);
    };
    child.on("error", () => {
      cleanup();
      resolve(127);
    });
    child.on("exit", (code, signal) => {
      cleanup();
      resolve(code ?? 128 + (constants.signals[signal] ?? 0));
    });
  });
}

/** The whole runner; returns the exit code. Exported for the test's in-process seams. */
export async function main(argv = process.argv.slice(2), env = process.env) {
  const shellCommand = commandFrom(argv);
  const direct =
    argv[0] === "--exec" &&
    argv.length >= 2 &&
    argv[1].length > 0 &&
    argv.every((arg) => typeof arg === "string" && !arg.includes("\0"));
  if (!shellCommand && !direct) {
    process.stderr.write("usage: heavy-slot.mjs -- '<command>' | --exec <executable> [args…]\n");
    return 2;
  }
  // Only the Guard's single-command mode interprets Bash syntax. Direct argv is never rebuilt
  // for execution; the quoted representation below is solely for slot display/rerun instructions.
  const executable = direct ? argv[1] : shellPath();
  const args = direct ? argv.slice(2) : ["-c", shellCommand];
  const command = direct
    ? argv
        .slice(1)
        .map((arg) => `'${arg.replaceAll("'", `'\\''`)}'`)
        .join(" ")
    : shellCommand;
  const execute = (extraEnv = {}, options = {}) => run(executable, args, env, extraEnv, options);
  const cfg = ingressConfig(env);
  if (!cfg) return execute();

  let answer;
  try {
    answer = await post(
      cfg,
      { op: "acquire", command, cwd: process.cwd(), canWait: true },
      ACQUIRE_TIMEOUT_MS,
    );
  } catch (err) {
    process.stderr.write(
      `Shepherd: heavy-check slot unavailable (${err?.message ?? err}); running without it.\n`,
    );
    return execute();
  }

  while (
    answer?.decision === "queued" &&
    Number.isFinite(answer.waitUntil) &&
    answer.waitUntil > Date.now()
  ) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(1000, answer.waitUntil - Date.now())),
    );
    try {
      answer = await post(
        cfg,
        { op: "acquire", command, cwd: process.cwd(), canWait: true },
        ACQUIRE_TIMEOUT_MS,
      );
    } catch {
      break; // Keep the queued result; a polling failure must not start a second copy.
    }
  }

  if (answer?.decision === "queued" && typeof answer.message === "string") {
    process.stderr.write(`${answer.message}\n`);
    return EXIT_QUEUED;
  }
  const jobId = answer?.decision === "run" ? answer.jobId : undefined;
  if (typeof jobId !== "string") return execute(); // unmanaged, or an answer we don't know

  const darwin = process.platform === "darwin";
  const code = await execute(
    { SHEPHERD_HEAVY_JOB: jobId },
    {
      detached: darwin,
      onSpawn: darwin
        ? (pid) =>
            void post(cfg, { op: "started", jobId, pgid: pid }, REPORT_TIMEOUT_MS).catch(() => {})
        : undefined,
    },
  );
  await post(cfg, { op: "finished", jobId, exitCode: code }, REPORT_TIMEOUT_MS).catch(() => {});
  return code;
}

/** Same entry-point test as scripts/tool-guard.mjs (realpath both sides; see its comment). */
function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.exit(await main());
}
