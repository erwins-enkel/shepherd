import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// #2693: a test-app.sh run with UI tests stops before xcodegen/xcodebuild when
// this Mac's UI Automation still asks for authentication; every other run
// reaches xcodebuild with exactly today's arguments.
const XCODEBUILD = [
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

// What `automationmodetool` does in each state; "missing" installs no stub at all.
const TOOL = {
  ready: 'echo "This device DOES NOT REQUIRE user authentication to enable Automation Mode."',
  prompts: 'echo "This device REQUIRES user authentication to enable Automation Mode."',
  failing: 'echo "automationmodetool: not permitted"\nexit 1',
  silent: "exit 0",
  missing: null,
} as const;
type State = keyof typeof TOOL;

describe("test-app.sh UI Automation preflight", () => {
  let directory: string;
  let bin: string;
  let log: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "ui-automation-"));
    bin = join(directory, "bin");
    log = join(directory, "log");
    mkdirSync(bin);
    mkdirSync(log);
    stub("xcodebuild", 'printf \'%s\\n\' "$@" > "$STUB_LOG/xcodebuild"');
    stub("xcodegen", 'echo "$@" >> "$STUB_LOG/xcodegen"');
    // No signing identity anywhere, so CODESIGN_ARGS stays empty on a Mac too.
    stub("security", "exit 1");
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  function stub(name: string, body: string) {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  }
  function run(state: State, args: string[], env: Record<string, string> = {}) {
    const tool = TOOL[state];
    if (tool !== null)
      stub("automationmodetool", `echo called >> "$STUB_LOG/automationmodetool"\n${tool}`);
    const result = Bun.spawnSync(["bash", resolve("native/scripts/test-app.sh"), ...args], {
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: directory, STUB_LOG: log, ...env },
    });
    const logged = (name: string) =>
      existsSync(join(log, name)) ? readFileSync(join(log, name), "utf8") : null;
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      xcodebuild: logged("xcodebuild")?.split("\n").slice(0, -1) ?? null,
      xcodegen: logged("xcodegen"),
      queried: logged("automationmodetool") !== null,
    };
  }

  test.each([
    ["without a filter", []],
    ["with CI's UI filter", ["-parallel-testing-enabled", "NO", "-only-testing:ShepherdUITests"]],
    [
      "with a UI class next to the unit bundle",
      ["-only-testing:ShepherdTests", "-only-testing:ShepherdUITests/LiveSmokeUITests"],
    ],
  ])("stops a prompting UI run %s before xcodegen and xcodebuild", (_, args) => {
    const result = run("prompts", args);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("UNMET:");
    expect(result.stderr).toContain(
      "automationmodetool enable-automationmode-without-authentication",
    );
    expect(result.stderr).toContain("native/scripts/test-app.sh -only-testing:ShepherdTests");
    expect(result.stderr).toContain("SHEPHERD_ALLOW_AUTOMATION_PROMPT=1");
    expect(result.xcodegen).toBeNull();
    expect(result.xcodebuild).toBeNull();
  });

  test.each([
    ["the unit bundle alone", ["-parallel-testing-enabled", "NO", "-only-testing:ShepherdTests"]],
    ["the UI bundle skipped", ["-skip-testing:ShepherdUITests"]],
  ])("runs %s without reading the state", (_, args) => {
    const result = run("prompts", args);
    expect(result.exitCode).toBe(0);
    expect(result.queried).toBe(false);
    expect(result.stderr).not.toContain("UI Automation");
    expect(result.xcodebuild).toEqual([...XCODEBUILD, ...args, "test"]);
  });

  test("runs a prompting UI run with SHEPHERD_ALLOW_AUTOMATION_PROMPT=1, warning", () => {
    const args = ["-only-testing:ShepherdUITests"];
    const result = run("prompts", args, { SHEPHERD_ALLOW_AUTOMATION_PROMPT: "1" });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("warning:");
    expect(result.stderr).not.toContain("UNMET:");
    expect(result.xcodebuild).toEqual([...XCODEBUILD, ...args, "test"]);
  });

  test("runs a UI run silently on a set-up Mac", () => {
    const result = run("ready", []);
    expect(result.exitCode).toBe(0);
    expect(result.queried).toBe(true);
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/automation/i);
    expect(result.xcodebuild).toEqual([...XCODEBUILD, "test"]);
  });

  function expectWarnedRun(state: State) {
    const result = run(state, []);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("warning:");
    expect(result.stderr).not.toContain("UNMET:");
    expect(result.xcodebuild).toEqual([...XCODEBUILD, "test"]);
  }

  test.each([
    ["exits non-zero", "failing"],
    ["prints nothing", "silent"],
  ] as const)("runs a UI run with a warning when the tool %s", (_, state) => {
    expectWarnedRun(state);
  });

  // On a Mac the real /usr/bin/automationmodetool cannot be hidden through PATH;
  // the two cases above still cover the unreadable state there.
  test.skipIf(Bun.which("automationmodetool") !== null)(
    "runs a UI run with a warning when the tool is missing",
    () => {
      expectWarnedRun("missing");
    },
  );
});
