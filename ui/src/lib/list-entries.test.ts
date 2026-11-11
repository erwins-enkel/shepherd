import { describe, it, expect } from "vitest";
import {
  checkBrowserHost,
  checkEgressHost,
  checkPriorityLabel,
  isWildcardEgressEntry,
  PRIORITY_LABEL,
} from "./list-entries";

describe("checkBrowserHost", () => {
  it("normalizes a valid hostname", () => {
    expect(checkBrowserHost("  App.Example.com ", [])).toEqual({
      ok: true,
      value: "app.example.com",
    });
  });

  it("rejects empty input", () => {
    expect(checkBrowserHost("   ", [])).toEqual({ ok: false, reason: "empty" });
  });

  it.each(["1.2.3.4", "10.0.0.1"])("rejects IP literal %s", (h) => {
    expect(checkBrowserHost(h, [])).toEqual({ ok: false, reason: "ip" });
  });

  it.each(["https://x.com", "x.com:443", "*.x.com", "localhost", "x.com/a", "-x.com", "x..com"])(
    "rejects %s as invalid",
    (h) => {
      expect(checkBrowserHost(h, [])).toEqual({ ok: false, reason: "invalid" });
    },
  );

  it("rejects a duplicate after normalizing", () => {
    expect(checkBrowserHost("A.example.com", ["a.example.com"])).toEqual({
      ok: false,
      reason: "duplicate",
    });
  });
});

describe("checkEgressHost", () => {
  it("normalizes a valid hostname", () => {
    expect(checkEgressHost("  Registry.Example.com ", [])).toEqual({
      ok: true,
      value: "registry.example.com",
    });
  });

  it("accepts a dotted-quad, as the server does", () => {
    expect(checkEgressHost("10.0.0.1", [])).toEqual({ ok: true, value: "10.0.0.1" });
  });

  it("rejects empty input", () => {
    expect(checkEgressHost("   ", [])).toEqual({ ok: false, reason: "empty" });
  });

  it.each([
    ["*.Example.com", "*.example.com"],
    ["git.example.com:8443", "git.example.com:8443"],
    ["*.example.com:22", "*.example.com:22"],
    ["x.com:443", "x.com"],
    ["*.x.com:443", "*.x.com"],
    ["x.com:65535", "x.com:65535"],
  ])("accepts %s as %s", (raw, value) => {
    expect(checkEgressHost(raw, [])).toEqual({ ok: true, value });
  });

  it.each([
    "https://x.com",
    "localhost",
    "x.com/a",
    "-x.com",
    "x-.com",
    "x..com",
    "a_b.com",
    "a b.com",
    "*.com",
    "*x.com",
    "a.*.com",
    "*.*.x.com",
    "*.1.2.3.4",
    "x.com:",
    "x.com:0",
    "x.com:0443",
    "x.com:65536",
    "x.com:22:23",
  ])("rejects %s as invalid", (h) => {
    expect(checkEgressHost(h, [])).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a duplicate after normalizing", () => {
    expect(checkEgressHost("A.example.com", ["a.example.com"])).toEqual({
      ok: false,
      reason: "duplicate",
    });
    expect(checkEgressHost("a.example.com:443", ["a.example.com"])).toEqual({
      ok: false,
      reason: "duplicate",
    });
  });
});

describe("isWildcardEgressEntry", () => {
  it("flags only *. entries", () => {
    expect(isWildcardEgressEntry("*.example.com")).toBe(true);
    expect(isWildcardEgressEntry("*.example.com:22")).toBe(true);
    expect(isWildcardEgressEntry("example.com")).toBe(false);
  });
});

describe("checkPriorityLabel", () => {
  it("trims a label and keeps its case", () => {
    expect(checkPriorityLabel("  CI-Gate-Rot ", [])).toEqual({ ok: true, value: "CI-Gate-Rot" });
  });

  it.each(["", "   "])("rejects %j as empty, as the server does", (l) => {
    expect(checkPriorityLabel(l, [])).toEqual({ ok: false, reason: "empty" });
  });

  it("rejects an exact repeat, including the built-in label", () => {
    expect(checkPriorityLabel(" urgent ", [PRIORITY_LABEL, "urgent"])).toEqual({
      ok: false,
      reason: "duplicate",
    });
    expect(checkPriorityLabel(PRIORITY_LABEL, [PRIORITY_LABEL])).toEqual({
      ok: false,
      reason: "duplicate",
    });
  });

  it("matches case-sensitively", () => {
    expect(checkPriorityLabel("Urgent", ["urgent"])).toEqual({ ok: true, value: "Urgent" });
  });
});
