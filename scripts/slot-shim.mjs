#!/usr/bin/env node
// PATH shim that routes a Codex session's heavy checks through the heavy-check slot (#3550).
//
// Codex has no PreToolUse rewrite hook the way Claude does (scripts/tool-guard.mjs), so Shepherd
// puts a directory of tiny `sh` shims for `bun`/`cargo`/`vitest`/… first on the Codex session's
// PATH. Each one runs this file as `slot-shim.mjs <tool> <args…>`:
//   - heavy (the SAME detection as the guard: isHeavyCommand) → the heavy-slot runner, which asks
//     the server for the slot, queues with exit 75, or runs the command with SHEPHERD_HEAVY_JOB set;
//   - anything else → the real binary, untouched.
// Inside the runner SHEPHERD_HEAVY_JOB is set, so the nested `bun` it starts passes straight through.
//
// Every failure FAILS OPEN to the real binary: a broken shim must never stop an agent working.

import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, realpathSync, statSync } from "node:fs";
import { constants } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main as runSlot } from "./heavy-slot.mjs";
import { isHeavyCommand } from "./tool-guard.mjs";

/** POSIX single-quote one word for heavy-command detection (never for execution). */
export function shellQuote(word) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/** First executable `tool` on `path`, skipping `skipDir` (the shim dir itself). */
export function findReal(tool, path, skipDir) {
  const skip = skipDir ? safeReal(skipDir) : null;
  for (const dir of (path ?? "").split(delimiter)) {
    if (!dir || (skip && safeReal(dir) === skip)) continue;
    const candidate = join(dir, tool);
    try {
      if (statSync(candidate).isFile()) {
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      }
    } catch {
      // not here
    }
  }
  return null;
}

function safeReal(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function execReal(file, args, env) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: "inherit", env });
    const forward = (sig) => child.kill(sig);
    const sigs = ["SIGINT", "SIGTERM", "SIGHUP"];
    for (const sig of sigs) process.on(sig, forward);
    child.on("error", () => resolve(127));
    child.on("exit", (code, signal) => {
      for (const sig of sigs) process.off(sig, forward);
      resolve(code ?? 128 + (constants.signals[signal] ?? 0));
    });
  });
}

/**
 * The whole shim; returns the exit code. `shimDir` is the directory the shim lives in (stripped
 * from PATH before the real binary is looked up). Seams are injectable for the unit tests.
 */
export async function main(argv, env = process.env, deps = {}) {
  const [tool, ...args] = argv;
  if (!tool) {
    process.stderr.write("usage: slot-shim.mjs <tool> [args…]\n");
    return 2;
  }
  const shimDir = deps.shimDir ?? env.SHEPHERD_SLOT_SHIM_DIR ?? null;
  const real = (deps.findReal ?? findReal)(tool, env.PATH, shimDir);
  if (!real) {
    process.stderr.write(`${tool}: command not found\n`);
    return 127;
  }
  // Child processes must not see the shim dir first again, or a script's nested `bun` re-enters it.
  const cleanPath = (env.PATH ?? "")
    .split(delimiter)
    .filter((d) => d && !(shimDir && safeReal(d) === safeReal(shimDir)))
    .join(delimiter);
  const childEnv = { ...env, PATH: cleanPath };
  const run = deps.execReal ?? execReal;

  const managed =
    !env.SHEPHERD_HEAVY_JOB &&
    env.SHEPHERD_SESSION_ID &&
    env.SHEPHERD_AGENT_API_URL &&
    env.SHEPHERD_INGRESS_HEADER_FILE;
  if (managed) {
    try {
      const command = [tool, ...args].map(shellQuote).join(" ");
      if ((deps.isHeavy ?? isHeavyCommand)(command, process.cwd())) {
        return await (deps.runSlot ?? runSlot)(["--exec", real, ...args], childEnv);
      }
    } catch {
      // fail open to the real binary
    }
  }
  return run(real, args, childEnv);
}

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
  process.exit(await main(process.argv.slice(2)));
}
