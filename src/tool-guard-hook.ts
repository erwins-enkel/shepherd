import { resolve } from "node:path";
import { config } from "./config";
import { safeRealpath } from "./sandbox";

/**
 * Wiring for the PreToolUse tool guard (issue #2002) — the `--settings` hook fragment plus the host
 * paths a bwrap membrane has to bind for that hook to exist inside the sandbox.
 *
 * The guard itself is `scripts/tool-guard.mjs` (plain .mjs, pure rules + a stdin/stdout entry). It
 * replaces two permanently-resident prompt notices with a denial delivered at the call site.
 */

/** Absolute path of the guard script inside this Shepherd install (mirrors doc-agent's
 *  SERVER_INSTALL_ROOT derivation: this file lives in `src/`, the script one level up). */
const TOOL_GUARD_SCRIPT = resolve(import.meta.dir, "..", "scripts", "tool-guard.mjs");

/** Interpreter for the guard: the REALPATH of the node binary Shepherd already resolved. It must be
 *  the realpath, because that (via its bin dir) is what `nodeToolchainFlags` binds into the
 *  membrane — a symlink under a tmpfs'd `$HOME` would not resolve inside the sandbox. */
function toolGuardInterpreter(): string {
  return safeRealpath(config.nodeBin);
}

/** Single-quote a path for the hook's shell command (paths may contain spaces). */
function shellQuote(path: string): string {
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

/**
 * The `PreToolUse` entry for the spawn `--settings` overlay: one `command` hook on `Bash`, short
 * timeout, exit-0-with-JSON semantics (see scripts/tool-guard.mjs). Returns `{}` when the guard is
 * disabled, so the overlay JSON stays byte-identical to a pre-#2002 spawn.
 *
 * `matcher: "Bash"` is an exact tool-name match — every hazard the guard recognizes is a shell
 * command, so no other tool needs to pay the hook's process spawn.
 */
export function buildToolGuardFragment(
  opts: { interpreter?: string; scriptPath?: string; enabled?: boolean } = {},
): Record<string, unknown> {
  if (!(opts.enabled ?? config.toolGuard)) return {};
  const interpreter = opts.interpreter ?? toolGuardInterpreter();
  const script = opts.scriptPath ?? TOOL_GUARD_SCRIPT;
  return {
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [
          {
            type: "command",
            command: `${shellQuote(interpreter)} ${shellQuote(script)}`,
            timeout: 10,
          },
        ],
      },
    ],
  };
}

/**
 * Host paths that must exist INSIDE a bwrap membrane for the guard to run there (issue #2002).
 * `buildMembraneFlags` binds no part of the Shepherd checkout and tmpfs's `$HOME`, so without this
 * the hook command would silently fail inside a `standard`/`autonomous` session — and because the
 * decision to DROP the two notices from the prompt is taken host-side, that session would run with
 * neither the notice nor the deny. The interpreter is already bound (node toolchain), so only the
 * script is added here. Empty when the guard is off, keeping those flags byte-identical.
 */
export function toolGuardMembranePaths(enabled: boolean = config.toolGuard): string[] {
  return enabled ? [TOOL_GUARD_SCRIPT] : [];
}
