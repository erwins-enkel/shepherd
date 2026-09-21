import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectTests,
  identity,
  verifyConservation,
  type TestIdentity,
} from "../native/scripts/test-conservation";

function scan(source: string, ui = false) {
  const root = mkdtempSync(join(tmpdir(), "conservation-"));
  const dir = join(root, "native/Apps/ShepherdMac", ui ? "UITests" : "Tests");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "Fixture.swift"), source);
  try {
    return collectTests(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const a: TestIdentity = {
  target: "ShepherdTests",
  path: "A.swift",
  suite: "A",
  signature: "old()",
  line: 1,
  attributes: "@Test",
  condition: "",
  bodyHash: "old",
};
const retained = (t: TestIdentity) => ({
  oldID: identity(t),
  destinations: [identity(t)],
  reason: "retained",
  assertionChanges: [],
});
describe("native test conservation", () => {
  test("missing original cannot be replaced by a new test", () => {
    const b = { ...a, signature: "new()", bodyHash: "new" };
    expect(() => verifyConservation([a], [b], [retained(a)], [identity(b)])).toThrow();
  });
  test("requires total mapping and unique destinations and identities", () => {
    expect(() => verifyConservation([a], [a], [], [])).toThrow();
    expect(() => verifyConservation([a], [a, a], [retained(a)], [])).toThrow();
    expect(() => verifyConservation([a, a], [a], [retained(a)], [])).toThrow();
    expect(() =>
      verifyConservation(
        [a],
        [a],
        [{ ...retained(a), destinations: [identity(a), identity(a)] }],
        [],
      ),
    ).toThrow();
  });
  test("rejects removed parameter attributes, branches and unexplained body changes", () => {
    for (const delta of [{ attributes: "" }, { condition: "#if OTHER" }, { bodyHash: "changed" }])
      expect(() => verifyConservation([a], [{ ...a, ...delta }], [retained(a)], [])).toThrow();
    expect(() =>
      verifyConservation(
        [a],
        [{ ...a, bodyHash: "changed" }],
        [{ ...retained(a), assertionChanges: ["rewritten equivalent"] }],
        [],
      ),
    ).toThrow();
  });
  test("tracks nested and extension suites, multiline attributes and complete signatures", () => {
    const tests = scan(`struct Outer { struct Inner {
      @Test(
        arguments: [1, 2]
      )
      @MainActor func same(_ value: Int) async throws { #expect(value > 0) }
    } }
    extension Outer.Inner { @Test func other() {} }
    struct Second { @Test func same() {} }`);
    expect(tests).toHaveLength(3);
    expect(tests.map((t) => t.suite)).toEqual(["Outer.Inner", "Outer.Inner", "Second"]);
    expect(tests[1]!.signature).toContain("same");
    expect(tests.find((t) => t.signature.includes("value"))?.attributes).toContain("arguments");
  });
  test("lexes nested comments and raw, multiline and interpolated strings", () => {
    const tests = scan(
      '/* /* @Test func fake() {} */ */\nstruct A {\nlet x = #"@Test func fake() { }"#\nlet y = """\n@Test func fake() {}\n"""\n@Test func real() { let s = "value \\(call("inner"))"; #expect(true) }\n}',
    );
    expect(tests).toHaveLength(1);
    expect(tests[0]!.signature).toBe("real()");
  });
  test("retains every conditional branch", () => {
    const tests = scan(
      "struct A {\n#if os(macOS)\n@Test func mac() {}\n#elseif DEBUG\n@Test func debug() {}\n#else\n@Test func other() {}\n#endif\n}",
    );
    expect(tests).toHaveLength(3);
    expect(new Set(tests.map((t) => t.condition)).size).toBe(3);
  });
  test("captures XCTest methods only in XCTestCase suites", () => {
    expect(
      scan(
        "class Helper { func testFake() {} }\nclass UI: XCTestCase { func testReal() throws {} }",
        true,
      ).map((t) => t.signature),
    ).toEqual(["testReal() throws"]);
  });
  test("fails closed on malformed or duplicate declarations", () => {
    for (const source of [
      "struct A { @Test func bad() {",
      "struct A { @Test var bad = 1 }",
      "struct A { @Test func same() {} @Test func same() {} }",
      "/* unfinished",
      "#if DEBUG\nstruct A {}",
    ])
      expect(() => scan(source)).toThrow();
  });
  test("requires explicit unique additions", () => {
    expect(() => verifyConservation([], [a], [], [])).toThrow();
    expect(() => verifyConservation([], [a], [], [identity(a), identity(a)])).toThrow();
    verifyConservation([], [a], [], [identity(a)]);
    verifyConservation([a], [a], [retained(a)], []);
  });
  test("split must retain all original assertions, even with a justification", () => {
    const [original] = scan("struct A { @Test func original() { #expect(true); #expect(false) } }");
    const split = scan("struct A { @Test func first() { #expect(true) } @Test func second() {} }");
    const row = {
      oldID: identity(original!),
      destinations: split.map(identity),
      reason: "split",
      assertionChanges: ["fixture: split setup"],
    };
    expect(() => verifyConservation([original!], split, [row], [])).toThrow();
    const valid = scan(
      "struct A { @Test func first() { #expect(true) } @Test func second() { #expect(false) } }",
    );
    verifyConservation([original!], valid, [{ ...row, destinations: valid.map(identity) }], []);
  });
  test("signature literals preserve significant whitespace", () => {
    const [wide] = scan('struct A { @Test func value(_ s: String = "a  b") {} }');
    const [narrow] = scan('struct A { @Test func value(_ s: String = "a b") {} }');
    expect(identity(wide!)).not.toBe(identity(narrow!));
  });
  test("Issue.record and builtin assertion loss cannot hide in a split", () => {
    for (const assertion of ['Issue.record("failure")', "assert(false)", "precondition(false)"]) {
      const [old] = scan(`struct A { @Test func old() { #expect(true); ${assertion} } }`);
      const current = scan(
        "struct A { @Test func first() { #expect(true) } @Test func second() {} }",
      );
      expect(() =>
        verifyConservation(
          [old!],
          current,
          [
            {
              oldID: identity(old!),
              destinations: current.map(identity),
              reason: "split",
              assertionChanges: ["fixture: split setup"],
            },
          ],
          [],
        ),
      ).toThrow();
    }
  });
  test("removed argument lists and changed line evidence", () => {
    const parameterized = { ...a, attributes: "@Test(arguments: [1, 2])" };
    expect(() => verifyConservation([parameterized], [a], [retained(parameterized)], [])).toThrow();
    expect(identity({ ...a, line: 99 })).toBe(identity(a));
  });
  test("Kit and UI identity relocation is forbidden", () => {
    const old = { ...a, target: "ShepherdKitTests" };
    const moved = { ...old, path: "B.swift" };
    expect(() =>
      verifyConservation(
        [old],
        [moved],
        [{ ...retained(old), destinations: [identity(moved)] }],
        [],
      ),
    ).toThrow();
  });
});
