import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const scripts = resolve("native/scripts");
const target = "ShepherdAppCoreTests";
const sourceID = (name: string) =>
  JSON.stringify([target, "fixture.swift", "CoreSeamTests.Example", `${name}()`]);
const node = (name: string, result = "Passed") => ({
  nodeType: "Test Case",
  nodeIdentifier: `CoreSeamTests/Example/${name}()`,
  result,
});
const summary = (passedTests = 2, skippedTests = 0, failedTests = 0) => ({
  totalTestCount: passedTests + skippedTests + failedTests,
  passedTests,
  skippedTests,
  failedTests,
});

describe("native core gates", () => {
  let tempDirectory: string;
  beforeEach(() => {
    tempDirectory = mkdtempSync(join(tmpdir(), "core-gates-"));
  });
  afterEach(() => {
    rmSync(tempDirectory, { recursive: true, force: true });
  });
  function file(name: string, value: unknown) {
    const path = join(tempDirectory, name);
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
    return path;
  }
  function python(script: string, ...args: string[]) {
    return Bun.spawnSync(["python3", join(scripts, script), ...args]);
  }
  function results(counts: unknown = summary(), nodes: unknown = [node("first"), node("second")]) {
    return python(
      "check-core-results.py",
      file("summary.json", counts),
      file("tests.json", { testNodes: nodes }),
      "--mapping",
      file("map.json", {
        mappings: [{ oldID: sourceID("first"), destinations: [sourceID("first")] }],
        added: [sourceID("second")],
      }),
    );
  }
  const device = (name = "iPhone 17", udid = "B", isAvailable = true) => ({
    name,
    udid,
    isAvailable,
  });
  const runtime = (version: string) => `com.apple.CoreSimulator.SimRuntime.iOS-${version}`;
  for (const [label, payload] of Object.entries({
    "iOS 17 only": { devices: { [runtime("17-5")]: [device()] } },
    "unavailable iPhone": { devices: { [runtime("26-5")]: [device("iPhone 17", "A", false)] } },
    "iPad only": { devices: { [runtime("26-5")]: [device("iPad Pro")] } },
    "no devices": { devices: {} },
    "unknown schema": {},
    "non-object payload": [],
    "malformed entries": { devices: { [runtime("26-5")]: [null] } },
    "malformed JSON": "{",
  })) {
    test(`rejects ${label} without stdout`, () => {
      const result = python("select-core-simulator.py", file("devices.json", payload));
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString()).toContain("UNMET:");
    });
  }
  test("selects numeric newest runtime then name and UDID deterministically", () => {
    const result = python(
      "select-core-simulator.py",
      file("devices.json", {
        devices: {
          [runtime("18-9")]: [device("iPhone 99", "OLD")],
          [runtime("18-10")]: [
            device("iPhone 17", "Z"),
            device("iPhone 17", "A"),
            device("iPhone 18", "0"),
          ],
        },
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("A\n");
    expect(result.stderr.toString()).toContain("iOS-18-10: iPhone 17");
  });
  for (const [label, counts] of Object.entries({
    zero: summary(0),
    "all skipped": summary(0, 2),
    failed: summary(1, 0, 1),
    unknown: {},
    inconsistent: { ...summary(), totalTestCount: 3 },
    boolean: { ...summary(), passedTests: true },
    malformed: "{",
  })) {
    test(`rejects ${label} results`, () => {
      expect(results(counts).exitCode).not.toBe(0);
    });
  }
  test("accepts all mapped originals and additions", () => {
    const result = results();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("identities=2");
  });
  test("rejects omitted identities even when counts agree", () => {
    expect(results(summary(1), [node("first")]).exitCode).not.toBe(0);
  });
  test("rejects replacement identities with unchanged counts", () => {
    expect(results(summary(), [node("first"), node("replacement")]).exitCode).not.toBe(0);
  });
  test("rejects duplicate identities", () => {
    expect(results(summary(), [node("first"), node("first")]).exitCode).not.toBe(0);
  });
  test("rejects unknown tree schema", () => {
    expect(results(summary(), {}).exitCode).not.toBe(0);
  });
  test("rejects unknown or contradictory per-test result", () => {
    for (const state of ["FutureStatus", "Failed", "Skipped"])
      expect(results(summary(), [node("first"), node("second", state)]).exitCode).not.toBe(0);
  });
  test("cannot accept counts without an identity inventory", () => {
    expect(python("check-core-results.py", file("summary.json", summary())).exitCode).not.toBe(0);
  });
  test("SwiftPM XML validates mapped identities and skips", () => {
    const mapping = file("map.json", {
      mappings: [],
      added: [sourceID("first"), sourceID("second")],
    });
    const xml = (body: string, tests = 2, skipped = 0, errors = 0) =>
      `<testsuites><testsuite tests="${tests}" failures="0" errors="${errors}" skipped="${skipped}">${body}</testsuite></testsuites>`;
    const first = `<testcase classname="${target}.CoreSeamTests.Example" name="first()"/>`;
    const second = `<testcase classname="${target}.CoreSeamTests.Example" name="second()"/>`;
    const check = (content: string) =>
      python("check-core-results.py", "--xunit", file("tests.xml", content), "--mapping", mapping);
    expect(check(xml(first + second)).exitCode).toBe(0);
    expect(check(xml(first, 1)).exitCode).not.toBe(0);
    expect(check(xml(first + second, 2, 0, 1)).exitCode).not.toBe(0);
    expect(check("<unknown/>").exitCode).not.toBe(0);
    expect(
      check(xml(first + second.replace("/>", "><skipped/></testcase>"), 1, 1)).exitCode,
    ).not.toBe(0);
  });
  test("Kit CI requires actual Keychain cases and sentinel while local skips stay explicit", () => {
    const names = ["keychainIsUsableOnCI", "keychainRoundTrip", "keychainSaveUpdatesInPlace"];
    const mapping = file("kit-map.json", {
      mappings: [],
      added: names.map((name) =>
        JSON.stringify(["ShepherdKitTests", "fixture.swift", "CredentialStoreTests", `${name}()`]),
      ),
    });
    const xml = (skip: boolean, omitted = false) =>
      `<testsuites><testsuite tests="${skip ? 1 : omitted ? 2 : 3}" failures="0" errors="0" skipped="${skip ? 2 : 0}">${names
        .filter((_, i) => !omitted || i !== 0)
        .map(
          (name, i) =>
            `<testcase classname="ShepherdKitTests.CredentialStoreTests" name="${name}()">${skip && i > 0 ? "<skipped/>" : ""}</testcase>`,
        )
        .join("")}</testsuite></testsuites>`;
    const check = (content: string, ci = false) =>
      python(
        "check-core-results.py",
        "--xunit",
        file("kit.xml", content),
        "--target",
        "ShepherdKitTests",
        "--mapping",
        mapping,
        ...(ci ? ["--require-keychain"] : []),
      );
    expect(check(xml(true)).exitCode).toBe(0);
    expect(check(xml(true), true).exitCode).not.toBe(0);
    expect(check(xml(false), true).exitCode).toBe(0);
    expect(check(xml(false, true), true).exitCode).not.toBe(0);
  });
  test("portable lock preserves argv, stdin, exit status and usage", () => {
    const lock = join(scripts, "uitest-lock.sh");
    const env = { ...process.env, RUNNER_TEMP: tempDirectory };
    const result = Bun.spawnSync(
      [
        "bash",
        lock,
        "python3",
        "-c",
        "import sys; print(repr(sys.argv[1:])); print(sys.stdin.read()); sys.exit(23)",
        "two words",
        "",
        "$literal",
      ],
      { env, stdin: Buffer.from("input-data") },
    );
    expect(result.exitCode).toBe(23);
    expect(result.stdout.toString()).toBe("['two words', '', '$literal']\ninput-data\n");
    const usage = Bun.spawnSync(["bash", lock], { env });
    expect(usage.exitCode).not.toBe(0);
    expect(usage.stderr.toString()).toContain("usage:");
    expect(
      Bun.spawnSync(
        ["bash", lock, "python3", "-c", "import os, signal; os.kill(os.getpid(), signal.SIGTERM)"],
        { env },
      ).exitCode,
    ).toBe(143);
    expect(Bun.spawnSync(["bash", lock, "/missing-command"], { env }).exitCode).toBe(127);
  });
  test("CI chains blocking simulator and advisory UI with scoped Kit opt-in", () => {
    const source = readFileSync(".github/workflows/native.yml", "utf8");
    const workflow = Bun.YAML.parse(source) as {
      env?: Record<string, string>;
      jobs: Record<
        string,
        {
          env?: Record<string, string>;
          needs?: string;
          "continue-on-error"?: boolean;
          steps: { name: string; run?: string; env?: Record<string, string> }[];
        }
      >;
    };
    const jobs = workflow.jobs;
    const hasOptIn = (env?: Record<string, string>) =>
      Object.keys(env ?? {}).some((key) => key.endsWith("SHEPHERD_KEYCHAIN_TESTS"));
    expect(hasOptIn(workflow.env)).toBe(false);
    const kit = jobs.shepherdkit!;
    const simulator = jobs["shepherd-app-core-simulator"]!;
    expect(simulator).toBeDefined();
    expect(simulator.needs).toBe("shepherdkit");
    expect(simulator["continue-on-error"]).not.toBe(true);
    expect(jobs["shepherd-mac-ui"]!.needs).toBe("shepherd-app-core-simulator");
    expect(jobs["shepherd-mac-ui"]!["continue-on-error"]).toBe(true);
    const optedIn = kit.steps.filter((step) => step.env?.SHEPHERD_KEYCHAIN_TESTS === "1");
    expect(optedIn).toHaveLength(1);
    expect(optedIn[0]!.run).toContain("--no-parallel --filter ShepherdKitTests");
    expect(optedIn[0]!.run).toContain("--require-keychain");
    const core = kit.steps.find((step) => step.run?.includes("--filter ShepherdAppCoreTests"))!;
    expect(core.run).toContain("unset SHEPHERD_KEYCHAIN_TESTS TEST_RUNNER_SHEPHERD_KEYCHAIN_TESTS");
    expect(core.env).toBeUndefined();
    expect(source).not.toMatch(/SHEPHERD_LIVE_|\/Users\//);
    for (const job of Object.values(jobs)) {
      expect(hasOptIn(job.env)).toBe(false);
      for (const step of job.steps) {
        if (step !== optedIn[0]) expect(hasOptIn(step.env)).toBe(false);
        for (const line of (step.run ?? "")
          .split("\n")
          .filter((line) => /xcodebuild|native\/scripts\/(build|test)-app.sh/.test(line)))
          expect(line).toMatch(/uitest-lock.sh|"\$UITEST_LOCK"/);
      }
    }
    const run = simulator.steps.map((step) => step.run ?? "").join("\n");
    expect(run).toContain("generic/platform=iOS Simulator");
    expect(run).toContain("platform=iOS Simulator,id=$CORE_SIMULATOR_UDID");
    expect(run).toContain("get test-results tests");
    expect(run).toContain("check-core-results.py");
  });
});
