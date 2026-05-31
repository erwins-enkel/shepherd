import { describe, it, expect, vi, beforeEach } from "vitest";
import { projectIcons } from "./projectIcons.svelte";

beforeEach(() => {
  projectIcons.map = {};
  projectIcons.error = null;
  projectIcons.loaded = false;
});

describe("projectIcons store", () => {
  it("load() populates the map from GET /api/project-icons", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ "/a": "📦" }), { status: 200 }),
    ) as unknown as typeof fetch;
    await projectIcons.load();
    expect(projectIcons.map).toEqual({ "/a": "📦" });
    expect(projectIcons.loaded).toBe(true);
  });

  it("iconFor returns the emoji when set and null otherwise", () => {
    projectIcons.map = { "/a": "🚀" };
    expect(projectIcons.iconFor("/a")).toBe("🚀");
    expect(projectIcons.iconFor("/missing")).toBeNull();
  });

  it("set() PUTs the patch and adopts the returned map", async () => {
    const calls: { method?: string; body?: string }[] = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: { method?: string; body?: string }) => {
      calls.push({ method: init?.method, body: init?.body });
      return new Response(JSON.stringify({ "/a": "🎨" }), { status: 200 });
    }) as unknown as typeof fetch;
    await projectIcons.set("/a", "🎨");
    expect(calls[0]!.method).toBe("PUT");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ path: "/a", emoji: "🎨" });
    expect(projectIcons.map).toEqual({ "/a": "🎨" });
  });

  it("apply() replaces the map (WS broadcast)", () => {
    projectIcons.apply({ "/b": "🤖" });
    expect(projectIcons.map).toEqual({ "/b": "🤖" });
  });
});
