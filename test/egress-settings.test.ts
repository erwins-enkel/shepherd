import { test, expect } from "bun:test";
import {
  EGRESS_MUTED_DEFAULTS,
  EGRESS_MUTED_HOSTS_SETTING,
  EGRESS_STANDARD_DEFAULT_SETTING,
  EGRESS_STANDARD_HOSTS_SETTING,
  isEgressMuted,
  normalizeMutedEntry,
  readEgressGlobals,
  standardHostsFor,
} from "../src/egress-settings";

function fakeStore(values: Record<string, string>) {
  return { getSetting: (k: string) => values[k] ?? null };
}

test("absent settings: empty standard list, default off, seeded mutes", () => {
  expect(readEgressGlobals(fakeStore({}))).toEqual({
    standardHosts: [],
    standardDefault: false,
    mutedHosts: [...EGRESS_MUTED_DEFAULTS],
  });
});

test("a stored muted list replaces the defaults, even when empty", () => {
  const g = readEgressGlobals(fakeStore({ [EGRESS_MUTED_HOSTS_SETTING]: "[]" }));
  expect(g.mutedHosts).toEqual([]);
});

test("stored lists are normalized; bad entries drop; bad JSON falls back", () => {
  const g = readEgressGlobals(
    fakeStore({
      [EGRESS_STANDARD_HOSTS_SETTING]: JSON.stringify([
        "Registry.npmjs.org",
        "nope",
        3,
        "x.dev:8080",
      ]),
      [EGRESS_STANDARD_DEFAULT_SETTING]: "1",
      [EGRESS_MUTED_HOSTS_SETTING]: "{not json",
    }),
  );
  expect(g.standardHosts).toEqual(["registry.npmjs.org", "x.dev:8080"]);
  expect(g.standardDefault).toBe(true);
  expect(g.mutedHosts).toEqual([...EGRESS_MUTED_DEFAULTS]);
});

test("standardHostsFor resolves inherit/on/off against the default", () => {
  const hosts = ["registry.npmjs.org"];
  for (const [mode, def, want] of [
    ["inherit", false, []],
    ["inherit", true, hosts],
    [undefined, true, hosts],
    ["on", false, hosts],
    ["off", true, []],
  ] as const) {
    expect(standardHostsFor(mode, { standardDefault: def, standardHosts: hosts })).toEqual([
      ...want,
    ]);
  }
});

test("muted entries take no port", () => {
  expect(normalizeMutedEntry("*.DataDogHQ.com")).toBe("*.datadoghq.com");
  expect(normalizeMutedEntry("ph.varlock.dev:443")).toBeNull();
  expect(normalizeMutedEntry("ph.varlock.dev:8443")).toBeNull();
  expect(normalizeMutedEntry("nodot")).toBeNull();
});

test("isEgressMuted: exact host, or *. for strict subdomains", () => {
  const muted = ["*.datadoghq.com", "ph.varlock.dev"];
  expect(isEgressMuted("http-intake.logs.us5.datadoghq.com", muted)).toBe(true);
  expect(isEgressMuted("datadoghq.com", muted)).toBe(false);
  expect(isEgressMuted("PH.varlock.dev", muted)).toBe(true);
  expect(isEgressMuted("x.ph.varlock.dev", muted)).toBe(false);
});
