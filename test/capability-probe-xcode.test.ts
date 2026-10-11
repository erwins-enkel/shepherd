import { describe, expect, test } from "bun:test";
import { redact } from "../scripts/record-xcode-fixtures";
import { probeCapabilities } from "../src/remote-instances/capability-probe";
import {
  expectedView,
  loadXcodeRecordings,
  macosView,
  recordingDeps,
} from "./helpers/xcode-fixture";

// The macOS probe's parsers (#2771) against real Xcode output recorded on a Mac by
// scripts/record-xcode-fixtures.ts. Every recording carries what its host's OTHER sources said
// (plist versions, `xcrun --show-sdk-version`, the text `simctl list`), so this pins the parsers to
// real output instead of restating them. Drop a new recording into test/fixtures/xcode/ and it runs.

const recordings = loadXcodeRecordings();

describe("macOS probe against recorded Xcode output", () => {
  test("has at least one recording", () => {
    expect(recordings.length).toBeGreaterThan(0);
  });

  for (const { name, recording } of recordings) {
    test(`${name} (${recording.source})`, async () => {
      const snap = await probeCapabilities(recordingDeps(recording));
      expect(macosView(snap.checks)).toEqual(expectedView(recording.expected));
    });
  }
});

describe("recordings never carry an account's home directory", () => {
  test("the recorder redacts it as written and as simctl's JSON escapes it", () => {
    const simctl = String.raw`"dataPath" : "\/Users\/kai\/Library\/Developer\/CoreSimulator"`;
    expect(redact(simctl, "/Users/kai")).toBe(
      String.raw`"dataPath" : "~\/Library\/Developer\/CoreSimulator"`,
    );
    expect(redact("/Users/kai/Library/Logs", "/Users/kai")).toBe("~/Library/Logs");
  });

  for (const { name, recording } of recordings) {
    test(name, () => {
      for (const run of Object.values(recording.commands)) {
        // `/Users/<name>` plain or slash-escaped; /Users/Shared belongs to no one.
        expect(`${run.stdout}\n${run.stderr}`).not.toMatch(/\\?\/Users\\?\/(?!Shared\b)\w/);
      }
    });
  }
});
