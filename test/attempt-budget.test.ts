import { expect, test } from "bun:test";
import { AttemptBudget, PeerThrottle, hasProxyHeaders, throttleKey } from "../src/attempt-budget";

test("allows 10 attempts per peer per window, then refuses", () => {
  const budget = new AttemptBudget(() => 0);
  for (let i = 0; i < 10; i++) expect(budget.allowAttempt("a")).toBe(true);
  expect(budget.allowAttempt("a")).toBe(false);
  expect(budget.allowAttempt("b")).toBe(true); // buckets are per peer
});

test("window expiry resets the bucket", () => {
  let now = 0;
  const budget = new AttemptBudget(() => now);
  for (let i = 0; i < 11; i++) budget.allowAttempt("a");
  expect(budget.allowAttempt("a")).toBe(false);
  now = 60_000;
  expect(budget.allowAttempt("a")).toBe(true);
});

test("peer table saturation fails closed for new peers", () => {
  const budget = new AttemptBudget(() => 0);
  for (let i = 0; i < 1024; i++) expect(budget.allowAttempt(`p${i}`)).toBe(true);
  expect(budget.allowAttempt("new")).toBe(false);
  expect(budget.allowAttempt("p0")).toBe(true); // existing buckets still count normally
});

test("a global cap bounds every peer together, and resets with its window (#3338)", () => {
  let now = 0;
  const budget = new AttemptBudget(() => now, 25);
  for (let i = 0; i < 25; i++) expect(budget.allowAttempt(`p${i}`)).toBe(true);
  expect(budget.allowAttempt("fresh")).toBe(false);
  now = 60_000;
  expect(budget.allowAttempt("fresh")).toBe(true);
});

test("a peer over its own limit does not drain the global pool (#3338)", () => {
  const budget = new AttemptBudget(() => 0, 25);
  for (let i = 0; i < 100; i++) budget.allowAttempt("noisy");
  // noisy got 10 through; 15 remain for everyone else
  for (let i = 0; i < 15; i++) expect(budget.allowAttempt(`p${i}`)).toBe(true);
  expect(budget.allowAttempt("late")).toBe(false);
});

// ── loopback proxy split (#3368) ────────────────────────────────────────────

const req = (headers: Record<string, string> = {}) => new Request("http://x/", { headers });

test("throttleKey: non-loopback peers key on the address, ignoring proxy headers", () => {
  const forged = req({ "tailscale-user-login": "op@x", "x-forwarded-for": "1.2.3.4" });
  expect(throttleKey(forged, "100.64.0.5", "trusted")).toEqual({
    proxied: false,
    key: "100.64.0.5",
  });
  expect(throttleKey(req(), undefined, "trusted")).toEqual({ proxied: false, key: "unknown" });
});

test("throttleKey: raw loopback shares one bucket; trusted proxied loopback keys on its identity", () => {
  expect(throttleKey(req(), "127.0.0.1", "trusted")).toEqual({ proxied: false, key: "loopback" });
  expect(throttleKey(req(), "::1", "trusted")).toEqual({ proxied: false, key: "loopback" });
  expect(throttleKey(req({ "tailscale-user-login": "op@x" }), "127.0.0.1", "trusted")).toEqual({
    proxied: true,
    key: "ts:op@x",
  });
  expect(throttleKey(req({ "x-forwarded-for": "9.9.9.9, 100.64.0.7 " }), "::1", "trusted")).toEqual(
    {
      proxied: true,
      key: "xff:100.64.0.7",
    },
  );
  expect(throttleKey(req({ "x-forwarded-host": "h.ts.net" }), "127.0.0.1", "trusted")).toEqual({
    proxied: true,
    key: "proxied",
  });
  expect(
    throttleKey(req({ "tailscale-user-login": "a".repeat(1000) }), "127.0.0.1", "trusted").key
      .length,
  ).toBeLessThanOrEqual(256);
});

test("PeerThrottle: a raw loopback client at its limit cannot lock out a proxied operator", () => {
  const throttle = new PeerThrottle(() => 0, undefined, 30);
  const raw = throttleKey(req(), "127.0.0.1", "trusted");
  for (let i = 0; i < 50; i++) throttle.allowAttempt(raw);
  expect(throttle.allowAttempt(raw)).toBe(false);
  expect(
    throttle.allowAttempt(
      throttleKey(req({ "tailscale-user-login": "op@x" }), "127.0.0.1", "trusted"),
    ),
  ).toBe(true);
});

test("PeerThrottle: the proxied class cap bounds forged identities, not direct peers", () => {
  const throttle = new PeerThrottle(() => 0, undefined, 30);
  for (let i = 0; i < 30; i++)
    expect(throttle.allowAttempt({ proxied: true, key: `f${i}` })).toBe(true);
  expect(throttle.allowAttempt({ proxied: true, key: "fresh" })).toBe(false);
  expect(throttle.allowAttempt({ proxied: false, key: "loopback" })).toBe(true);
  expect(throttle.allowAttempt({ proxied: false, key: "10.0.0.1" })).toBe(true);
});

// ── proxy trust by socket owner (#3368 follow-up, audit run-2 R2-F12) ───────

const FORGED = [
  req({ "tailscale-user-login": "op@x" }),
  req({ "x-forwarded-for": "9.9.9.9" }),
  req({ forwarded: "for=9.9.9.9" }),
  req({ "x-forwarded-host": "h.ts.net" }),
];

test("throttleKey: an untrusted loopback socket is raw whatever proxy headers it forges", () => {
  for (const r of FORGED)
    expect(throttleKey(r, "127.0.0.1", "untrusted")).toEqual({ proxied: false, key: "loopback" });
  expect(throttleKey(FORGED[0]!, "100.64.0.5", "untrusted")).toEqual({
    proxied: false,
    key: "100.64.0.5",
  });
});

test("throttleKey: no lookup on this platform keeps the header classification (#3386)", () => {
  expect(throttleKey(FORGED[0]!, "127.0.0.1", "unavailable")).toEqual({
    proxied: true,
    key: "ts:op@x",
  });
  expect(throttleKey(req(), "127.0.0.1", "unavailable")).toEqual({
    proxied: false,
    key: "loopback",
  });
});

test("hasProxyHeaders: any forwarding or Tailscale identity header", () => {
  for (const r of FORGED) expect(hasProxyHeaders(r)).toBe(true);
  expect(hasProxyHeaders(req({ "x-forwarded-proto": "https" }))).toBe(true);
  expect(hasProxyHeaders(req())).toBe(false);
});

test("PeerThrottle: forged untrusted traffic cannot drain or share the operator's bucket", () => {
  const throttle = new PeerThrottle(() => 0, undefined, 30);
  for (let i = 0; i < 40; i++) {
    const forged = req({ "x-forwarded-for": `10.0.0.${i}`, "tailscale-user-login": "op@x" });
    throttle.allowAttempt(throttleKey(forged, "127.0.0.1", "untrusted"));
  }
  expect(throttle.allowAttempt(throttleKey(req(), "127.0.0.1", "untrusted"))).toBe(false);
  const operator = throttleKey(req({ "tailscale-user-login": "op@x" }), "127.0.0.1", "trusted");
  expect(throttle.allowAttempt(operator)).toBe(true);
});

test("PeerThrottle: brute force from one trusted identity is still capped", () => {
  const throttle = new PeerThrottle(() => 0, undefined, 30);
  const key = throttleKey(req({ "tailscale-user-login": "op@x" }), "127.0.0.1", "trusted");
  for (let i = 0; i < 10; i++) expect(throttle.allowAttempt(key)).toBe(true);
  expect(throttle.allowAttempt(key)).toBe(false);
});
