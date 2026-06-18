import { describe, it, expect, vi } from "vitest";
import { branchStatus } from "./api";

function mockFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

describe("branchStatus", () => {
  it("fetches the correct URL with encoded params and returns parsed result", async () => {
    const payload = { behind: 3, ahead: 0, diverged: false, hasUpstream: true, localExists: true };
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: unknown) => {
      calls.push(url as string);
      return new Response(JSON.stringify(payload), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await branchStatus("/my/repo path", "feature/my-branch");
    expect(result).toEqual(payload);
    expect(calls[0]).toBe("/api/branch-status?repo=%2Fmy%2Frepo%20path&branch=feature%2Fmy-branch");
  });

  it("returns diverged:true when server reports diverged", async () => {
    const payload = { behind: 2, ahead: 1, diverged: true, hasUpstream: true, localExists: true };
    globalThis.fetch = mockFetch(200, payload);
    const result = await branchStatus("/repo", "main");
    expect(result.diverged).toBe(true);
    expect(result.behind).toBe(2);
    expect(result.ahead).toBe(1);
  });

  it("returns behind:0 ahead:0 diverged:false when up to date", async () => {
    const payload = { behind: 0, ahead: 0, diverged: false, hasUpstream: true, localExists: true };
    globalThis.fetch = mockFetch(200, payload);
    const result = await branchStatus("/repo", "main");
    expect(result.behind).toBe(0);
    expect(result.diverged).toBe(false);
  });

  it("throws on non-ok response", async () => {
    globalThis.fetch = mockFetch(500, { error: "internal server error" });
    await expect(branchStatus("/repo", "main")).rejects.toThrow();
  });

  it("throws on 404", async () => {
    globalThis.fetch = mockFetch(404, { error: "not found" });
    await expect(branchStatus("/repo", "nonexistent")).rejects.toThrow();
  });
});
