import { describe, it, expect, vi } from "vitest";
import { stopPreview } from "./api";

function mockFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

describe("stopPreview", () => {
  it("maps 200 → {killed}", async () => {
    globalThis.fetch = mockFetch(200, { killed: 2 });
    expect(await stopPreview("s1")).toEqual({ killed: 2 });
  });

  it("treats 200 killed:0 as a valid result (honest zero, not an error)", async () => {
    globalThis.fetch = mockFetch(200, { killed: 0 });
    expect(await stopPreview("s1")).toEqual({ killed: 0 });
  });

  it("defaults a missing killed count to 0", async () => {
    globalThis.fetch = mockFetch(200, {});
    expect(await stopPreview("s1")).toEqual({ killed: 0 });
  });

  it("maps 409 not_bound → {notBound: true} (benign race)", async () => {
    globalThis.fetch = mockFetch(409, { error: "not_bound" });
    expect(await stopPreview("s1")).toEqual({ notBound: true });
  });

  it("throws on 404 (unknown session)", async () => {
    globalThis.fetch = mockFetch(404, { error: "not found" });
    await expect(stopPreview("s1")).rejects.toThrow("not found");
  });

  it("throws on other non-ok responses with the error message", async () => {
    globalThis.fetch = mockFetch(500, { error: "internal server error" });
    await expect(stopPreview("s1")).rejects.toThrow("internal server error");
  });

  it("POSTs to the preview/stop route with no body", async () => {
    const calls: { url?: unknown; method?: string; body?: unknown }[] = [];
    globalThis.fetch = vi.fn(async (url: unknown, init?: { method?: string; body?: unknown }) => {
      calls.push({ url, method: init?.method, body: init?.body });
      return new Response(JSON.stringify({ killed: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    await stopPreview("s7");
    expect(calls[0]!.url).toBe("/api/sessions/s7/preview/stop");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toBeUndefined();
  });

  it("reads the body exactly once — does not double-read a consumed stream", async () => {
    let jsonCallCount = 0;
    globalThis.fetch = vi.fn(async () => {
      const resp = new Response(JSON.stringify({ killed: 1 }), { status: 200 });
      const origJson = resp.json.bind(resp);
      resp.json = async () => {
        jsonCallCount++;
        return origJson();
      };
      return resp;
    }) as unknown as typeof fetch;
    await stopPreview("s1");
    expect(jsonCallCount).toBe(1);
  });
});
