import { describe, expect, test } from "bun:test";
import {
  CAPABILITIES,
  type CapabilitySnapshot,
  capabilityReport,
  describeMissing,
  isCapability,
  missingRequirements,
  parseCapabilityReport,
  parseRequirements,
  platformReleased,
} from "../src/remote-instances/capabilities";

// The pure rules of verified capabilities (#2770): vocabulary, requirements, freshness, the
// coordinator's reading of a machine's report and the platform release gate.

const MIN = 60_000;

function snapshot(okIds: string[], probedAt = 1_000_000): CapabilitySnapshot {
  return {
    vocabulary: 1,
    probedAt,
    checks: CAPABILITIES.map((id) =>
      okIds.includes(id)
        ? { id, ok: true, reason: null }
        : { id, ok: false, reason: "probe_failed" },
    ),
  };
}

describe("vocabulary", () => {
  test("is fixed and recognises only its own entries", () => {
    expect(CAPABILITIES).toContain("agent:codex");
    expect(CAPABILITIES).toContain("sandbox:autonomous");
    expect(isCapability("android-sdk")).toBe(true);
    expect(isCapability("arch:x64")).toBe(false);
    expect(isCapability(42)).toBe(false);
  });
});

describe("parseRequirements", () => {
  test("absent and empty read as no requirements", () => {
    expect(parseRequirements(undefined)).toBeUndefined();
    expect(parseRequirements([])).toBeUndefined();
  });

  test("sorts and deduplicates", () => {
    expect(parseRequirements(["xcode", "agent:claude", "xcode"])).toEqual([
      "agent:claude",
      "xcode",
    ]);
  });

  test("names an unknown capability and rejects other shapes", () => {
    expect(parseRequirements(["xcode", "gpu"])).toEqual({ error: "unknown capability: gpu" });
    expect(parseRequirements("xcode")).toHaveProperty("error");
    expect(parseRequirements([1])).toEqual({ error: "unknown capability: 1" });
    expect(parseRequirements(Array.from({ length: 33 }, () => "xcode"))).toHaveProperty("error");
  });
});

describe("missingRequirements", () => {
  test("names each unmet requirement with its reason", () => {
    const snap = snapshot(["platform:linux", "agent:claude"]);
    snap.checks = snap.checks.map((c) =>
      c.id === "agent:codex" ? { ...c, reason: "not_logged_in" } : c,
    );
    expect(missingRequirements(snap, ["agent:claude", "agent:codex", "android-sdk"])).toEqual([
      { capability: "agent:codex", reason: "not_logged_in" },
      { capability: "android-sdk", reason: "probe_failed" },
    ]);
    expect(missingRequirements(snap, ["platform:linux"])).toEqual([]);
  });

  test("an entry the snapshot does not mention is not_probed", () => {
    const snap: CapabilitySnapshot = { vocabulary: 1, probedAt: 0, checks: [] };
    expect(missingRequirements(snap, ["xcode"])).toEqual([
      { capability: "xcode", reason: "not_probed" },
    ]);
  });

  test("describeMissing reads as one line naming every capability", () => {
    expect(
      describeMissing([
        { capability: "android-sdk", reason: "sdk_not_found" },
        { capability: "agent:codex", reason: "not_logged_in" },
      ]),
    ).toBe("missing capabilities: android-sdk (sdk_not_found), agent:codex (not_logged_in)");
  });
});

describe("capabilityReport", () => {
  test("adds the age and marks a snapshot older than 15 minutes as stale", () => {
    const snap = snapshot([], 0);
    expect(capabilityReport(snap, 5 * MIN)).toMatchObject({ ageMs: 5 * MIN, stale: false });
    expect(capabilityReport(snap, 15 * MIN)).toMatchObject({ stale: false });
    expect(capabilityReport(snap, 15 * MIN + 1)).toMatchObject({ stale: true });
  });

  test("a snapshot from the future has age 0, never a negative one", () => {
    expect(capabilityReport(snapshot([], 10_000), 0).ageMs).toBe(0);
  });
});

describe("parseCapabilityReport", () => {
  const wire = (over: Record<string, unknown> = {}) => ({
    ...capabilityReport(snapshot(["platform:macos"], 0), 2 * MIN),
    ...over,
  });

  test("re-bases probedAt onto the local clock from ageMs, whatever the remote clock says", () => {
    const parsed = parseCapabilityReport(wire({ probedAt: 999_999_999_999 }), 50 * MIN);
    expect(parsed?.probedAt).toBe(48 * MIN);
    expect(parsed?.checks.find((c) => c.id === "platform:macos")?.ok).toBe(true);
  });

  test("drops entries outside this build's vocabulary", () => {
    const report = wire();
    report.checks = [...report.checks, { id: "gpu:cuda" as never, ok: true, reason: null }];
    expect(parseCapabilityReport(report, 0)?.checks).toHaveLength(CAPABILITIES.length);
  });

  test("keeps a check's detail and leaves an absent or null one out", () => {
    const checks = [
      { id: "platform:macos", ok: true, reason: null, detail: "15.5 (24F74)" },
      { id: "xcode", ok: false, reason: "not_installed", detail: null },
      { id: "sdk:ios", ok: false, reason: "not_installed" },
    ];
    expect(parseCapabilityReport(wire({ checks }), 0)?.checks).toEqual([
      { id: "platform:macos", ok: true, reason: null, detail: "15.5 (24F74)" },
      { id: "xcode", ok: false, reason: "not_installed" },
      { id: "sdk:ios", ok: false, reason: "not_installed" },
    ]);
  });

  test("an absent or malformed report is null, never partially trusted", () => {
    expect(parseCapabilityReport(undefined, 0)).toBeNull();
    expect(parseCapabilityReport(null, 0)).toBeNull();
    expect(parseCapabilityReport(wire({ ageMs: -1 }), 0)).toBeNull();
    expect(parseCapabilityReport(wire({ ageMs: "1" }), 0)).toBeNull();
    expect(parseCapabilityReport(wire({ checks: "x" }), 0)).toBeNull();
    expect(parseCapabilityReport(wire({ checks: [{ id: "xcode", ok: "yes" }] }), 0)).toBeNull();
    const badDetail = [{ id: "xcode", ok: true, reason: null, detail: { version: "16.4" } }];
    expect(parseCapabilityReport(wire({ checks: badDetail }), 0)).toBeNull();
  });
});

describe("platformReleased", () => {
  test("Linux and macOS are released; Windows and unknown platforms are not", () => {
    expect(platformReleased("linux")).toBe(true);
    expect(platformReleased("macos")).toBe(true);
    expect(platformReleased("windows")).toBe(false);
    expect(platformReleased("freebsd")).toBe(false);
  });
});
