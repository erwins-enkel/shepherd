import { describe, it, expect, vi } from "vitest";
import { startPreview } from "./api";

function mockFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

describe("startPreview", () => {
  it("maps 200 ok → {ok, command}", async () => {
    globalThis.fetch = mockFetch(200, { ok: true, command: "npm run dev" });
    const result = await startPreview("s1");
    expect(result).toEqual({ ok: true, command: "npm run dev" });
  });

  it("maps 409 command_unknown → {needCommand: true}", async () => {
    globalThis.fetch = mockFetch(409, { error: "command_unknown" });
    const result = await startPreview("s1");
    expect(result).toEqual({ needCommand: true });
  });

  it("maps 409 already_bound → {alreadyBound: true}", async () => {
    globalThis.fetch = mockFetch(409, { error: "already_bound" });
    const result = await startPreview("s1");
    expect(result).toEqual({ alreadyBound: true });
  });

  it("throws on 404 (unknown/dead session)", async () => {
    globalThis.fetch = mockFetch(404, { error: "not found" });
    await expect(startPreview("s1")).rejects.toThrow("not found");
  });

  it("throws on other non-ok responses with the error message", async () => {
    globalThis.fetch = mockFetch(500, { error: "internal server error" });
    await expect(startPreview("s1")).rejects.toThrow("internal server error");
  });

  it("passes command in the request body when supplied", async () => {
    const calls: { body?: string }[] = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: { body?: string }) => {
      calls.push({ body: init?.body });
      return new Response(JSON.stringify({ ok: true, command: "yarn dev" }), { status: 200 });
    }) as unknown as typeof fetch;
    await startPreview("s1", "yarn dev");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ command: "yarn dev" });
  });

  it("omits command from body when not supplied", async () => {
    const calls: { body?: string }[] = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: { body?: string }) => {
      calls.push({ body: init?.body });
      return new Response(JSON.stringify({ ok: true, command: "npm run dev" }), { status: 200 });
    }) as unknown as typeof fetch;
    await startPreview("s1");
    expect(JSON.parse(calls[0]!.body!)).toEqual({});
  });

  it("reads the body exactly once — does not double-read a consumed stream", async () => {
    // The body is a ReadableStream that can only be consumed once.
    // We verify this by tracking how many times json() is called.
    let jsonCallCount = 0;
    const bodyObj = { ok: true, command: "bun run dev" };
    const bodyStr = JSON.stringify(bodyObj);
    globalThis.fetch = vi.fn(async () => {
      const resp = new Response(bodyStr, { status: 200 });
      const origJson = resp.json.bind(resp);
      resp.json = async () => {
        jsonCallCount++;
        return origJson();
      };
      return resp;
    }) as unknown as typeof fetch;
    await startPreview("s1");
    expect(jsonCallCount).toBe(1);
  });

  it("does not collapse two distinct 409 error codes together", async () => {
    globalThis.fetch = mockFetch(409, { error: "command_unknown" });
    const r1 = await startPreview("s1");
    expect("needCommand" in r1).toBe(true);

    globalThis.fetch = mockFetch(409, { error: "already_bound" });
    const r2 = await startPreview("s1");
    expect("alreadyBound" in r2).toBe(true);
  });
});
