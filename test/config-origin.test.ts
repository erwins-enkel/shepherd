import { test, expect } from "bun:test";
import {
  resolveAllowedOriginHosts,
  SHEPHERD_CAPTURE_EXTENSION_ID,
  SHEPHERD_CAPTURE_UNPACKED_DEV_ID,
} from "../src/config";

// Both Capture IDs (published store item + unpacked dev build) must be allowed by default so
// neither install path needs a SHEPHERD_ALLOWED_HOSTS pairing step.
test("resolveAllowedOriginHosts: default includes localhost set + both Capture IDs", () => {
  const hosts = resolveAllowedOriginHosts(undefined);
  expect(hosts).toEqual([
    "localhost",
    "127.0.0.1",
    "::1",
    "[::1]",
    SHEPHERD_CAPTURE_EXTENSION_ID,
    SHEPHERD_CAPTURE_UNPACKED_DEV_ID,
  ]);
});

// The un-removable-entry behavior change: env overrides the localhost defaults, but both Capture
// IDs are appended even when the operator's SHEPHERD_ALLOWED_HOSTS omits them.
test("resolveAllowedOriginHosts: env omitting the IDs still includes them (appended)", () => {
  const hosts = resolveAllowedOriginHosts("example.internal");
  expect(hosts).toEqual([
    "example.internal",
    SHEPHERD_CAPTURE_EXTENSION_ID,
    SHEPHERD_CAPTURE_UNPACKED_DEV_ID,
  ]);
});

// Dedup: an env value that already lists an ID must not double it.
test("resolveAllowedOriginHosts: env already listing an ID is not doubled", () => {
  const hosts = resolveAllowedOriginHosts(`a,${SHEPHERD_CAPTURE_EXTENSION_ID}`);
  expect(hosts).toEqual(["a", SHEPHERD_CAPTURE_EXTENSION_ID, SHEPHERD_CAPTURE_UNPACKED_DEV_ID]);
  expect(hosts.filter((h) => h === SHEPHERD_CAPTURE_EXTENSION_ID)).toHaveLength(1);
});

// Trim + empty-filter must preserve real entries verbatim, including bracketed IPv6.
test("resolveAllowedOriginHosts: trims whitespace, drops empties, preserves [::1]", () => {
  const hosts = resolveAllowedOriginHosts("localhost, , [::1] ,");
  expect(hosts).toEqual([
    "localhost",
    "[::1]",
    SHEPHERD_CAPTURE_EXTENSION_ID,
    SHEPHERD_CAPTURE_UNPACKED_DEV_ID,
  ]);
});
