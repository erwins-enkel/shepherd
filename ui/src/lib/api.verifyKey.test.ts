import { describe, it, expect, vi } from "vitest";
import { verifyApiKey } from "./api";

function mockFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

describe("verifyApiKey", () => {
  it("POSTs to /api/settings/verify-key with an empty body", async () => {
    const calls: { url?: string; method?: string; body?: string }[] = [];
    globalThis.fetch = vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
      calls.push({ url: String(url), method: init?.method, body: init?.body });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    await verifyApiKey();
    expect(calls[0]!.url).toBe("/api/settings/verify-key");
    expect(calls[0]!.method).toBe("POST");
    expect(JSON.parse(calls[0]!.body!)).toEqual({});
  });

  it("returns {ok:true} on a passing verdict", async () => {
    globalThis.fetch = mockFetch(200, { ok: true });
    expect(await verifyApiKey()).toEqual({ ok: true });
  });

  it("returns the failure verdict verbatim (reason + detail)", async () => {
    globalThis.fetch = mockFetch(200, {
      ok: false,
      reason: "not-authenticated",
      detail: "invalid x-api-key",
    });
    expect(await verifyApiKey()).toEqual({
      ok: false,
      reason: "not-authenticated",
      detail: "invalid x-api-key",
    });
  });

  it("throws when the endpoint is unwired (503)", async () => {
    globalThis.fetch = mockFetch(503, { error: "not wired" });
    await expect(verifyApiKey()).rejects.toThrow();
  });
});
