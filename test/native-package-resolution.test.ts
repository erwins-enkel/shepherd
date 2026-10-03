import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// #2694: xcodebuild must resolve Swift packages without asking the login
// Keychain for github.com. Every call that may load the package graph carries
// both switches; only the modes below never do, so they are the sole exemptions.
const REQUIRED = [
  ["-packageAuthorizationProvider", "netrc"],
  ["-scmProvider", "system"],
] as const;
const EXEMPT = new Set(["-version", "-downloadComponent", "-exportArchive"]);
const ACTIONS = "build|test|archive|analyze|clean|build-for-testing|test-without-building|docbuild";
// A call starts with an option or an action, so prose ("before xcodebuild, so …") never matches.
const CALL = new RegExp(`\\bxcodebuild\\s+(?=-|(?:${ACTIONS})\\b)`, "g");

type Call = { text: string; resolving: boolean; covered: boolean };

function xcodebuildCalls(source: string): Call[] {
  const lines = source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .replace(/\\\n/g, " ")
    .split("\n");
  return lines.flatMap((line) =>
    [...line.matchAll(CALL)].map((match) => {
      const text = line
        .slice(match.index)
        .split(/\||;|&&/)[0]!
        .trim();
      const tokens = text.split(/\s+/);
      return {
        text,
        resolving: !tokens.some((token) => EXEMPT.has(token)),
        covered: REQUIRED.every(([flag, value]) =>
          tokens.some((token, i) => token === flag && tokens[i + 1] === value),
        ),
      };
    }),
  );
}

const uncovered = (source: string) =>
  xcodebuildCalls(source).filter((call) => call.resolving && !call.covered);
const SWITCHES = REQUIRED.flat().join(" ");

describe("package-resolving xcodebuild calls", () => {
  test.each([
    ["no switches", "xcodebuild -scheme X build"],
    ["no netrc authorization", "xcodebuild -scheme X -scmProvider system build"],
    ["no system git", "xcodebuild -scheme X -packageAuthorizationProvider netrc build"],
    [
      "the wrong provider",
      "xcodebuild -scheme X -packageAuthorizationProvider netrc -scmProvider xcode build",
    ],
    ["-list on a package", '(cd native && "$UITEST_LOCK" xcodebuild -list -json)'],
    ["the action first", "xcodebuild build -scheme X"],
    ["switches only after the call ends", `xcodebuild -scheme X build && echo ${SWITCHES}`],
  ])("flags a call with %s", (_, source) => {
    expect(uncovered(source)).toHaveLength(1);
  });

  test("accepts both switches on continuation lines behind the lock", () => {
    const calls = xcodebuildCalls(
      [
        '"$UITEST_LOCK" xcodebuild -scheme X \\',
        "  -packageAuthorizationProvider netrc \\",
        "  -scmProvider system \\",
        "  build 2>&1 | tail -n 40",
      ].join("\n"),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ resolving: true, covered: true });
  });

  test("exempts modes that never resolve packages", () => {
    const calls = xcodebuildCalls(
      [
        "native/scripts/uitest-lock.sh xcodebuild -version",
        "run: native/scripts/uitest-lock.sh xcodebuild -downloadComponent MetalToolchain",
        'xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportPath "$EXPORT"',
      ].join("\n"),
    );
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => !call.resolving)).toBe(true);
  });

  test("ignores comments and prose", () => {
    const source = [
      "# xcodebuild -scheme X build",
      "    # xcodebuild strips on the way into a hosted test process",
      'raise SystemExit("timed out waiting for serialized xcodebuild")',
      "before xcodebuild, so codesign never opens a dialog again.",
    ].join("\n");
    expect(xcodebuildCalls(source)).toEqual([]);
  });
});

describe("native entry points", () => {
  const sources = (
    [
      ["native/scripts", ".sh"],
      [".github/workflows", ".yml"],
    ] as const
  ).flatMap(([directory, extension]) =>
    readdirSync(directory)
      .filter((name) => name.endsWith(extension))
      .map((name) => join(directory, name)),
  );
  const calls = (path: string) => xcodebuildCalls(readFileSync(path, "utf8"));

  test("every package-resolving xcodebuild call carries both switches", () => {
    const missing = sources.flatMap((path) =>
      calls(path)
        .filter((call) => call.resolving && !call.covered)
        .map((call) => `${path}: ${call.text}`),
    );
    expect(missing).toEqual([]);
  });

  // Guards the scanner itself: one that finds nothing would pass the test above.
  test.each([
    ["native/scripts/build-app.sh", 1],
    ["native/scripts/test-app.sh", 1],
    ["native/scripts/build-ios-app.sh", 1],
    ["native/scripts/test-ios-app.sh", 1],
    ["native/scripts/ios-dev.sh", 1],
    ["native/scripts/archive-ios-app.sh", 1],
    [".github/workflows/native.yml", 2],
  ] as const)("finds the package-resolving calls in %s", (path, count) => {
    expect(calls(path).filter((call) => call.resolving).length).toBeGreaterThanOrEqual(count);
  });
});
