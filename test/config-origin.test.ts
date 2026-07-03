import { test, expect } from "bun:test";
import { resolveAllowedOriginHosts, SHEPHERD_CAPTURE_EXTENSION_ID } from "../src/config";

// The Capture extension ID must be allowed by default (no SHEPHERD_ALLOWED_HOSTS pairing).
test("resolveAllowedOriginHosts: default includes localhost set + the Capture ID", () => {
  const hosts = resolveAllowedOriginHosts(undefined);
  expect(hosts).toEqual(["localhost", "127.0.0.1", "::1", "[::1]", SHEPHERD_CAPTURE_EXTENSION_ID]);
});

// The un-removable-entry behavior change: env overrides the localhost defaults, but the Capture
// ID is appended even when the operator's SHEPHERD_ALLOWED_HOSTS omits it.
test("resolveAllowedOriginHosts: env omitting the ID still includes it (appended)", () => {
  const hosts = resolveAllowedOriginHosts("example.internal");
  expect(hosts).toEqual(["example.internal", SHEPHERD_CAPTURE_EXTENSION_ID]);
});

// Dedup: an env value that already lists the ID must not double it.
test("resolveAllowedOriginHosts: env already listing the ID is not doubled", () => {
  const hosts = resolveAllowedOriginHosts(`a,${SHEPHERD_CAPTURE_EXTENSION_ID}`);
  expect(hosts).toEqual(["a", SHEPHERD_CAPTURE_EXTENSION_ID]);
  expect(hosts.filter((h) => h === SHEPHERD_CAPTURE_EXTENSION_ID)).toHaveLength(1);
});

// Trim + empty-filter must preserve real entries verbatim, including bracketed IPv6.
test("resolveAllowedOriginHosts: trims whitespace, drops empties, preserves [::1]", () => {
  const hosts = resolveAllowedOriginHosts("localhost, , [::1] ,");
  expect(hosts).toEqual(["localhost", "[::1]", SHEPHERD_CAPTURE_EXTENSION_ID]);
});
