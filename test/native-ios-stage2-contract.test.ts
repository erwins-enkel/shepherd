import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

describe("native iOS acceptance tools", () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "ios-gates-"));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const python = (script: string, ...args: string[]) =>
    Bun.spawnSync(["python3", resolve("native/scripts", script), ...args]);
  function json(name: string, value: unknown) {
    const path = join(directory, name);
    writeFileSync(path, JSON.stringify(value));
    return path;
  }
  for (const kind of ["pass", "zero", "skip", "malformed"]) {
    test(`result inventory ${kind}`, () => {
      const fixture = JSON.parse(
        readFileSync(`test/fixtures/native-ios-stage2-results-${kind}.json`, "utf8"),
      );
      const result = python(
        "check-ios-results.py",
        json("summary.json", fixture.summary),
        json("tests.json", fixture.tests),
        "--expected",
        json("expected.json", fixture.expected),
      );
      expect(result.exitCode === 0).toBe(kind === "pass");
    });
  }
  for (const resultState of ["Passed", "Failed", "Skipped"]) {
    test(`UI test bundle preserves ${resultState} case results`, () => {
      const fixture = JSON.parse(
        readFileSync("test/fixtures/native-ios-stage2-results-pass.json", "utf8"),
      );
      fixture.tests.testNodes[0].result = resultState;
      const tests = {
        testNodes: [
          {
            nodeType: "Test Plan",
            result: "Passed",
            children: [
              { nodeType: "UI test bundle", result: "Passed", children: fixture.tests.testNodes },
            ],
          },
        ],
      };
      const result = python(
        "check-ios-results.py",
        json("summary.json", fixture.summary),
        json("tests.json", tests),
        "--expected",
        json("expected.json", fixture.expected),
      );
      expect(result.exitCode === 0).toBe(resultState === "Passed");
    });
  }
  for (const resultState of ["Passed", "Failed", "Skipped"]) {
    test(`runtime warnings preserve ${resultState} case results`, () => {
      const fixture = JSON.parse(
        readFileSync("test/fixtures/native-ios-stage2-results-pass.json", "utf8"),
      );
      fixture.tests.testNodes[0].result = resultState;
      fixture.tests.testNodes[0].children = [
        {
          nodeType: "Runtime Warning",
          name: "Accessing State outside a hosted View",
          sourceLocation: { filePath: "Fixture.swift", lineNumber: 1 },
        },
      ];
      const result = python(
        "check-ios-results.py",
        json("summary.json", fixture.summary),
        json("tests.json", fixture.tests),
        "--expected",
        json("expected.json", fixture.expected),
      );
      expect(result.exitCode === 0).toBe(resultState === "Passed");
    });
  }
  test("names the failing assertion file:line from the xcresult tree", () => {
    const fixture = JSON.parse(
      readFileSync("test/fixtures/native-ios-stage2-results-pass.json", "utf8"),
    );
    fixture.summary = { ...fixture.summary, passedTests: 0, failedTests: 1 };
    fixture.tests.testNodes[0].result = "Failed";
    fixture.tests.testNodes[0].children = [
      { nodeType: "Failure Message", name: "IOSFixtureTests.swift:12: XCTAssertTrue failed" },
    ];
    const run = (tests: unknown, summary: unknown) =>
      python(
        "check-ios-results.py",
        json("summary.json", summary),
        json("tests.json", tests),
        "--expected",
        json("expected.json", fixture.expected),
      );
    const failed = run(fixture.tests, fixture.summary);
    expect(failed.exitCode).not.toBe(0);
    expect(failed.stderr.toString()).toContain(
      "FAILURE: IOSFixtureTests/testFlow(): IOSFixtureTests.swift:12: XCTAssertTrue failed",
    );
    const pass = JSON.parse(
      readFileSync("test/fixtures/native-ios-stage2-results-pass.json", "utf8"),
    );
    expect(run(pass.tests, pass.summary).stderr.toString()).not.toContain("FAILURE:");
  });
  test("rejects passing counts when a required identity never executed", () => {
    const fixture = JSON.parse(
      readFileSync("test/fixtures/native-ios-stage2-results-pass.json", "utf8"),
    );
    const result = python(
      "check-ios-results.py",
      json("summary.json", fixture.summary),
      json("tests.json", fixture.tests),
      "--expected",
      json("expected.json", [...fixture.expected, "Missing/testMissing"]),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("identity");
  });
  for (const family of ["iPhone", "iPad"]) {
    test(`selects newest available ${family} without crossing families`, () => {
      const devices = {
        devices: {
          "com.apple.CoreSimulator.SimRuntime.iOS-18-9": [
            { name: `${family} Old`, udid: "OLD", isAvailable: true },
          ],
          "com.apple.CoreSimulator.SimRuntime.iOS-18-10": [
            { name: "iPhone 17", udid: "PHONE", isAvailable: true },
            { name: "iPad Pro (12.9-inch)", udid: "PAD", isAvailable: true },
            { name: `${family} Unavailable`, udid: "BAD", isAvailable: false },
          ],
        },
      };
      const result = python(
        "select-ios-simulator.py",
        json("devices.json", devices),
        "--family",
        family,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString().trim()).toBe(family === "iPhone" ? "PHONE" : "PAD");
    });
  }
  test("does not substitute ordinary iPhones for unavailable Duo hardware", () => {
    const path = json("devices.json", {
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-27-1": [
          { name: "iPhone 17", udid: "PHONE", isAvailable: true },
        ],
      },
    });
    const result = python("select-ios-simulator.py", path, "--family", "DuoInner");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toBe("");
  });
  for (const bootExit of [0, 17]) {
    test(`simulator readiness gates test launch (boot exit ${bootExit})`, () => {
      const scripts = join(directory, "native/scripts");
      const bin = join(directory, "bin");
      mkdirSync(scripts, { recursive: true });
      mkdirSync(join(directory, "native/Apps/ShepherdIOS"), { recursive: true });
      mkdirSync(bin);
      for (const script of ["test-ios-app.sh", "select-ios-simulator.py"]) {
        cpSync(resolve("native/scripts", script), join(scripts, script));
      }
      // Result validation has its own fixture tests; preserve xcodebuild's exit here.
      writeFileSync(join(scripts, "check-ios-results.py"), "pass\n");
      const log = join(directory, "commands.log");
      writeFileSync(log, "");
      const devices = json("devices.json", {
        devices: {
          "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
            { name: "iPad (A16)", udid: "PAD", state: "Shutdown", isAvailable: true },
          ],
        },
      });
      const executables = {
        xcodegen: "#!/bin/bash\nexit 0\n",
        xcrun: `#!/bin/bash
if [[ "$1 $2" == "simctl list" ]]; then cat "$IOS_DEVICE_FILE"
elif [[ "$1 $2" == "simctl bootstatus" ]]; then
  echo "bootstatus $3 $4" >> "$IOS_TEST_LOG"
  exit "$IOS_BOOT_EXIT"
else echo '{}'
fi
`,
        xcodebuild: `#!/bin/bash
echo xcodebuild >> "$IOS_TEST_LOG"
mkdir -p "$IOS_TEST_RESULT"
exit 23
`,
      };
      for (const [name, source] of Object.entries(executables)) {
        const executable = join(bin, name);
        writeFileSync(executable, source);
        chmodSync(executable, 0o755);
      }
      const resultPath = join(directory, "result.xcresult");
      const result = Bun.spawnSync(
        [
          "bash",
          join(scripts, "test-ios-app.sh"),
          "ui",
          "--family",
          "iPad",
          "--result-bundle-path",
          resultPath,
        ],
        {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            TMPDIR: directory,
            IOS_DEVICE_FILE: devices,
            IOS_TEST_LOG: log,
            IOS_TEST_RESULT: resultPath,
            IOS_BOOT_EXIT: String(bootExit),
          },
        },
      );
      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(
        bootExit === 0 ? ["bootstatus PAD -b", "xcodebuild"] : ["bootstatus PAD -b"],
      );
      expect(result.exitCode).toBe(bootExit || 23);
    });
  }

  // Runs a native/scripts entry point against fake Xcode tools; returns each xcodebuild argv.
  function xcodebuildArgs(
    script: string,
    args: string[],
    env: Record<string, string> = {},
    xctestruns = ["ShepherdIOS_iphonesimulator26.5-arm64.xctestrun"],
  ) {
    const scripts = join(directory, "native/scripts");
    const bin = join(directory, "bin");
    const products = join(directory, "native/Apps/ShepherdIOS/.build/Build/Products");
    mkdirSync(scripts, { recursive: true });
    mkdirSync(products, { recursive: true });
    for (const name of xctestruns) writeFileSync(join(products, name), "");
    mkdirSync(bin, { recursive: true });
    for (const name of [script, "select-ios-simulator.py"])
      cpSync(resolve("native/scripts", name), join(scripts, name));
    writeFileSync(join(scripts, "check-ios-results.py"), "pass\n");
    const log = join(directory, "xcodebuild.log");
    writeFileSync(log, "");
    const devices = json("devices.json", {
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
          { name: "iPhone 17", udid: "PHONE", state: "Booted", isAvailable: true },
        ],
      },
    });
    const resultPath = join(directory, "result.xcresult");
    const executables = {
      xcodegen: "#!/bin/bash\nexit 0\n",
      xcrun: `#!/bin/bash\nif [[ "$1 $2" == "simctl list" ]]; then cat "$IOS_DEVICE_FILE"; else echo '{}'; fi\n`,
      xcodebuild: `#!/bin/bash\necho "$*" >> "$IOS_TEST_LOG"\nmkdir -p "$IOS_TEST_RESULT"\n`,
    };
    for (const [name, source] of Object.entries(executables)) {
      writeFileSync(join(bin, name), source);
      chmodSync(join(bin, name), 0o755);
    }
    const result = Bun.spawnSync(["bash", join(scripts, script), ...args], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        TMPDIR: directory,
        IOS_DEVICE_FILE: devices,
        IOS_TEST_LOG: log,
        IOS_TEST_RESULT: resultPath,
        SHEPHERD_IOS_SIMULATOR_SIGNING: "0",
        ...env,
      },
    });
    const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    return { result, calls: calls.map((line) => line.split(" ")) };
  }

  for (const [flags, action] of [
    [[], "test"],
    [["--without-building"], "test-without-building"],
  ] as const) {
    test(`test-ios-app.sh ${flags.join(" ") || "(default)"} runs xcodebuild ${action}`, () => {
      const resultPath = join(directory, "result.xcresult");
      const { result, calls } = xcodebuildArgs("test-ios-app.sh", [
        "unit",
        ...flags,
        "--result-bundle-path",
        resultPath,
      ]);
      expect(result.stderr.toString()).not.toContain("UNMET");
      expect(result.exitCode).toBe(0);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.at(-1)).toBe(action);
      expect(calls[0]!.join(" ")).toContain("platform=iOS Simulator,id=PHONE");
      // #3354: without building, run the build's .xctestrun and skip loading the project.
      const xctestrun = calls[0]!.indexOf("-xctestrun");
      if (action === "test") {
        expect(xctestrun).toBe(-1);
        expect(calls[0]).toContain("-project");
      } else {
        expect(calls[0]![xctestrun + 1]).toEndWith(
          "/.build/Build/Products/ShepherdIOS_iphonesimulator26.5-arm64.xctestrun",
        );
        expect(calls[0]).not.toContain("-project");
        expect(calls[0]).toContain("-only-testing:ShepherdIOSTests");
      }
    });
  }

  for (const [label, files] of [
    ["no", []],
    ["two", ["A.xctestrun", "B.xctestrun"]],
  ] as const) {
    test(`test-ios-app.sh --without-building refuses ${label} .xctestrun files`, () => {
      const { result, calls } = xcodebuildArgs(
        "test-ios-app.sh",
        ["unit", "--without-building", "--result-bundle-path", join(directory, "result.xcresult")],
        {},
        [...files],
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain("UNMET:");
      expect(calls).toEqual([]);
    });
  }

  test("build-ios-app.sh --for-testing builds test bundles for the host architecture only", () => {
    const arch = Bun.spawnSync(["uname", "-m"]).stdout.toString().trim();
    const plain = xcodebuildArgs("build-ios-app.sh", ["Debug"]);
    expect(plain.result.exitCode).toBe(0);
    expect(plain.calls[0]!.at(-1)).toBe("build");
    expect(plain.calls[0]!.some((token) => token.startsWith("ARCHS="))).toBe(false);
    const forTesting = xcodebuildArgs("build-ios-app.sh", ["Debug", "--for-testing"]);
    expect(forTesting.result.exitCode).toBe(0);
    const call = forTesting.calls.at(-1)!;
    expect(call.at(-1)).toBe("build-for-testing");
    expect(call).toContain(`ARCHS=${arch}`);
    expect(call.join(" ")).toContain("generic/platform=iOS Simulator");
    const unknown = xcodebuildArgs("build-ios-app.sh", ["Debug", "--bogus"]);
    expect(unknown.result.exitCode).not.toBe(0);
    expect(unknown.result.stderr.toString()).toContain("UNMET:");
  });

  // `test-without-building` signs nothing, so the Xcode 27 ad-hoc opt-in must reach the build.
  test("build-ios-app.sh honours the simulator signing opt-in", () => {
    const unsigned = xcodebuildArgs("build-ios-app.sh", ["Debug", "--for-testing"]).calls[0]!;
    expect(unsigned).toContain("CODE_SIGNING_ALLOWED=NO");
    const signed = xcodebuildArgs("build-ios-app.sh", ["Debug", "--for-testing"], {
      SHEPHERD_IOS_SIMULATOR_SIGNING: "1",
    }).calls[0]!;
    expect(signed).not.toContain("CODE_SIGNING_ALLOWED=NO");
    for (const setting of [
      "CODE_SIGNING_ALLOWED=YES",
      "CODE_SIGN_STYLE=Manual",
      "CODE_SIGN_IDENTITY=-",
    ])
      expect(signed).toContain(setting);
  });

  test("ui/messages-only PRs don't start the iOS workflow; contract and native edits still do", () => {
    const workflow = Bun.YAML.parse(readFileSync(".github/workflows/native-ios.yml", "utf8")) as {
      on: Record<"pull_request" | "push", { paths: string[] }>;
      jobs: { ios: { steps: { run?: string }[] } };
    };
    // #2709: the Linux `static` lane owns the catalog check on every PR.
    for (const event of ["pull_request", "push"] as const) {
      expect(workflow.on[event].paths).not.toContain("ui/messages/*.json");
      expect(workflow.on[event].paths).toContain("native/**");
      expect(workflow.on[event].paths).toContain("contracts/**");
    }
    expect(
      workflow.jobs.ios.steps.some((step) => step.run?.includes("bun run check:strings")),
    ).toBe(true);
  });
  test("CI builds once and rebuilds nothing; iPad UI only on push or ci:full-native", () => {
    const workflow = Bun.YAML.parse(readFileSync(".github/workflows/native-ios.yml", "utf8")) as {
      env: Record<string, string>;
      jobs: { ios: { steps: { name?: string; if?: string; run?: string }[] } };
    };
    expect(workflow.env.FULL_NATIVE).toContain("github.event_name == 'push'");
    expect(workflow.env.FULL_NATIVE).toContain("'ci:full-native'");
    const steps = workflow.jobs.ios.steps;
    const builds = steps.filter((step) => step.run?.includes("build-ios-app.sh"));
    expect(builds).toHaveLength(1);
    expect(builds[0]!.run).toContain("build-ios-app.sh Debug --for-testing");
    const tests = steps.filter((step) => step.run?.includes("test-ios-app.sh"));
    expect(
      tests.map((step) => step.run!.match(/test-ios-app\.sh (unit|ui --family \w+)/)?.[1]),
    ).toEqual(["unit", "ui --family iPhone", "ui --family iPad"]);
    for (const step of tests) expect(step.run).toContain("--without-building");
    const full = "env.FULL_NATIVE == 'true'";
    expect(tests[0]!.if).toBeUndefined();
    expect(tests[1]!.if).toBeUndefined();
    expect(tests[2]!.if).toBe(full);
    // The iPad simulator boots with the iPhone one shut down, never beside it.
    const ipad = steps.indexOf(tests[2]!);
    expect(steps[ipad - 1]!.run).toContain("xcrun simctl shutdown all");
    expect(steps[ipad - 1]!.if).toBe(full);
  });
  test("rejects unsigned release export inputs before invoking Xcode", () => {
    const result = Bun.spawnSync(
      ["bash", resolve("native/scripts/archive-ios-app.sh"), "Release"],
      { env: { PATH: process.env.PATH!, HOME: directory } },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("UNMET:");
  });
  test("rejects automatic signing, unrelated profiles and upload destinations before invoking Xcode", () => {
    for (const invalid of ["automatic", "wrong-profile", "upload"]) {
      const options = join(directory, `${invalid}.plist`);
      const fixture = Bun.spawnSync([
        "python3",
        "-c",
        "import plistlib, sys; plistlib.dump(dict(method='app-store-connect', destination='upload' if sys.argv[2]=='upload' else 'export', teamID='TEAM', signingStyle='automatic' if sys.argv[2]=='automatic' else 'manual', signingCertificate='Apple Distribution', provisioningProfiles={'run.shepherd.ios': 'OTHER' if sys.argv[2]=='wrong-profile' else 'PROFILE'}, manageAppVersionAndBuildNumber=False), open(sys.argv[1], 'wb'))",
        options,
        invalid,
      ]);
      expect(fixture.exitCode).toBe(0);
      const result = Bun.spawnSync(
        ["bash", resolve("native/scripts/archive-ios-app.sh"), "Release"],
        {
          env: {
            PATH: process.env.PATH!,
            HOME: directory,
            GITHUB_ACTIONS: "true",
            RUNNER_OS: "macOS",
            APPLE_TEAM_ID: "TEAM",
            SHEPHERD_IOS_PROFILE_UUID: "PROFILE",
            SHEPHERD_IOS_EXPORT_OPTIONS: options,
            SHEPHERD_IOS_BUILD_NUMBER: "1",
            SHEPHERD_IOS_VERSION: "0.1.0",
          },
        },
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain(
        "export options disagree with manual signing policy",
      );
    }
  });
  test("cleanup verifier rejects a handoff owned by another run without revealing credentials", () => {
    const handoff = json("token.json", {
      runID: "another-run",
      tokenID: "owned-id",
      token: "DO-NOT-PRINT",
      baseURL: "http://127.0.0.1:1",
    });
    chmodSync(handoff, 0o600);
    const result = python(
      "verify-ios-live-cleanup.py",
      "--handoff",
      handoff,
      "--status",
      join(directory, "proof.json"),
      "--run-id",
      "our-run",
      "--server-url",
      "http://127.0.0.1:1",
      "--revoke",
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("UNMET: cleanup ownership");
    expect(result.stderr.toString()).not.toContain("DO-NOT-PRINT");
  });
  test("cleanup verifier requires a real HTTP 401 after revoking the exact token", async () => {
    const requests: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        requests.push(
          `${request.method} ${new URL(request.url).pathname} ${request.headers.get("authorization")}`,
        );
        return new Response(null, { status: request.method === "DELETE" ? 204 : 401 });
      },
    });
    try {
      const handoff = json("token.json", {
        runID: "our-run",
        tokenID: "owned-id",
        token: "fixture-token",
        baseURL: server.url.origin,
      });
      chmodSync(handoff, 0o600);
      const result = Bun.spawn([
        "python3",
        resolve("native/scripts/verify-ios-live-cleanup.py"),
        "--handoff",
        handoff,
        "--status",
        join(directory, "proof.json"),
        "--run-id",
        "our-run",
        "--server-url",
        server.url.origin,
        "--revoke",
      ]);
      expect(await result.exited).toBe(0);
      expect(requests).toEqual([
        "DELETE /api/access-tokens/owned-id Bearer fixture-token",
        "GET /api/sessions Bearer fixture-token",
      ]);
      expect(
        JSON.parse(readFileSync(join(directory, "proof.json"), "utf8")).verifiedHTTPStatus,
      ).toBe(401);
    } finally {
      server.stop(true);
    }
  });
  test("refused revocation and still-authorized token cannot produce cleanup proof", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        return new Response(null, { status: request.method === "DELETE" ? 403 : 200 });
      },
    });
    try {
      const handoff = json("token.json", {
        runID: "our-run",
        tokenID: "owned-id",
        token: "NEVER-LOG-THIS",
        baseURL: server.url.origin,
      });
      chmodSync(handoff, 0o600);
      const child = Bun.spawn(
        [
          "python3",
          resolve("native/scripts/verify-ios-live-cleanup.py"),
          "--handoff",
          handoff,
          "--status",
          join(directory, "proof.json"),
          "--run-id",
          "our-run",
          "--server-url",
          server.url.origin,
          "--revoke",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(await child.exited).not.toBe(0);
      const error = await new Response(child.stderr).text();
      expect(error).toContain("lacks HTTP-401 proof");
      expect(error).not.toContain("NEVER-LOG-THIS");
      expect(readFileSync(handoff, "utf8")).toContain("NEVER-LOG-THIS");
    } finally {
      server.stop(true);
    }
  });
});
