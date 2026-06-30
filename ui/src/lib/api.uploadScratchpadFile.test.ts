import { describe, it, expect, vi, afterEach } from "vitest";
import { uploadScratchpadFile, ApiError } from "./api";

function mockFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

describe("uploadScratchpadFile", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("returns root-relative path on 200", async () => {
    globalThis.fetch = mockFetch(200, { path: "uploads/foo.txt" });
    const result = await uploadScratchpadFile("sess-1", new File(["x"], "foo.txt"));
    expect(result).toBe("uploads/foo.txt");
  });

  it("uses the session id and file in the request", async () => {
    const calls: { url: string; method: string }[] = [];
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET" });
      return new Response(JSON.stringify({ path: "uploads/bar.png" }), { status: 200 });
    }) as unknown as typeof fetch;
    await uploadScratchpadFile("sess-abc", new File(["data"], "bar.png"));
    expect(calls[0]?.url).toBe("/api/sessions/sess-abc/scratchpad/upload");
    expect(calls[0]?.method).toBe("POST");
  });

  it("appends ?path= when dirPath is given", async () => {
    const calls: { url: string }[] = [];
    globalThis.fetch = vi.fn(async (url: unknown) => {
      calls.push({ url: String(url) });
      return new Response(JSON.stringify({ path: "sub/file.txt" }), { status: 200 });
    }) as unknown as typeof fetch;
    await uploadScratchpadFile("s1", new File(["x"], "file.txt"), "sub");
    expect(calls[0]?.url).toBe("/api/sessions/s1/scratchpad/upload?path=sub");
  });

  it("throws ApiError with status 413 on too-large response", async () => {
    globalThis.fetch = mockFetch(413, { error: "file too large" });
    const err = await uploadScratchpadFile("s1", new File(["x"], "big.zip")).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(413);
    expect((err as ApiError).message).toBe("file too large");
  });

  it("throws ApiError with status 400 on missing file error", async () => {
    globalThis.fetch = mockFetch(400, { error: "no file" });
    const err = await uploadScratchpadFile("s1", new File([""], "empty")).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
  });

  it("throws ApiError with status 404 on unknown session", async () => {
    globalThis.fetch = mockFetch(404, { error: "session not found" });
    const err = await uploadScratchpadFile("bad-id", new File(["x"], "x.txt")).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
  });

  it("falls back to status message when body carries no error field", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("not json", { status: 500 }),
    ) as unknown as typeof fetch;
    const err = await uploadScratchpadFile("s1", new File(["x"], "x.txt")).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
    expect((err as ApiError).message).toContain("upload failed: 500");
  });
});
