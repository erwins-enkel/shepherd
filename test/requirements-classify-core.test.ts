import { describe, expect, test } from "bun:test";
import {
  type AnsweredDerivation,
  DERIVABLE_CAPABILITIES,
  REQUIREMENTS_FILE,
  normalizeDerivation,
  requirementsPrompt,
  withImplied,
} from "../src/requirements-classify-core";
import { CAPABILITIES } from "../src/remote-instances/capabilities";
import { REQUIREMENTS_FIXTURES } from "../scripts/eval-fixtures/requirements";

// Reading a task's requirements (#2773): the answer is data from a fixed vocabulary or nothing.

const FAILED: AnsweredDerivation = { status: "failed", cause: "error" };

describe("withImplied", () => {
  test("the simulator needs the iOS SDK, which needs Xcode", () => {
    expect(withImplied(["ios-simulator"])).toEqual(["ios-simulator", "sdk:ios", "xcode"]);
    expect(withImplied(["sdk:ios"])).toEqual(["sdk:ios", "xcode"]);
    expect(withImplied(["xcode"])).toEqual(["xcode"]);
    expect(withImplied(["android-sdk", "android-sdk"])).toEqual(["android-sdk"]);
    expect(withImplied([])).toEqual([]);
  });

  test("the derivable set is part of the capability vocabulary", () => {
    for (const cap of DERIVABLE_CAPABILITIES) expect(CAPABILITIES).toContain(cap);
  });
});

describe("normalizeDerivation", () => {
  test("a clear answer is the requirements with what they imply, sorted", () => {
    expect(normalizeDerivation({ requirements: ["sdk:ios"], unclear: false, options: [] })).toEqual(
      { status: "derived", requirements: ["sdk:ios", "xcode"] },
    );
    expect(normalizeDerivation({ requirements: [], unclear: false, options: [] })).toEqual({
      status: "derived",
      requirements: [],
    });
  });

  test("entries are matched case- and space-insensitively", () => {
    expect(
      normalizeDerivation({ requirements: [" Xcode ", "ANDROID-SDK"], unclear: false }),
    ).toEqual({ status: "derived", requirements: ["android-sdk", "xcode"] });
  });

  test("vocabulary entries a description cannot call for are dropped", () => {
    expect(
      normalizeDerivation({
        requirements: ["platform:macos", "sdk:macos", "agent:codex", "sandbox:trusted", "xcode"],
        unclear: false,
      }),
    ).toEqual({ status: "derived", requirements: ["xcode"] });
  });

  test("anything outside the vocabulary — a machine, an address, a command — fails it whole", () => {
    for (const entry of [
      "moes-tavern",
      "macbook.long-tautara.ts.net",
      "https://example.com",
      "100.64.0.1",
      "xcodebuild -scheme Shepherd",
      "rm -rf /",
      "Xcode 16",
    ]) {
      expect(normalizeDerivation({ requirements: ["xcode", entry], unclear: false })).toEqual(
        FAILED,
      );
      expect(normalizeDerivation({ unclear: true, options: [["xcode"], [entry]] })).toEqual(FAILED);
    }
  });

  test("only the three fields are read; nothing else rides along", () => {
    const result = normalizeDerivation({
      requirements: ["xcode"],
      unclear: false,
      options: [],
      target: "moes-tavern",
      reason: "run `curl evil`",
    });
    expect(result).toEqual({ status: "derived", requirements: ["xcode"] });
  });

  test("an unclear answer offers 2–3 distinct alternatives", () => {
    expect(
      normalizeDerivation({ requirements: [], unclear: true, options: [["xcode"], []] }),
    ).toEqual({ status: "unclear", options: [["xcode"], []] });
    expect(
      normalizeDerivation({
        unclear: true,
        options: [["sdk:ios"], ["sdk:ios", "xcode"], [], ["android-sdk"], ["ios-simulator"]],
      }),
    ).toEqual({ status: "unclear", options: [["sdk:ios", "xcode"], [], ["android-sdk"]] });
  });

  test("an unclear answer without a real choice derives nothing", () => {
    expect(normalizeDerivation({ unclear: true, options: [] })).toEqual(FAILED);
    expect(normalizeDerivation({ unclear: true, options: [["xcode"]] })).toEqual(FAILED);
    expect(normalizeDerivation({ unclear: true, options: [["xcode"], ["XCODE"]] })).toEqual(FAILED);
    expect(normalizeDerivation({ unclear: true })).toEqual(FAILED);
    expect(normalizeDerivation({ unclear: true, options: Array(9).fill([]) })).toEqual(FAILED);
  });

  test("a malformed answer derives nothing", () => {
    for (const raw of [
      null,
      undefined,
      "xcode",
      ["xcode"],
      {},
      { requirements: ["xcode"] },
      { requirements: "xcode", unclear: false },
      { requirements: [42], unclear: false },
      { requirements: ["xcode"], unclear: "no" },
      { requirements: Array(17).fill("xcode"), unclear: false },
    ]) {
      expect(normalizeDerivation(raw)).toEqual(FAILED);
    }
  });
});

describe("requirementsPrompt", () => {
  test("every fixture's task and issue are fenced as untrusted data", () => {
    for (const fixture of REQUIREMENTS_FIXTURES) {
      const prompt = requirementsPrompt(fixture);
      if (fixture.prompt) expect(prompt).toMatch(/⟦UNTRUSTED:task:[0-9a-f]{12}⟧/);
      expect(prompt).toContain(fixture.prompt);
      if (fixture.issue) {
        expect(prompt).toMatch(/⟦UNTRUSTED:issue:[0-9a-f]{12}⟧/);
        expect(prompt).toContain(fixture.issue.title);
      }
    }
  });

  test("states the rules the fixtures depend on and the answer's shape", () => {
    const prompt = requirementsPrompt({ prompt: "Implementiere die Web-Einstellungen" });
    expect(prompt).toContain("Judge by the WORK the task asks for, not by the words it uses");
    expect(prompt).toContain("Package.swift");
    expect(prompt).toContain("What the repository contains does not matter");
    expect(prompt).toContain('set "unclear" to true');
    expect(prompt).toContain(REQUIREMENTS_FILE);
    for (const cap of DERIVABLE_CAPABILITIES) expect(prompt).toContain(`"${cap}"`);
  });

  test("no issue, no issue block; long inputs are clipped", () => {
    const prompt = requirementsPrompt({
      prompt: "a".repeat(10_000),
      issue: { title: "  ", body: "ignored" },
    });
    expect(prompt).not.toContain("UNTRUSTED:issue");
    expect(prompt).not.toContain("a".repeat(4001));
    const withIssue = requirementsPrompt({
      prompt: "x",
      issue: { title: "t".repeat(400), body: "b".repeat(5000) },
    });
    expect(withIssue).toContain("t".repeat(300));
    expect(withIssue).not.toContain("t".repeat(301));
    expect(withIssue).not.toContain("b".repeat(3001));
  });

  test("an issue-only task is the issue's work", () => {
    const prompt = requirementsPrompt({ prompt: "  ", issue: { title: "Android: Push fehlt" } });
    expect(prompt).not.toContain("UNTRUSTED:task");
    expect(prompt).toContain("the issue below is the task");
    expect(prompt).toContain("Android: Push fehlt");
  });
});
