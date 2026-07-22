import { test, expect, afterEach } from "bun:test";
import {
  detectedHerdrVersion,
  HERDR_LAST_SPAWNABLE_VERSION,
  HERDR_LAST_SUPPORTED_VERSION,
  herdrSpawnSupported,
  herdrUsesExternalRegistrationSpawn,
  isHerdrVersionSupported,
  parseHerdrVersion,
  setDetectedHerdrVersion,
} from "../src/herdr-capabilities";

// ── parseHerdrVersion ────────────────────────────────────────────────────────

test("parseHerdrVersion: extracts x.y.z from a `herdr --version` line", () => {
  expect(parseHerdrVersion("herdr 0.7.4")).toBe("0.7.4");
  expect(parseHerdrVersion("herdr 0.7.5\n")).toBe("0.7.5");
});

test("parseHerdrVersion: null when no version present", () => {
  expect(parseHerdrVersion("")).toBeNull();
  expect(parseHerdrVersion("garbage")).toBeNull();
});

// ── isHerdrVersionSupported (the 0.7.4 ceiling) ──────────────────────────────

test("isHerdrVersionSupported: <=0.7.4 supported, 0.7.5+ not", () => {
  expect(isHerdrVersionSupported("0.7.4")).toBe(true);
  expect(isHerdrVersionSupported("0.7.3")).toBe(true);
  expect(isHerdrVersionSupported("0.6.9")).toBe(true);
  expect(isHerdrVersionSupported("0.7.5")).toBe(false);
  expect(isHerdrVersionSupported("0.7.6")).toBe(false);
  expect(isHerdrVersionSupported("0.8.0")).toBe(false);
  expect(isHerdrVersionSupported("1.0.0")).toBe(false);
});

test("isHerdrVersionSupported: null/unparseable → true (never false-alarm)", () => {
  expect(isHerdrVersionSupported(null)).toBe(true);
});

test("HERDR_LAST_SUPPORTED_VERSION is 0.7.4 and is itself supported", () => {
  expect(HERDR_LAST_SUPPORTED_VERSION).toBe("0.7.4");
  expect(isHerdrVersionSupported(HERDR_LAST_SUPPORTED_VERSION)).toBe(true);
});

// ── cached detected version ──────────────────────────────────────────────────

afterEach(() => setDetectedHerdrVersion(null));

test("herdrSpawnSupported defaults to true before detection", () => {
  setDetectedHerdrVersion(null);
  expect(herdrSpawnSupported()).toBe(true);
});

test("setDetectedHerdrVersion drives detectedHerdrVersion + herdrSpawnSupported", () => {
  setDetectedHerdrVersion("0.7.4");
  expect(detectedHerdrVersion()).toBe("0.7.4");
  expect(herdrSpawnSupported()).toBe(true);

  // 0.7.5 is now SPAWNABLE via the CLI external-registration path (#1890) — decoupled from the
  // 0.7.4 general ceiling (which still gates the preflight/updater/diagnostics).
  setDetectedHerdrVersion("0.7.5");
  expect(detectedHerdrVersion()).toBe("0.7.5");
  expect(herdrSpawnSupported()).toBe(true);

  // Beyond the spawnable ceiling → still refused.
  setDetectedHerdrVersion("0.7.6");
  expect(herdrSpawnSupported()).toBe(false);
  setDetectedHerdrVersion("0.8.0");
  expect(herdrSpawnSupported()).toBe(false);
});

// ── external-registration spawn path (0.7.5+) ────────────────────────────────

test("HERDR_LAST_SPAWNABLE_VERSION is 0.7.5 (decoupled from the 0.7.4 support ceiling)", () => {
  expect(HERDR_LAST_SPAWNABLE_VERSION).toBe("0.7.5");
  // The support ceiling (updater/preflight) stays at 0.7.4 — 0.7.5 is spawnable but not "supported".
  expect(isHerdrVersionSupported("0.7.5")).toBe(false);
});

test("herdrUsesExternalRegistrationSpawn: true from 0.7.5 up, false below and pre-detection", () => {
  setDetectedHerdrVersion(null);
  expect(herdrUsesExternalRegistrationSpawn()).toBe(false); // un-probed → legacy path

  setDetectedHerdrVersion("0.7.4");
  expect(herdrUsesExternalRegistrationSpawn()).toBe(false);

  setDetectedHerdrVersion("0.7.5");
  expect(herdrUsesExternalRegistrationSpawn()).toBe(true);
  setDetectedHerdrVersion("0.8.0");
  expect(herdrUsesExternalRegistrationSpawn()).toBe(true);
});
