import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  HERDR_FIRST_STATUS_JSON_VERSION,
  baselineHerdrStubCommand,
  herdrStubCommand,
  herdrStubScript,
  outdatedHerdrVersion,
} from "../../ci/onboarding-harness/herdr-stub";
import { HERDR_MIN_VERSION } from "../../src/config";
import { HERDR_LAST_SUPPORTED_VERSION } from "../../src/herdr-capabilities";
import { probeHerdrRuntime } from "../../src/herdr-runtime";
import { compareSemver } from "../../src/semver";

/**
 * The harness's herdr stubs, executed against the REAL production liveness probe.
 *
 * This is the guard #2239 was missing: both stubs were hand-written one-liners that silently
 * stopped satisfying `probeHerdrRuntime` when #2216 taught it to parse `herdr status --json`, and
 * nothing noticed until the nightly ran three weeks later. Running the generated script through
 * the probe here moves that detection to a one-second unit test.
 */

const execFileAsync = promisify(execFile);
const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Plant a generated stub as an executable and hand back its path. */
function plant(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-herdr-stub-"));
  sandboxes.push(dir);
  const path = join(dir, "herdr");
  writeFileSync(path, `${herdrStubScript(version)}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("harness herdr stub", () => {
  test("the baseline stub reads as a live, current daemon", async () => {
    await expect(
      probeHerdrRuntime({ bin: plant(HERDR_LAST_SUPPORTED_VERSION), timeoutMs: 5_000 }),
    ).resolves.toEqual({
      state: "ready",
      installedVersion: HERDR_LAST_SUPPORTED_VERSION,
      serverVersion: HERDR_LAST_SUPPORTED_VERSION,
    });
  });

  // A `ready` liveness is what lets versionProbe reach its version comparison at all; the
  // ok/warning split from there is src/diagnostics.ts' own, covered in test/diagnostics.test.ts.
  test("the outdated stub reads as LIVE — outdated, never offline", async () => {
    const version = outdatedHerdrVersion();
    await expect(
      probeHerdrRuntime({ bin: plant(version), timeoutMs: 5_000 }),
    ).resolves.toMatchObject({ state: "ready", installedVersion: version });
  });

  test("the outdated stub's version stays below the floor the scenario asserts against", () => {
    expect(compareSemver(outdatedHerdrVersion(), HERDR_MIN_VERSION)).toBeLessThan(0);
  });

  // The baseline must sit at or above the floor, or the six scenarios that merely need a herdr
  // present would each carry an unseeded `warning` they never asked for.
  test("the baseline stub's version is at or above the floor", () => {
    expect(compareSemver(HERDR_LAST_SUPPORTED_VERSION, HERDR_MIN_VERSION)).toBeGreaterThanOrEqual(
      0,
    );
  });

  test("each stub carries the shape its version really had", () => {
    expect(compareSemver(outdatedHerdrVersion(), HERDR_FIRST_STATUS_JSON_VERSION)).toBeLessThan(0);
    // Legacy: no `status` command at all, and a plain-text --version line.
    expect(herdrStubScript(outdatedHerdrVersion())).toContain("unknown command: status");
    // Modern: a real status document, so the probe's modern path is the one exercised.
    expect(herdrStubScript(HERDR_FIRST_STATUS_JSON_VERSION)).toContain(
      '"endpoint_compatible":true',
    );
  });

  test("every response is valid JSON or a parseable version line", async () => {
    for (const version of [HERDR_LAST_SUPPORTED_VERSION, outdatedHerdrVersion()]) {
      const bin = plant(version);
      // The on-loop driver JSON.parses list/tabs/panes output unguarded — a non-JSON reply there
      // throws every tick.
      for (const args of [
        ["agent", "list"],
        ["tab", "list"],
        ["pane", "list"],
      ]) {
        const { stdout } = await execFileAsync(bin, args);
        expect(() => JSON.parse(stdout)).not.toThrow();
      }
      // Every --version consumer (boot preflight, herdr-update, probeLegacy, the harness's own
      // pin assertion) reads this through a semver regex, so plain text is fine — but the version
      // must be in there.
      const { stdout } = await execFileAsync(bin, ["--version"]);
      expect(stdout).toContain(version);
    }
  });

  test("the seed command installs the script and fail-closes on a bad write", () => {
    const command = baselineHerdrStubCommand();
    expect(command).toBe(herdrStubCommand(HERDR_LAST_SUPPORTED_VERSION));
    expect(command).toContain(herdrStubScript(HERDR_LAST_SUPPORTED_VERSION));
    expect(command).toContain('chmod +x "$HOME/.local/bin/herdr"');
    expect(command.trimEnd().endsWith('test -x "$HOME/.local/bin/herdr"')).toBe(true);
  });
});
