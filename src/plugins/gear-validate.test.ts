// Unit tests for validatePluginGearItem (src/plugins/ui-validate.ts).

import { describe, expect, it } from "bun:test";
import { validatePluginGearItem } from "./ui-validate";

// ── helpers ──────────────────────────────────────────────────────────────────

const urlItem = (href: string) => ({
  label: "Open",
  action: { kind: "url", href },
});

const routeItem = (method: string, path: string) => ({
  label: "Check",
  action: { kind: "route", method, path },
});

const panelItem = () => ({
  label: "Settings",
  action: { kind: "panel" },
});

// ── valid cases ───────────────────────────────────────────────────────────────

describe("validatePluginGearItem — valid", () => {
  it("accepts a valid url action", () => {
    const result = validatePluginGearItem(urlItem("https://example.com/path"));
    expect(result).not.toBeNull();
    expect(result?.action).toEqual({ kind: "url", href: "https://example.com/path" });
  });

  it("accepts http:// url action", () => {
    const result = validatePluginGearItem(urlItem("http://example.com"));
    expect(result).not.toBeNull();
    expect((result?.action as { kind: "url"; href: string }).href).toBe("http://example.com");
  });

  it("accepts a valid GET route action", () => {
    const result = validatePluginGearItem(routeItem("GET", "status/check"));
    expect(result).not.toBeNull();
    expect(result?.action).toEqual({ kind: "route", method: "GET", path: "status/check" });
  });

  it("accepts a valid POST route action", () => {
    const result = validatePluginGearItem(routeItem("POST", "actions/run"));
    expect(result).not.toBeNull();
    expect(result?.action).toEqual({ kind: "route", method: "POST", path: "actions/run" });
  });

  it("accepts a panel action", () => {
    const result = validatePluginGearItem(panelItem());
    expect(result).not.toBeNull();
    expect(result?.action).toEqual({ kind: "panel" });
  });

  it("accepts an optional icon within length limit", () => {
    const item = { label: "Go", icon: "⚙️", action: { kind: "panel" } };
    const result = validatePluginGearItem(item);
    expect(result).not.toBeNull();
    expect(result?.icon).toBe("⚙️");
  });

  it("returns normalized (re-parsed) item", () => {
    const item = { label: "Go", action: { kind: "panel" }, extra: undefined };
    const result = validatePluginGearItem(item);
    expect(result).not.toBeNull();
    // non-JSON props stripped; label/action preserved
    expect(result?.label).toBe("Go");
  });
});

// ── url action rejections ─────────────────────────────────────────────────────

describe("validatePluginGearItem — url rejections", () => {
  it("rejects javascript: url", () => {
    expect(validatePluginGearItem(urlItem("javascript:alert(1)"))).toBeNull();
  });

  it("rejects data: url", () => {
    expect(validatePluginGearItem(urlItem("data:text/html,<h1>hi</h1>"))).toBeNull();
  });

  it("rejects file: url", () => {
    expect(validatePluginGearItem(urlItem("file:///etc/passwd"))).toBeNull();
  });

  it("rejects relative url", () => {
    expect(validatePluginGearItem(urlItem("/relative/path"))).toBeNull();
  });

  it("rejects unparseable url", () => {
    expect(validatePluginGearItem(urlItem("not a url at all"))).toBeNull();
  });

  it("rejects ftp: url", () => {
    expect(validatePluginGearItem(urlItem("ftp://example.com"))).toBeNull();
  });
});

// ── route action rejections ───────────────────────────────────────────────────

describe("validatePluginGearItem — route rejections", () => {
  it("rejects method PUT", () => {
    expect(validatePluginGearItem(routeItem("PUT", "some/path"))).toBeNull();
  });

  it("rejects lowercase method get", () => {
    expect(validatePluginGearItem(routeItem("get", "some/path"))).toBeNull();
  });

  it("rejects lowercase method post", () => {
    expect(validatePluginGearItem(routeItem("post", "some/path"))).toBeNull();
  });

  it("rejects path with leading /", () => {
    expect(validatePluginGearItem(routeItem("GET", "/absolute/path"))).toBeNull();
  });

  it("rejects path with .. segment", () => {
    expect(validatePluginGearItem(routeItem("GET", "foo/../etc/passwd"))).toBeNull();
  });

  it("rejects path with leading .. segment", () => {
    expect(validatePluginGearItem(routeItem("GET", "../secret"))).toBeNull();
  });

  it("rejects empty path", () => {
    expect(validatePluginGearItem(routeItem("GET", ""))).toBeNull();
  });

  it("rejects path > 256 chars", () => {
    expect(validatePluginGearItem(routeItem("GET", "a".repeat(257)))).toBeNull();
  });

  it("rejects path with invalid chars (space)", () => {
    expect(validatePluginGearItem(routeItem("GET", "foo bar"))).toBeNull();
  });
});

// ── label / icon rejections ───────────────────────────────────────────────────

describe("validatePluginGearItem — label/icon rejections", () => {
  it("rejects empty label", () => {
    expect(validatePluginGearItem({ label: "", action: { kind: "panel" } })).toBeNull();
  });

  it("rejects whitespace-only label", () => {
    expect(validatePluginGearItem({ label: "   ", action: { kind: "panel" } })).toBeNull();
  });

  it("rejects label > 80 chars", () => {
    expect(validatePluginGearItem({ label: "a".repeat(81), action: { kind: "panel" } })).toBeNull();
  });

  it("accepts label of exactly 80 chars", () => {
    expect(
      validatePluginGearItem({ label: "a".repeat(80), action: { kind: "panel" } }),
    ).not.toBeNull();
  });

  it("rejects icon > 8 chars", () => {
    expect(
      validatePluginGearItem({ label: "Go", icon: "123456789", action: { kind: "panel" } }),
    ).toBeNull();
  });

  it("rejects icon that is not a string", () => {
    expect(validatePluginGearItem({ label: "Go", icon: 42, action: { kind: "panel" } })).toBeNull();
  });
});

// ── unknown kind ──────────────────────────────────────────────────────────────

describe("validatePluginGearItem — unknown kind", () => {
  it("rejects unknown action kind", () => {
    expect(validatePluginGearItem({ label: "Go", action: { kind: "popup" } })).toBeNull();
  });

  it("rejects missing action", () => {
    expect(validatePluginGearItem({ label: "Go" })).toBeNull();
  });

  it("rejects action that is not an object", () => {
    expect(validatePluginGearItem({ label: "Go", action: "panel" })).toBeNull();
  });
});

// ── structural / serialization rejections ─────────────────────────────────────

describe("validatePluginGearItem — structural rejections", () => {
  it("rejects null", () => {
    expect(validatePluginGearItem(null)).toBeNull();
  });

  it("rejects undefined", () => {
    expect(validatePluginGearItem(undefined)).toBeNull();
  });

  it("rejects a string", () => {
    expect(validatePluginGearItem("panel")).toBeNull();
  });

  it("rejects a non-serializable (cyclic) object → null", () => {
    const obj: Record<string, unknown> = { label: "Go", action: { kind: "panel" } };
    obj.self = obj; // cycle
    expect(validatePluginGearItem(obj)).toBeNull();
  });

  it("rejects oversized JSON (> 8 KB)", () => {
    const big = { label: "Go", action: { kind: "panel" }, data: "x".repeat(9000) };
    expect(validatePluginGearItem(big)).toBeNull();
  });
});
