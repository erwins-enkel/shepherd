import { test, expect } from "bun:test";
import {
  resolveAllowedOriginHosts,
  addOwnHostToAllowlist,
  addServedHostsToAllowlist,
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

// ── addOwnHostToAllowlist (issue #1645 Fix 2) ─────────────────────────────────

// The node's own resolved tailnet host is folded in so a same-node HUD is trusted.
test("addOwnHostToAllowlist: appends the node's own host", () => {
  const hosts = ["localhost", "127.0.0.1"];
  addOwnHostToAllowlist(hosts, "agentnode.example.ts.net");
  expect(hosts).toEqual(["localhost", "127.0.0.1", "agentnode.example.ts.net"]);
});

// Dedup: an already-listed host must not be doubled (e.g. operator set it manually too).
test("addOwnHostToAllowlist: does not double an already-listed host", () => {
  const hosts = ["localhost", "agentnode.example.ts.net"];
  addOwnHostToAllowlist(hosts, "agentnode.example.ts.net");
  expect(hosts).toEqual(["localhost", "agentnode.example.ts.net"]);
});

// Null/blank host (tailscale absent, or resolveNodeHost returned null) is a no-op.
test("addOwnHostToAllowlist: null or blank host is a no-op", () => {
  const hosts = ["localhost"];
  addOwnHostToAllowlist(hosts, null);
  addOwnHostToAllowlist(hosts, "   ");
  expect(hosts).toEqual(["localhost"]);
});

// A host with stray whitespace is trimmed before it lands in the allowlist.
test("addOwnHostToAllowlist: trims surrounding whitespace", () => {
  const hosts: string[] = [];
  addOwnHostToAllowlist(hosts, "  agentnode.example.ts.net  ");
  expect(hosts).toEqual(["agentnode.example.ts.net"]);
});

// ── addServedHostsToAllowlist (issue #1645 Fix 2/3) ───────────────────────────

// A Tailscale Service front (served under a different DNS name than the node's own) is folded
// in — the topology addOwnHostToAllowlist alone doesn't cover.
test("addServedHostsToAllowlist: folds a Service-fronted host in", () => {
  const json = JSON.stringify({
    Services: {
      "svc:shepherd": {
        Web: {
          "shepherd.example.ts.net:443": {
            Handlers: { "/": { Proxy: "http://localhost:7330" } },
          },
        },
      },
    },
  });
  const hosts = ["localhost", "127.0.0.1"];
  addServedHostsToAllowlist(hosts, json, 7330);
  expect(hosts).toEqual(["localhost", "127.0.0.1", "shepherd.example.ts.net"]);
});

// Dedup delegates to addOwnHostToAllowlist — an already-listed host is not doubled.
test("addServedHostsToAllowlist: does not double an already-listed host", () => {
  const json = JSON.stringify({
    Web: {
      "shepherd.example.ts.net:443": {
        Handlers: { "/": { Proxy: "http://localhost:7330" } },
      },
    },
  });
  const hosts = ["shepherd.example.ts.net"];
  addServedHostsToAllowlist(hosts, json, 7330);
  expect(hosts).toEqual(["shepherd.example.ts.net"]);
});

// Malformed/empty JSON and non-matching serve status are no-ops.
test("addServedHostsToAllowlist: malformed or empty JSON is a no-op", () => {
  const hosts = ["localhost"];
  addServedHostsToAllowlist(hosts, "not json", 7330);
  addServedHostsToAllowlist(hosts, "", 7330);
  expect(hosts).toEqual(["localhost"]);
});
