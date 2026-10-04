import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// #2693: a test-app.sh run that includes the UI bundle stops before xcodebuild
// when macOS would ask to "Enable UI Automation". Everything else reaches
// xcodebuild with exactly the arguments it always had.
const XCODEBUILD_ARGS = [
  "-project",
  "Shepherd.xcodeproj",
  "-scheme",
  "Shepherd",
  "-configuration",
  "Debug",
  "-destination",
  "platform=macOS",
  "-derivedDataPath",
  ".build",
  "-skipPackagePluginValidation",
  "-packageAuthorizationProvider",
  "netrc",
  "-scmProvider",
  "system",
];

// Bodies for the automationmodetool stub; `null` leaves the tool off PATH.
const READY =
  "printf 'Automation Mode is disabled.\\nThis device DOES NOT REQUIRE user authentication to enable Automation Mode.\\n'";
const PROMPTS =
  "printf 'Automation Mode is disabled.\\nThis device REQUIRES user authentication to enable Automation Mode.\\n'";
const FAILS = "printf 'Automation Mode status is unavailable.\\n'; exit 1";
const SILENT = "exit 0";

describe("test-app.sh UI automation preflight", () => {
  let directory: string;
  let stubs: string;
  let tools: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "automation-preflight-"));
    stubs = join(directory, "stubs");
    tools = join(directory, "tools");
    mkdirSync(stubs);
    mkdirSync(tools);
    // Only what the script needs besides the stubs: on a Mac, the system PATH
    // would bring the real automationmodetool, xcodebuild and `security`.
    for (const tool of ["dirname", "grep", "head", "awk"]) {
      symlinkSync(Bun.which(tool)!, join(tools, tool));
    }
    stub("xcodegen", `printf 'generate\\n' >> '${directory}/xcodegen.log'`);
    stub("xcodebuild", `printf '%s\\n' "$@" > '${directory}/xcodebuild.log'`);
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function stub(name: string, body: string) {
    const path = join(stubs, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  }

  function run(tool: string | null, args: string[], env: Record<string, string> = {}) {
    if (tool !== null) {
      stub(
        "automationmodetool",
        `printf 'called\\n' >> '${directory}/automationmodetool.log'\n${tool}`,
      );
    }
    const result = Bun.spawnSync(
      [Bun.which("bash")!, resolve("native/scripts/test-app.sh"), ...args],
      {
        env: { PATH: `${stubs}:${tools}`, HOME: directory, ...env },
      },
    );
    const log = (name: string) => {
      const path = join(directory, `${name}.log`);
      return existsSync(path) ? readFileSync(path, "utf8").trimEnd().split("\n") : null;
    };
    return {
      exitCode: result.exitCode,
      stderr: result.stderr.toString(),
      xcodebuild: log("xcodebuild"),
      xcodegen: log("xcodegen"),
      queried: log("automationmodetool") !== null,
    };
  }

  test.each([
    ["without a filter", []],
    [
      "with -only-testing:ShepherdUITests",
      ["-parallel-testing-enabled", "NO", "-only-testing:ShepherdUITests"],
    ],
    [
      "with one UI test next to the unit bundle",
      ["-only-testing:ShepherdTests", "-only-testing:ShepherdUITests/SmokeUITests"],
    ],
  ])("stops before Xcode when the Mac prompts, %s", (_, args) => {
    const result = run(PROMPTS, args);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("UNMET:");
    expect(result.stderr).toContain(
      "automationmodetool enable-automationmode-without-authentication",
    );
    expect(result.stderr).toContain("-only-testing:ShepherdTests");
    expect(result.stderr).toContain("SHEPHERD_ALLOW_AUTOMATION_PROMPT=1");
    expect(result.xcodegen).toBeNull();
    expect(result.xcodebuild).toBeNull();
  });

  test.each([
    [
      "-only-testing:ShepherdTests",
      ["-parallel-testing-enabled", "NO", "-only-testing:ShepherdTests"],
    ],
    ["-skip-testing:ShepherdUITests", ["-skip-testing:ShepherdUITests"]],
  ])("never asks for the status of a run without UI tests (%s)", (_, args) => {
    const result = run(PROMPTS, args);
    expect(result.exitCode).toBe(0);
    expect(result.queried).toBe(false);
    expect(result.stderr).toBe("");
    expect(result.xcodebuild).toEqual([...XCODEBUILD_ARGS, ...args, "test"]);
  });

  test("lets a supervised run through with a warning when the override is set", () => {
    const args = ["-only-testing:ShepherdUITests"];
    const result = run(PROMPTS, args, { SHEPHERD_ALLOW_AUTOMATION_PROMPT: "1" });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("warning:");
    expect(result.stderr).not.toContain("UNMET:");
    expect(result.xcodebuild).toEqual([...XCODEBUILD_ARGS, ...args, "test"]);
  });

  test("runs silently on a Mac that is set up", () => {
    const args = ["-parallel-testing-enabled", "NO", "-only-testing:ShepherdUITests"];
    const result = run(READY, args);
    expect(result.exitCode).toBe(0);
    expect(result.queried).toBe(true);
    expect(result.stderr).toBe("");
    expect(result.xcodebuild).toEqual([...XCODEBUILD_ARGS, ...args, "test"]);
  });

  test.each([
    ["is missing", null],
    ["exits non-zero", FAILS],
    ["prints nothing", SILENT],
  ])("warns and carries on when the status tool %s", (_, tool) => {
    const result = run(tool, []);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("warning:");
    expect(result.stderr).not.toContain("UNMET:");
    expect(result.xcodebuild).toEqual([...XCODEBUILD_ARGS, "test"]);
  });
});
