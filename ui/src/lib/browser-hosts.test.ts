import { describe, it, expect } from "vitest";
import { checkBrowserHost } from "./browser-hosts";

describe("checkBrowserHost", () => {
  it("normalizes a valid hostname", () => {
    expect(checkBrowserHost("  App.Example.com ", [])).toEqual({
      ok: true,
      host: "app.example.com",
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
