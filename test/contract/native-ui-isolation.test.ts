import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const directory = "native/Apps/ShepherdMac/UITests";
const harness = readFileSync(join(directory, "IsolatedUITestHarness.swift"), "utf8");

test("UI suites cannot bypass the isolated launch and shutdown owner", () => {
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".swift"))) {
    const source = readFileSync(join(directory, file), "utf8");
    expect(source).not.toMatch(/\.activate\s*\(/);
    if (file === "IsolatedUITestHarness.swift") continue;
    expect(source).not.toMatch(/XCUIApplication\(\)/);
    expect(source).not.toMatch(/app\.(?:launch|terminate|typeKey\("q")/);
  }
  expect(harness).toContain('"-ShepherdIsolated", "1"');
  const isolationCheck = harness.indexOf("precondition(isolation.map");
  expect(isolationCheck).toBeGreaterThanOrEqual(0);
  expect(isolationCheck).toBeLessThan(harness.indexOf("app.launch()"));
  expect(harness).toContain("guard let running, running.state != .notRunning else");
});

test("shutdown drops query access before Quit and only waits or terminates afterward", () => {
  const shutdown = harness.slice(harness.indexOf("func shutdown()"));
  const quit = shutdown.indexOf('app.typeKey("q"');
  const release = shutdown.indexOf("running = nil");
  expect(release).toBeGreaterThanOrEqual(0);
  expect(quit).toBeGreaterThan(release);
  expect(shutdown.slice(quit).match(/app\.\w+/g)).toEqual([
    "app.typeKey",
    "app.wait",
    "app.terminate",
  ]);
});
