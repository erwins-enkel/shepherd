import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const directory = "native/Apps/ShepherdMac/UITests";
const harness = readFileSync(join(directory, "IsolatedUITestHarness.swift"), "utf8");

function boundedScope(
  source: string,
  marker: string,
): { body: string; openingBrace: number; closingBrace: number } {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) throw new Error(`missing ${marker}`);
  const openingBrace = source.indexOf("{", markerIndex);
  if (openingBrace < 0) throw new Error(`missing ${marker} body`);
  let depth = 0;
  let inString = false;
  for (let index = openingBrace; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (character === "\\") index += 1;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0)
        return { body: source.slice(openingBrace + 1, index), openingBrace, closingBrace: index };
    }
  }
  throw new Error("unclosed Swift scope");
}

function executable(source: string): string {
  let normalized = "";
  let inString = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      normalized += character;
      if (character === "\\") normalized += source[++index] ?? "";
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      normalized += character;
      inString = true;
    } else if (character === "/" && source[index + 1] === "/") {
      index = source.indexOf("\n", index);
      if (index < 0) break;
    } else if (character === "/" && source[index + 1] === "*") {
      const commentEnd = source.indexOf("*/", index + 2);
      if (commentEnd < 0) throw new Error("unclosed Swift comment");
      index = commentEnd + 1;
    } else if (character !== undefined && !/\s/.test(character)) {
      normalized += character;
    }
  }
  return normalized;
}

function assertShutdownContract(source: string): void {
  const shutdown = boundedScope(source, "func shutdown()");
  const deferCount = (shutdown.body.match(/\bdefer\s*\{/g) ?? []).length;
  if (deferCount !== 1) throw new Error("shutdown must contain exactly one deferred Quit");
  const deferredQuit = boundedScope(shutdown.body, "defer");
  const beforeDeferredQuit =
    shutdown.body.slice(0, shutdown.body.indexOf("defer")) +
    shutdown.body.slice(deferredQuit.closingBrace + 1);

  const expectedBeforeDeferredQuit =
    'guardletapp=runningelse{return}ifexpectsCleanup{guardapp.state!=.notRunningelse{XCTFail("Isolated app exited before its owned-token cleanup could be verified")return}verifyCleanupBeforeQuit(app)}';
  if (executable(beforeDeferredQuit) !== expectedBeforeDeferredQuit) {
    throw new Error("shutdown must complete its fixed cleanup path before deferred Quit");
  }

  const expectedDeferredQuit =
    'running=nilexpectsCleanup=falseifapp.state!=.notRunning{app.typeKey("q",modifierFlags:.command)letquit=app.wait(for:.notRunning,timeout:10)if!quit{app.terminate()}XCTAssertTrue(quit,"Isolated app must finish bounded graceful Quit")}';
  if (executable(deferredQuit.body) !== expectedDeferredQuit) {
    throw new Error("deferred Quit must release access, then only Quit, wait, or terminate");
  }
}

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

test("shutdown releases query access before its deferred Quit", () => {
  expect(() => assertShutdownContract(harness)).not.toThrow();
});

test("shutdown contract rejects AX work after Quit or inside the deferred scope", () => {
  const afterQuitQuery = harness.replace(
    "let quit = app.wait(for: .notRunning, timeout: 10)",
    "let quit = app.wait(for: .notRunning, timeout: 10)\n                _ = app.descendants(matching: .any)",
  );
  expect(() => assertShutdownContract(afterQuitQuery)).toThrow("only Quit, wait, or terminate");

  const verificationInDefer = harness
    .replace("            verifyCleanupBeforeQuit(app)\n", "")
    .replace(
      'app.typeKey("q", modifierFlags: .command)',
      'app.typeKey("q", modifierFlags: .command)\n                verifyCleanupBeforeQuit(app)',
    );
  expect(() => assertShutdownContract(verificationInDefer)).toThrow(
    "fixed cleanup path before deferred Quit",
  );

  const nestedDeferredQuery = harness.replace(
    'app.typeKey("q", modifierFlags: .command)',
    'defer { _ = app.descendants(matching: .any) }\n                app.typeKey("q", modifierFlags: .command)',
  );
  expect(() => assertShutdownContract(nestedDeferredQuery)).toThrow("exactly one deferred Quit");

  const extraDeferredQuery = harness.replace(
    "        defer {",
    "        defer { _ = app.descendants(matching: .any) }\n        defer {",
  );
  expect(() => assertShutdownContract(extraDeferredQuery)).toThrow("exactly one deferred Quit");
});
