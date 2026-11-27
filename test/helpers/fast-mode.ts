import { DISABLE_FAST_MODE_ENV } from "../../src/claude-fast-mode";
import { buildWrappedArgv, type HerdrStartOptions } from "../../src/herdr";

/**
 * The `CLAUDE_CODE_DISABLE_FAST_MODE` value the process spawned from a captured `herdr.start`
 * call ends up with (#4244), or null when it has none. Runs the real `buildWrappedArgv`, so it
 * sees the herdr shim pin too. For a bwrap argv only the membrane's `--setenv` after `--clearenv`
 * counts (the outer shim is wiped); otherwise the shim's last assignment before the command wins.
 */
export function fastModeOffValue(
  argv: string[],
  env?: Record<string, string>,
  opts?: HerdrStartOptions,
): string | null {
  const w = buildWrappedArgv(argv, env, opts);
  let value: string | null = null;
  const bwrap = w.indexOf("bwrap");
  if (bwrap >= 0) {
    const clear = w.indexOf("--clearenv", bwrap);
    const end = w.indexOf("--", bwrap);
    if (clear < 0) return null;
    for (let i = clear; i < end; i++) {
      if (w[i] === "--setenv" && w[i + 1] === DISABLE_FAST_MODE_ENV) value = w[i + 2]!;
    }
    return value;
  }
  for (const t of w.slice(0, w.indexOf(argv[0]!))) {
    if (t.startsWith(`${DISABLE_FAST_MODE_ENV}=`))
      value = t.slice(DISABLE_FAST_MODE_ENV.length + 1);
  }
  return value;
}
