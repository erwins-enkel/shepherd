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
      "--parameters",
      file("parameters.json", { schemaVersion: 1, target, arguments: {} }),
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
  test("requires the complete recorded parameter inventory in a nested xcresult tree", () => {
    const suite = "CoreSeamTests.ActionBarTests";
    const name = "readyConfirmsBothResultingStatesWithSuccessTone";
    const mapping = file("parameter-map.json", {
      mappings: [],
      added: [JSON.stringify([target, "fixture.swift", suite, `${name}(wasReady: Bool)`])],
    });
    const inventory = {
      schemaVersion: 1,
      target,
      arguments: { [`${suite}/${name}`]: ["false", "true"] },
    };
    const argument = (name: string) => ({ nodeType: "Arguments", name, result: "Passed" });
    const check = (
      children: unknown[] | undefined,
      parameters: unknown = inventory,
      extra: unknown[] = [],
    ) =>
      python(
        "check-core-results.py",
        file("summary.json", summary(1)),
        file("tests.json", {
          testNodes: [
            {
              nodeType: "Test Plan",
              result: "Passed",
              children: [
                {
                  nodeType: "Unit test bundle",
                  result: "Passed",
                  children: [
                    {
                      nodeType: "Test Suite",
                      result: "Passed",
                      children: [
                        {
                          nodeType: "Test Case",
                          result: "Passed",
                          nodeIdentifier: `CoreSeamTests/ActionBarTests/${name}(wasReady:)`,
                          children,
                        },
                        ...extra,
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        }),
        "--mapping",
        mapping,
        "--parameters",
        file("parameters.json", parameters),
      );
    expect(check([argument("true"), argument("false")]).exitCode).toBe(0);
    for (const children of [
      undefined,
      [],
      [argument("false")],
      [argument("false"), argument("false")],
      [argument("false"), argument("replacement")],
      [argument("false"), argument("true"), argument("extra")],
    ]) {
      const result = check(children);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain("parameter argument inventory mismatch");
    }
    expect(
      check([argument("false"), argument("true")], { ...inventory, arguments: {} }).exitCode,
    ).not.toBe(0);
    expect(
      check([argument("false"), argument("true")], { ...inventory, target: "Other" }).exitCode,
    ).not.toBe(0);
    for (const result of ["Failed", "Passed"]) {
      const unknown = { nodeType: "Future Arguments", result, name: "unknown" };
      const rejected = check([argument("false"), argument("true")], inventory, [unknown]);
      expect(rejected.exitCode).not.toBe(0);
      expect(rejected.stderr.toString()).toContain("unknown xcresult node type");
      expect(check([argument("false"), unknown]).exitCode).not.toBe(0);
    }
    expect(check([argument("false"), { ...argument("true"), result: "Failed" }]).exitCode).not.toBe(
      0,
    );
    expect(
      check([argument("false"), { ...argument("true"), children: [argument("nested")] }]).exitCode,
    ).not.toBe(0);
    expect(
      check([argument("false"), argument("true")], inventory, [argument("orphan")]).exitCode,
    ).not.toBe(0);
    expect(
      check([
        {
          nodeType: "Test Suite",
          result: "Passed",
          children: [argument("false"), argument("true")],
        },
      ]).exitCode,
    ).not.toBe(0);
    const xml = python(
      "check-core-results.py",
      "--mapping",
      mapping,
      "--xunit",
      file(
        "parameters.xml",
        `<testsuites><testsuite tests="1" failures="0" errors="0" skipped="0"><testcase classname="${target}.${suite}" name="${name}(wasReady:)"/></testsuite></testsuites>`,
      ),
    );
    expect(xml.exitCode).toBe(0);
    expect(xml.stdout.toString()).toContain("per-argument coverage UNVERIFIED here");
    expect(xml.stdout.toString()).toContain("requires the simulator xcresult gate");
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
  test("portable lock serializes and cleans up owned indirect descendants through cancellation", () => {
    // One bounded synthetic fixture; its holder, descendant and waiter are all
    // owned here. No process discovery, Xcode or independent concurrent work.
    const fixture = file(
      "cancellation.py",
      `
import os, pathlib, signal, subprocess, sys, time
root, lock = pathlib.Path(sys.argv[1]), sys.argv[2]
child = root / "child.py"
child.write_text('''import os, pathlib, signal, sys, time
p = pathlib.Path(sys.argv[1])
signal.signal(signal.SIGTERM, lambda *_: (p / "term").touch())
(p / "ready").write_text(str(os.getpgrp()))
deadline = time.monotonic() + 8
while not (p / "release").exists():
    if time.monotonic() > deadline: raise SystemExit(99)
    time.sleep(0.01)
(p / "cleaned").touch()
''')
script = root / "indirect.sh"
script.write_text('trap "" TERM\\npython3 "$1" "$2" &\\nif [ "$3" != term ]; then exit 23; fi\\nwait "$!"\\nexit 23\\n')
def until(predicate):
    deadline = time.monotonic() + 5
    while not predicate():
        if time.monotonic() > deadline: raise AssertionError("fixture deadline")
        time.sleep(0.01)
def group_alive(pgid):
    try: os.killpg(pgid, 0); return True
    except ProcessLookupError: return False
def process_alive(pid):
    try: os.kill(pid, 0); return True
    except ProcessLookupError: return False
for mode in ("term", "kill", "exit"):
    p = root / mode
    p.mkdir()
    env = dict(os.environ, RUNNER_TEMP=str(p))
    holder = subprocess.Popen([lock, "bash", str(script), str(child), str(p), mode], env=env)
    waiter, pgid = None, None
    try:
        until(lambda: (p / "ready").exists() and (p / "ready").read_text())
        pgid = int((p / "ready").read_text())
        # The holder must own a separate group before any group signal is safe.
        assert pgid != os.getpgrp(), "command has no owned group"
        if mode != "term":
            # Only the indirect descendant remains; the script leader is reaped.
            until(lambda: not process_alive(pgid))
            assert group_alive(pgid)
        if mode == "term":
            holder.send_signal(signal.SIGTERM)
            until(lambda: (p / "term").exists())
        elif mode == "kill":
            holder.kill()
            assert holder.wait(timeout=2) == -signal.SIGKILL
        waiter = subprocess.Popen([lock, "python3", "-c",
            'import pathlib, sys; p=pathlib.Path(sys.argv[1]); (p/"entered").touch(); assert (p/"cleaned").exists()', str(p)], env=env)
        time.sleep(0.3)
        assert not (p / "entered").exists(), "waiter entered before descendant cleanup"
        if mode != "kill": assert holder.poll() is None, "holder exited before descendant cleanup"
        (p / "release").touch()
        assert holder.wait(timeout=5) == {"term": 143, "kill": -signal.SIGKILL, "exit": 23}[mode]
        assert waiter.wait(timeout=5) == 0
        until(lambda: not group_alive(pgid))
        print(mode + ": serialized; descendant cleaned; owned group gone", flush=True)
    finally:
        (p / "release").touch()
        # Only our known session/group may be cleaned up on assertion failure.
        if pgid is not None and pgid != os.getpgrp() and group_alive(pgid):
            os.killpg(pgid, signal.SIGKILL)
        for process in (holder, waiter):
            if process is not None:
                if process.poll() is None: process.kill()
                process.wait(timeout=5)
`,
    );
    const result = Bun.spawnSync(
      ["python3", fixture, tempDirectory, join(scripts, "uitest-lock.sh")],
      {
        timeout: 25_000,
      },
    );
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    for (const mode of ["term", "kill", "exit"])
      expect(result.stdout.toString()).toContain(
        `${mode}: serialized; descendant cleaned; owned group gone`,
      );
  }, 30_000);
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
    expect(run).toContain("--parameters native/Tests/Conservation/issue-2431-core-parameters.json");
  });
});
