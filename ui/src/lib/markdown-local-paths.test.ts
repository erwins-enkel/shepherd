import { describe, expect, it, vi } from "vitest";
import { fileTargetOf, localPathOf, memoLocate } from "./markdown-local-paths";

describe("localPathOf (#3997)", () => {
  it.each([
    ["/home/u/.local/state/x/report.md", "/home/u/.local/state/x/report.md"],
    ["/home/u/my%20report.md", "/home/u/my report.md"],
    ["/repo/src/a.ts#L10", "/repo/src/a.ts"],
    ["/repo/a.md?x=1", "/repo/a.md"],
    ["/bad%E0%A4%A", "/bad%E0%A4%A"],
    ["file:///home/u/x.md", "/home/u/x.md"],
    ["file://localhost/home/u/x%20y.md", "/home/u/x y.md"],
    ["~/notes/x.md", "~/notes/x.md"],
  ])("%s → %s", (href, path) => {
    expect(localPathOf(href)).toBe(path);
  });

  it.each([
    "https://example.com/x",
    "mailto:a@b.c",
    "#steps",
    "//host/x",
    "relative/x.md",
    "file://otherhost/x",
    "",
  ])("%s is not a host path", (href) => {
    expect(localPathOf(href)).toBeNull();
  });
});

describe("memoLocate", () => {
  it("asks once per session and path, and caches failures as null", async () => {
    const t = { source: "worktree" as const, path: "a.md", type: "file" as const };
    const locate = vi.fn(async (id: string) => {
      if (id === "bad") throw new Error("500");
      return t;
    });
    const cached = memoLocate(locate);
    expect(await cached("s1", "/w/a.md")).toEqual(t);
    expect(await cached("s1", "/w/a.md")).toEqual(t);
    expect(await cached("s2", "/w/a.md")).toEqual(t);
    expect(await cached("bad", "/w/a.md")).toBeNull();
    expect(await cached("bad", "/w/a.md")).toBeNull();
    expect(locate).toHaveBeenCalledTimes(3);
  });
});

describe("fileTargetOf (#4017)", () => {
  const btn = (attrs: Record<string, string>) =>
    ({ getAttribute: (k: string) => attrs[k] ?? null }) as unknown as Element;

  it("reads host, worktree and scratchpad targets; unknown falls back to scratchpad", () => {
    expect(
      fileTargetOf(btn({ "data-source": "host", "data-rel": "/h/r.md", "data-type": "file" })),
    ).toEqual({ source: "host", path: "/h/r.md", type: "file" });
    expect(
      fileTargetOf(btn({ "data-source": "worktree", "data-rel": "a", "data-type": "dir" })),
    ).toEqual({ source: "worktree", path: "a", type: "dir" });
    expect(fileTargetOf(btn({ "data-source": "x" })).source).toBe("scratchpad");
  });
});
