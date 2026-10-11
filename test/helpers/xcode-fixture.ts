import { readdirSync, readFileSync } from "node:fs";
import type { XcodeExpected, XcodeRecording } from "../../scripts/record-xcode-fixtures";
import type { CapabilityCheck } from "../../src/remote-instances/capabilities";
import type {
  CapabilityExec,
  CapabilityProbeDeps,
} from "../../src/remote-instances/capability-probe";

// Replays a recording of real Xcode output (scripts/record-xcode-fixtures.ts, #2771) through the
// capability probe's injected exec, and compares the macOS entries with what the recording host's
// other sources said.

const FIXTURES = new URL("../fixtures/xcode/", import.meta.url);

const MACOS_ENTRIES = ["platform:macos", "xcode", "sdk:macos", "sdk:ios", "ios-simulator"] as const;

export function loadXcodeRecordings(): { name: string; recording: XcodeRecording }[] {
  return readdirSync(FIXTURES)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => ({
      name,
      recording: JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8")) as XcodeRecording,
    }));
}

/** A macOS host that answers exactly what was recorded; any other command is not installed. */
export function recordingDeps(recording: XcodeRecording): CapabilityProbeDeps {
  const exec: CapabilityExec = async (cmd, args) => {
    const run = recording.commands[[cmd, ...args].join(" ")];
    return run
      ? { ...run, timedOut: false, notFound: false }
      : { code: null, stdout: "", timedOut: false, notFound: true };
  };
  return {
    exec,
    platform: "macos",
    env: {},
    home: "/nonexistent",
    codexBin: "codex",
    readdir: () => null,
    detectSandbox: () => ({ backend: false, egress: false }),
  };
}

/** The macOS entries as the probe reported them: the detail when available, else `missing`. */
export function macosView(checks: CapabilityCheck[]): Record<string, string> {
  return Object.fromEntries(
    MACOS_ENTRIES.map((id) => {
      const check = checks.find((c) => c.id === id);
      return [id, check?.ok ? (check.detail ?? "ok") : "missing"];
    }),
  );
}

/** The same view of a recording's independently sourced expectation. */
export function expectedView(expected: XcodeExpected): Record<string, string> {
  return Object.fromEntries(MACOS_ENTRIES.map((id) => [id, expected[id] ?? "missing"]));
}
