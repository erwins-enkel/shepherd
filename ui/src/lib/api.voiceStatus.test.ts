import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The message catalog is irrelevant here and slow to re-evaluate after every resetModules —
// under pre-push load that pushed a case past the 5s timeout.
vi.mock("$lib/paraglide/messages", () => ({ m: {} }));

// Pay the cold transform of api.ts once, outside the per-case 5s budget; the per-case
// re-imports below then only re-evaluate.
beforeAll(async () => {
  await import("./api");
}, 60_000);

// getVoiceStatus memoizes at module level — import a fresh module per case.
async function load() {
  vi.resetModules();
  return (await import("./api")).getVoiceStatus;
}

const status = {
  available: true,
  engine: "whisper.cpp",
  model: "base",
  ffmpeg: true,
  language: "auto",
  preferLocal: true,
  hint: "",
};

function json(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

let fetchMock: ReturnType<typeof vi.fn>;
const realFetch = globalThis.fetch;
beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const urls = () => fetchMock.mock.calls.map(([u]) => String(u));

describe("getVoiceStatus", () => {
  it("skips the status probe when voice-whisper isn't loaded", async () => {
    fetchMock.mockResolvedValueOnce(json({ plugins: [{ id: "buzz-bridge" }] }));
    const getVoiceStatus = await load();
    const s = await getVoiceStatus();
    expect(s.available).toBe(false);
    expect(urls()).toEqual(["/api/plugins"]);
  });

  it("probes and returns the plugin status when voice-whisper is loaded", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ plugins: [{ id: "voice-whisper" }] }))
      .mockResolvedValueOnce(json(status));
    const getVoiceStatus = await load();
    expect(await getVoiceStatus()).toEqual(status);
    expect(urls()).toEqual(["/api/plugins", "/api/plugins/voice-whisper/status"]);
  });

  it("resolves unavailable when the plugin list can't be read", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: "boom" }, { status: 500 }));
    const getVoiceStatus = await load();
    expect((await getVoiceStatus()).available).toBe(false);
    expect(urls()).toEqual(["/api/plugins"]);
  });

  it("memoizes the result for the page load", async () => {
    fetchMock.mockResolvedValueOnce(json({ plugins: [] }));
    const getVoiceStatus = await load();
    await getVoiceStatus();
    await getVoiceStatus();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
