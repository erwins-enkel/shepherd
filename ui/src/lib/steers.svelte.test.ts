import { describe, it, expect, vi, beforeEach } from "vitest";
import { steers } from "./steers.svelte";

beforeEach(() => {
  steers.list = [];
  steers.error = null;
  steers.loaded = false;
});

describe("steers store", () => {
  it("load() populates the list from GET /api/steers", async () => {
    const data = [{ id: "a", label: "x", text: "y", inSteerBar: true, onIssues: false }];
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify(data), { status: 200 }),
    ) as unknown as typeof fetch;
    await steers.load();
    expect(steers.list).toEqual(data);
    expect(steers.loaded).toBe(true);
  });

  it("load() backfills surface scopes a pre-scopes backend omits (no vanishing)", async () => {
    // an older backend returns steers without inSteerBar/onIssues
    const legacy = [{ id: "a", label: "x", text: "y" }];
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify(legacy), { status: 200 }),
    ) as unknown as typeof fetch;
    await steers.load();
    // defaults to a bar chip so it still renders somewhere
    expect(steers.list[0]!.inSteerBar).toBe(true);
    expect(steers.list[0]!.onIssues).toBe(false);
  });

  it("save() PUTs the list and adopts the normalized result", async () => {
    const normalized = [{ id: "srv", label: "a", text: "b", inSteerBar: true, onIssues: false }];
    const calls: { method?: string }[] = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: { method?: string }) => {
      calls.push({ method: init?.method });
      return new Response(JSON.stringify(normalized), { status: 200 });
    }) as unknown as typeof fetch;
    await steers.save([{ id: "tmp", label: "a", text: "b", inSteerBar: true, onIssues: false }]);
    expect(calls[0]!.method).toBe("PUT");
    expect(steers.list).toEqual(normalized);
  });
});
