import { describe, it, expect, vi, beforeEach } from "vitest";
import { steers } from "./steers.svelte";

beforeEach(() => {
  steers.list = [];
  steers.error = null;
  steers.loaded = false;
});

describe("steers store", () => {
  it("load() populates the list from GET /api/steers", async () => {
    const data = [{ id: "a", label: "x", text: "y" }];
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify(data), { status: 200 }),
    ) as unknown as typeof fetch;
    await steers.load();
    expect(steers.list).toEqual(data);
    expect(steers.loaded).toBe(true);
  });

  it("save() PUTs the list and adopts the normalized result", async () => {
    const normalized = [{ id: "srv", label: "a", text: "b" }];
    const calls: { method?: string }[] = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: { method?: string }) => {
      calls.push({ method: init?.method });
      return new Response(JSON.stringify(normalized), { status: 200 });
    }) as unknown as typeof fetch;
    await steers.save([{ id: "tmp", label: "a", text: "b" }]);
    expect(calls[0].method).toBe("PUT");
    expect(steers.list).toEqual(normalized);
  });
});
