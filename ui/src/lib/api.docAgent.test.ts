import { describe, it, expect, vi } from "vitest";
import { triggerDocAgent, getDocAgentRuns } from "./api";

function mockFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

describe("triggerDocAgent", () => {
  it("POSTs to /api/doc-agent with the encoded repoPath and returns started:true on 202", async () => {
    const calls: { url?: string; method?: string }[] = [];
    globalThis.fetch = vi.fn(async (url: unknown, init?: { method?: string }) => {
      calls.push({ url: String(url), method: init?.method });
      return new Response(JSON.stringify({ ok: true }), { status: 202 });
    }) as unknown as typeof fetch;
    const result = await triggerDocAgent("/repos/my project");
    expect(result).toEqual({ started: true });
    expect(calls[0]!.url).toBe("/api/doc-agent?repo=%2Frepos%2Fmy%20project");
    expect(calls[0]!.method).toBe("POST");
  });

  it("returns started:false with reason on 409 (already running / skipped)", async () => {
    globalThis.fetch = mockFetch(409, { ok: false, reason: "already_running" });
    const result = await triggerDocAgent("/repos/my-project");
    expect(result).toEqual({ started: false, reason: "already_running" });
  });

  it("throws on 404 (feature disabled)", async () => {
    globalThis.fetch = mockFetch(404, { error: "not found" });
    await expect(triggerDocAgent("/repos/my-project")).rejects.toThrow();
  });

  it("throws on 400 (bad request)", async () => {
    globalThis.fetch = mockFetch(400, { error: "missing repo" });
    await expect(triggerDocAgent("/repos/my-project")).rejects.toThrow();
  });
});

describe("getDocAgentRuns", () => {
  it("GETs /api/doc-agent/runs with the encoded repoPath", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: unknown) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ running: false, runs: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await getDocAgentRuns("/repos/my project");
    expect(calls[0]).toBe("/api/doc-agent/runs?repo=%2Frepos%2Fmy%20project");
  });

  it("returns parsed running + runs on 200", async () => {
    const payload = {
      running: true,
      runs: [{ at: 1000, url: "https://github.com/x/y/pull/1", outcome: "pr" }],
    };
    globalThis.fetch = mockFetch(200, payload);
    const result = await getDocAgentRuns("/repos/my-project");
    expect(result.running).toBe(true);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]!.outcome).toBe("pr");
  });

  it("throws on non-2xx (feature disabled = 404)", async () => {
    globalThis.fetch = mockFetch(404, { error: "not found" });
    await expect(getDocAgentRuns("/repos/my-project")).rejects.toThrow();
  });
});
