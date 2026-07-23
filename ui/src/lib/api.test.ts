import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCodexReleaseNotes, getCommands } from "./api";

vi.mock("$lib/auth.svelte", () => ({
  auth: { unauthenticated: false, checked: false },
}));

describe("getCommands", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("serializes repo and optional provider", async () => {
    const fetchMock = vi.fn(async () => Response.json({ commands: [] }));
    globalThis.fetch = fetchMock as typeof fetch;

    await getCommands("/repo path", { provider: "codex" });

    expect(fetchMock).toHaveBeenCalledWith("/api/commands?repo=%2Frepo+path&provider=codex");
  });

  it("preserves the legacy no-provider command URL", async () => {
    const fetchMock = vi.fn(async () => Response.json({ commands: [] }));
    globalThis.fetch = fetchMock as typeof fetch;

    await getCommands("/repo path");

    expect(fetchMock).toHaveBeenCalledWith("/api/commands?repo=%2Frepo+path");
  });
});

describe("fetchCodexReleaseNotes", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("uses the notes endpoint and forwards the exact AbortSignal", async () => {
    const result = {
      current: "0.144.0",
      latest: "0.145.0",
      notes: [{ version: "0.145.0", body: "notes" }],
      complete: true,
    };
    const fetchMock = vi.fn(async () => Response.json(result));
    globalThis.fetch = fetchMock as typeof fetch;
    const controller = new AbortController();

    await expect(fetchCodexReleaseNotes(controller.signal)).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith("/api/codex-update/notes", {
      signal: controller.signal,
    });
  });

  it("rejects non-OK responses", async () => {
    globalThis.fetch = vi.fn(async () => Response.json({ error: "nope" }, { status: 503 }));

    await expect(fetchCodexReleaseNotes(new AbortController().signal)).rejects.toThrow();
  });
});
