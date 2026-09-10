import { HERDR_MIN_VERSION } from "../../src/config";
import { HERDR_LAST_SUPPORTED_VERSION } from "../../src/herdr-capabilities";
import { compareSemver } from "../../src/semver";

/**
 * Generates the network-free `herdr` STUBs the harness plants on PATH, in the two shapes the
 * PRODUCTION liveness probe (`probeHerdrRuntime`, src/herdr-runtime.ts) actually distinguishes.
 *
 * Why this module exists: until #2216 diagnostics' liveness was `herdr agent list` with the exit
 * code as its only signal, so a stub that echoed one `{"version":"…"}` line for every invocation
 * satisfied it. #2216 made the probe run `herdr status --json` FIRST and parse the document, at
 * which point that one-line stub started parsing as a status document with no `client`/`server`
 * keys — `unknown`, i.e. `error` (offline-ish), never the below-floor `warning` the
 * `herdr-outdated` scenario asserts (#2239). Both stubs were hand-written, so nothing failed until
 * the nightly ran three weeks later.
 *
 * So the shape is derived from the version, and the generated script is proven against the real
 * probe in test/onboarding-harness/herdr-stub.test.ts rather than trusted by eye.
 */

/** First herdr version that answers `status --json`. Below it the CLI has no `status` command at
 *  all, which is why production keeps a fallback — see `probeLegacy` in src/herdr-runtime.ts
 *  ("v0.8 and earlier have no `status` command") and docs/herdr-compat/0.9.0.md. */
export const HERDR_FIRST_STATUS_JSON_VERSION = "0.9.0";

/** The version the `herdr-outdated` scenario's stub reports: one release line below
 *  {@link HERDR_MIN_VERSION}, DERIVED so a floor bump can never quietly turn that scenario's
 *  seeded defect into a healthy herdr. Prefers a patch step down and falls back to a minor, which
 *  keeps it a version that could plausibly exist rather than a synthetic `0.0.x`. */
export function outdatedHerdrVersion(): string {
  const [major = 0, minor = 0, patch = 0] = HERDR_MIN_VERSION.split(".").map((n) => Number(n) || 0);
  if (patch > 0) return `${major}.${minor}.${patch - 1}`;
  if (minor > 0) return `${major}.${minor - 1}.0`;
  if (major > 0) return `${major - 1}.0.0`;
  throw new Error(`cannot derive a version below HERDR_MIN_VERSION ${HERDR_MIN_VERSION}`);
}

/** The `herdr status --json` document a healthy modern daemon returns, in the shape
 *  `parseHerdrRuntimeStatus` (src/herdr-runtime.ts) reads: client and server on the same version,
 *  server running, both compatibility flags true. Anything less classifies as `unknown`. */
function readyStatusDocument(version: string): string {
  return JSON.stringify({
    client: { version },
    server: { running: true, version, compatible: true, endpoint_compatible: true },
  });
}

/**
 * The `#!/bin/sh` body of a stub reporting `version`.
 *
 * Modern (≥ {@link HERDR_FIRST_STATUS_JSON_VERSION}): `status --json` returns a ready document, so
 * the probe's modern path continues to its `agent list` function check, which the catch-all
 * answers.
 *
 * Legacy (below it): `status` fails the way a CLI without that command does, sending the probe
 * down `probeLegacy` (`agent list` + `--version`) — the real path a live-but-old herdr takes, and
 * the one that makes `herdr-outdated` read outdated rather than offline.
 *
 * The catch-all is load-bearing in BOTH shapes: it exits 0 (the probe's liveness evidence) and
 * emits valid JSON, because the on-loop `HerdrDriver.list()/tabs()/panes()` do an UNGUARDED
 * `JSON.parse` then `parsed?.result?.… ?? []`. Plain text there would throw every tick.
 * `--version`, by contrast, answers the way herdr really does — a plain line — which is safe
 * because every consumer (boot preflight, herdr-update's version runner, `probeLegacy`,
 * diagnostics, and the harness's own pin assertion) reads it through a semver regex and none of
 * them JSON-parses it.
 */
export function herdrStubScript(version: string): string {
  const legacy = compareSemver(version, HERDR_FIRST_STATUS_JSON_VERSION) < 0;
  const status = legacy
    ? ["  echo 'unknown command: status' >&2", "  exit 2"]
    : [`  echo '${readyStatusDocument(version)}'`, "  exit 0"];
  return [
    "#!/bin/sh",
    'if [ "$1" = "status" ]; then',
    ...status,
    "fi",
    'if [ "$1" = "--version" ]; then',
    `  echo 'herdr ${version}'`,
    "  exit 0",
    "fi",
    "echo '{\"result\":{}}'",
    "exit 0",
  ].join("\n");
}

/** The seed COMMAND that installs {@link herdrStubScript} at `~/.local/bin/herdr`. The trailing
 *  `test -x` gives the command a non-zero exit when the write didn't land — load-bearing in the
 *  BASELINE, whose steps are checked (a bad write fail-closes the seed rather than booting a
 *  scenario against a herdr that isn't there); scenario seeds tolerate non-zero by design. */
export function herdrStubCommand(version: string): string {
  return [
    'mkdir -p "$HOME/.local/bin"',
    "cat > \"$HOME/.local/bin/herdr\" <<'HERDR_STUB'",
    herdrStubScript(version),
    "HERDR_STUB",
    'chmod +x "$HOME/.local/bin/herdr"',
    'test -x "$HOME/.local/bin/herdr"',
  ].join("\n");
}

/**
 * The baseline stub every scenario starts from. It exists so Shepherd's boot preflight
 * (`herdr --version`) passes without a live `herdr.dev` fetch: since #1313 a MISSING herdr
 * fail-fasts (exit 78) before the HTTP server binds, so the scenarios that don't test herdr still
 * need one present.
 *
 * It reports HERDR_LAST_SUPPORTED_VERSION, derived — never hardcoded. It used to report
 * `99.99.99`, which was fine until #1887 added the support CEILING: from then on the baseline
 * represented a herdr Shepherd REFUSES to drive, so every scenario booted with an `unsupported`
 * check and an UNSUPPORTED preflight banner. Deriving it means a ceiling bump can't reintroduce
 * that drift — and the same reasoning is why the SHAPE is generated rather than hand-written.
 */
export function baselineHerdrStubCommand(): string {
  return herdrStubCommand(HERDR_LAST_SUPPORTED_VERSION);
}
