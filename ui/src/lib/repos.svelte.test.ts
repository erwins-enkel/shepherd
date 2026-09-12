import { describe, it, expect, vi, beforeEach } from "vitest";
import { repos } from "./repos.svelte";

beforeEach(() => {
  repos.entries = [];
  repos.error = null;
  repos.loaded = false;
});

describe("repos store", () => {
  it("load() populates entries from GET /api/repos", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            repos: [
              {
                name: "alpha",
                path: "/root/alpha",
                display: "/root/alpha",
                realPath: "/root/alpha",
              },
            ],
            recentWindowDays: 14,
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    await repos.load();
    expect(repos.entries).toEqual([
      { name: "alpha", path: "/root/alpha", display: "/root/alpha", realPath: "/root/alpha" },
    ]);
    expect(repos.loaded).toBe(true);
  });

  // #1800: demo mode answered GET /api/repos with `{}` (no handler, permissive fallback),
  // so `entries` became `undefined` and the `pathIndex` $derived threw
  // `undefined.flatMap` INSIDE Svelte's flush — aborting the whole batch and silently
  // dropping unrelated DOM/effects app-wide. A shapeless body must degrade to "no repos".
  it("load() keeps entries an array when the body carries no repos", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({}), { status: 200 }),
    ) as unknown as typeof fetch;
    await repos.load();
    expect(repos.entries).toEqual([]);
    expect(repos.loaded).toBe(true);
    // The $derived over entries must still be readable — this is what used to throw.
    expect(repos.nameFor("/root/alpha")).toBeNull();
    expect(repos.knownNames).toEqual([]);
  });

  it("load() keeps entries an array when repos is not an array at all", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ repos: null, recentWindowDays: 14 }), { status: 200 }),
    ) as unknown as typeof fetch;
    await repos.load();
    expect(repos.entries).toEqual([]);
    expect(repos.nameFor("/root/alpha")).toBeNull();
  });

  it("nameFor resolves both the raw path and the realPath to the same name", () => {
    repos.entries = [
      { name: "beta", path: "/root/beta", display: "/root/beta", realPath: "/elsewhere/beta-real" },
    ];
    expect(repos.nameFor("/root/beta")).toBe("beta");
    expect(repos.nameFor("/elsewhere/beta-real")).toBe("beta");
  });

  it("nameFor returns null for an unknown path", () => {
    repos.entries = [
      { name: "alpha", path: "/root/alpha", display: "/root/alpha", realPath: "/root/alpha" },
    ];
    expect(repos.nameFor("/root/unknown")).toBeNull();
  });

  it("knownNames is a sorted, unique list of entry names", () => {
    repos.entries = [
      { name: "beta", path: "/root/beta", display: "/root/beta", realPath: "/root/beta" },
      { name: "alpha", path: "/root/alpha", display: "/root/alpha", realPath: "/root/alpha" },
    ];
    expect(repos.knownNames).toEqual(["alpha", "beta"]);
  });
});
