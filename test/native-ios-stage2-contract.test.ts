import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

describe("native iOS acceptance tools", () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "ios-gates-")); });
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); });
  const python = (script: string, ...args: string[]) => Bun.spawnSync(["python3", resolve("native/scripts", script), ...args]);
  function json(name: string, value: unknown) {
    const path = join(directory, name);
    writeFileSync(path, JSON.stringify(value));
    return path;
  }
  for (const kind of ["pass", "zero", "skip", "malformed"]) {
    test(`result inventory ${kind}`, () => {
      const fixture = JSON.parse(readFileSync(`test/fixtures/native-ios-stage2-results-${kind}.json`, "utf8"));
      const result = python("check-ios-results.py", json("summary.json", fixture.summary), json("tests.json", fixture.tests), "--expected", json("expected.json", fixture.expected));
      expect(result.exitCode === 0).toBe(kind === "pass");
    });
  }
  test("rejects passing counts when a required identity never executed", () => {
    const fixture = JSON.parse(readFileSync("test/fixtures/native-ios-stage2-results-pass.json", "utf8"));
    const result = python("check-ios-results.py", json("summary.json", fixture.summary), json("tests.json", fixture.tests), "--expected", json("expected.json", [...fixture.expected, "Missing/testMissing"]));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("identity");
  });
  for (const family of ["iPhone", "iPad"]) {
    test(`selects newest available ${family} without crossing families`, () => {
      const devices = { devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-18-9": [{ name: `${family} Old`, udid: "OLD", isAvailable: true }],
        "com.apple.CoreSimulator.SimRuntime.iOS-18-10": [
          { name: "iPhone 17", udid: "PHONE", isAvailable: true },
          { name: "iPad Pro (12.9-inch)", udid: "PAD", isAvailable: true },
          { name: `${family} Unavailable`, udid: "BAD", isAvailable: false },
        ],
      }};
      const result = python("select-ios-simulator.py", json("devices.json", devices), "--family", family);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString().trim()).toBe(family === "iPhone" ? "PHONE" : "PAD");
    });
  }
  test("does not substitute ordinary iPhones for unavailable Duo hardware", () => {
    const path = json("devices.json", { devices: { "com.apple.CoreSimulator.SimRuntime.iOS-27-1": [{ name: "iPhone 17", udid: "PHONE", isAvailable: true }] }});
    const result = python("select-ios-simulator.py", path, "--family", "DuoInner");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toBe("");
  });
  test("rejects unsigned release export inputs before invoking Xcode", () => {
    const result = Bun.spawnSync(["bash", resolve("native/scripts/archive-ios-app.sh"), "Release"], { env: { PATH: process.env.PATH!, HOME: directory } });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("UNMET:");
  });
});
