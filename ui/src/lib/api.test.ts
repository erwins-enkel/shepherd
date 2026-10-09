import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSession,
  ApiError,
  resumeSession,
  resumeFailureMessage,
  fetchCodexReleaseNotes,
  getBuildQueues,
  getCommands,
  getPlanDraft,
} from "./api";

vi.mock("#lib/auth.svelte.js", () => ({
  auth: { unauthenticated: false, checked: false },
}));

describe("getPlanDraft", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("downloads only the session's plan file as text", async () => {
    const fetchMock = vi.fn(async () => new Response("# Plan\n\nSteps"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getPlanDraft("s1")).resolves.toBe("# Plan\n\nSteps");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/s1/worktree/download?path=.shepherd-plan.md",
    );
  });

  it.each([new Response("missing", { status: 404 }), new Response(" \n")])(
    "returns null for a missing or blank plan",
    async (response) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response),
      );
      await expect(getPlanDraft("s1")).resolves.toBeNull();
    },
  );

  it("preserves HTTP errors and network failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "denied" }, { status: 403 })),
    );
    await expect(getPlanDraft("s1")).rejects.toThrow("denied");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await expect(getPlanDraft("s1")).rejects.toThrow("offline");
  });
});

it("preserves the herdr recovery code from a failed task creation", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async () =>
    Response.json(
      { error: "herdr_restart_required", code: "herdr_restart_required" },
      { status: 409 },
    ),
  );
  try {
    await expect(
      createSession({
        repoPath: "/repo",
        baseBranch: "main",
        model: null,
        prompt: "keep my draft",
      }),
    ).rejects.toMatchObject({ code: "herdr_restart_required", status: 409 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

describe("getBuildQueues", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("requests the bulk queue snapshot", async () => {
    const queues = { s1: { sessionId: "s1", approved: true, steps: [] } };
    const fetchMock = vi.fn(async () => Response.json(queues));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(getBuildQueues()).resolves.toEqual(queues);
    expect(fetchMock).toHaveBeenCalledWith("/api/queues");
  });
});

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

describe("resume transcript refusal", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("preserves the typed server code and maps it to localized copy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: "transcript-missing",
              code: "transcript-missing",
            }),
            { status: 409 },
          ),
      ),
    );
    let error: unknown;
    try {
      await resumeSession("s1", true);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("transcript-missing");
    const copy = resumeFailureMessage(error, "fallback");
    expect(copy).not.toBe("fallback");
    expect(copy).not.toContain("transcript-missing");
    expect(copy).toContain("Continue with");
  });

  it("keeps each caller's fallback for other failures", () => {
    expect(resumeFailureMessage(new ApiError(409, "cannot resume"), "fallback")).toBe("fallback");
  });
});
