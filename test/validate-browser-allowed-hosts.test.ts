import { test, expect } from "bun:test";
import { validateBrowserAllowedHosts, validateEgressExtraHosts } from "../src/validate";

test("accepts and normalizes exact hostnames", () => {
  expect(validateBrowserAllowedHosts([" App.Example.com ", "accounts.example.com"])).toEqual({
    ok: true,
    value: ["app.example.com", "accounts.example.com"],
  });
});

test("absent or null → empty list", () => {
  expect(validateBrowserAllowedHosts(undefined)).toEqual({ ok: true, value: [] });
  expect(validateBrowserAllowedHosts(null)).toEqual({ ok: true, value: [] });
});

test.each(["1.2.3.4", "https://x.com", "x.com:443", "*.x.com", "localhost", "x.com/path"])(
  "rejects %p",
  (h) => {
    expect(validateBrowserAllowedHosts(["ok.example.com", h]).ok).toBe(false);
  },
);

test("IP literal error names the entry", () => {
  const r = validateBrowserAllowedHosts(["1.2.3.4"]);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("IP literal");
});

test("egressExtraHosts validation is unchanged (still admits dotted-quad)", () => {
  expect(validateEgressExtraHosts(["1.2.3.4"])).toEqual({ ok: true, value: ["1.2.3.4"] });
});
