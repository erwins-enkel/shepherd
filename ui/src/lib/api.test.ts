import { afterEach, describe, expect, it, vi } from "vitest";
import { getCommands } from "./api";

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
