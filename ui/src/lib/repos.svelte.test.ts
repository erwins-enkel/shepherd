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
