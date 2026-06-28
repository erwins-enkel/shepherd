import { describe, it, expect, vi } from "vitest";
import { invokePluginRoute } from "./api";

function mockFetchText(status: number, body: string): typeof fetch {
  return vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;
}

describe("invokePluginRoute", () => {
  it("returns trimmed text on ok response", async () => {
    globalThis.fetch = mockFetchText(200, "  hello world  ");
    const result = await invokePluginRoute("my-plugin", "GET", "status");
    expect(result).toBe("hello world");
  });

  it("returns empty string when response body is empty", async () => {
    globalThis.fetch = mockFetchText(200, "");
    const result = await invokePluginRoute("my-plugin", "GET", "ping");
    expect(result).toBe("");
  });

  it("caps response at 200 chars with ellipsis when longer", async () => {
    const long = "x".repeat(250);
    globalThis.fetch = mockFetchText(200, long);
    const result = await invokePluginRoute("my-plugin", "GET", "data");
    expect(result).toHaveLength(200);
    expect(result).toBe("x".repeat(199) + "…");
  });

  it("does not truncate a response of exactly 200 chars", async () => {
    const exact = "y".repeat(200);
    globalThis.fetch = mockFetchText(200, exact);
    const result = await invokePluginRoute("my-plugin", "GET", "data");
    expect(result).toBe(exact);
    expect(result).toHaveLength(200);
  });

  it("throws on non-ok response", async () => {
    globalThis.fetch = mockFetchText(500, JSON.stringify({ error: "plugin error" }));
    // The response body is JSON, which failed() will parse
    await expect(invokePluginRoute("my-plugin", "GET", "boom")).rejects.toThrow();
  });

  it("sends the request to the correct URL with the given method", async () => {
    const calls: { url: string; method: string }[] = [];
    globalThis.fetch = vi.fn(async (url: unknown, init?: { method?: string }) => {
      calls.push({ url: url as string, method: init?.method ?? "GET" });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    await invokePluginRoute("cap-plugin", "POST", "trigger");
    expect(calls[0]).toEqual({ url: "/api/plugins/cap-plugin/trigger", method: "POST" });
  });

  // ── body encoding (issue #1209) ────────────────────────────────────────────
  function captureInit(): { init?: RequestInit } {
    const cap: { init?: RequestInit } = {};
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      cap.init = init;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    return cap;
  }

  it("POST with a body sends JSON-stringified body + content-type header", async () => {
    const cap = captureInit();
    const body = { mode: "specific", account: 2 };
    await invokePluginRoute("cap-plugin", "POST", "switch-primary", body);
    expect(cap.init?.body).toBe(JSON.stringify(body));
    expect(cap.init?.headers).toEqual({ "content-type": "application/json" });
  });

  it("call without a body sends neither header nor request body (no-body callers unchanged)", async () => {
    const cap = captureInit();
    await invokePluginRoute("cap-plugin", "POST", "trigger");
    expect(cap.init?.body).toBeUndefined();
    expect(cap.init?.headers).toBeUndefined();
  });

  it("GET never attaches a body, even if one is mistakenly passed", async () => {
    const cap = captureInit();
    await invokePluginRoute("cap-plugin", "GET", "status", { should: "not-send" });
    expect(cap.init?.body).toBeUndefined();
    expect(cap.init?.headers).toBeUndefined();
  });
});
