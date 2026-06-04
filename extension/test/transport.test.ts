import { describe, expect, it, vi } from "vitest";
import { spawnNow } from "../src/lib/transport";
import { TransportError, type CaptureConfig, type PageMetadata } from "../src/lib/types";
import type { CapturedSignals } from "../src/lib/signals";

const CONFIG: CaptureConfig = {
  baseUrl: "http://localhost:7330",
  token: "secret",
  repoPath: "~/Work/foo",
  baseBranch: "main",
  model: "opus",
};

const META: PageMetadata = {
  url: "https://example.com",
  title: "Example",
  viewportW: 800,
  viewportH: 600,
  devicePixelRatio: 1,
  userAgent: "UA",
  locale: "en-US",
  timestamp: "2026-06-04T10:00:00.000Z",
};

const blob = () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });

function jsonRes(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("spawnNow", () => {
  it("uploads the screenshot, then creates a session with the staged path + bearer auth", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ path: "/staging/abc.png" }, 200))
      .mockResolvedValueOnce(jsonRes({ desig: "TASK-42" }, 201));

    const desig = await spawnNow(fetchFn, CONFIG, {
      prompt: "Fix the button",
      metadata: META,
      screenshot: blob(),
      attachScreenshot: true,
    });

    expect(desig).toBe("TASK-42");
    expect(fetchFn).toHaveBeenCalledTimes(2);

    const [uploadUrl, uploadInit] = fetchFn.mock.calls[0];
    expect(uploadUrl).toBe("http://localhost:7330/api/uploads");
    expect(uploadInit.method).toBe("POST");
    expect(uploadInit.headers.Authorization).toBe("Bearer secret");
    expect(uploadInit.body).toBeInstanceOf(FormData);

    const [sessUrl, sessInit] = fetchFn.mock.calls[1];
    expect(sessUrl).toBe("http://localhost:7330/api/sessions");
    expect(sessInit.headers["Content-Type"]).toBe("application/json");
    const sent = JSON.parse(sessInit.body);
    expect(sent.repoPath).toBe("~/Work/foo");
    expect(sent.baseBranch).toBe("main");
    expect(sent.model).toBe("opus");
    expect(sent.images).toEqual(["/staging/abc.png"]);
    expect(sent.prompt).toContain("Fix the button");
    expect(sent.prompt).toContain("```text");
    expect(sent.prompt).toContain("URL: https://example.com");
  });

  it("omits Authorization when no token and omits model when 'default'", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ path: "/staging/x.png" }, 200))
      .mockResolvedValueOnce(jsonRes({ desig: "TASK-1" }, 201));

    await spawnNow(
      fetchFn,
      { ...CONFIG, token: "", model: "default" },
      {
        prompt: "hi",
        metadata: META,
        screenshot: blob(),
        attachScreenshot: true,
      },
    );

    expect(fetchFn.mock.calls[0][1].headers.Authorization).toBeUndefined();
    expect(JSON.parse(fetchFn.mock.calls[1][1].body).model).toBeUndefined();
  });

  it.each([
    [403, "origin"],
    [401, "auth"],
    [400, "invalid"],
    [413, "too_large"],
    [415, "unsupported"],
    [500, "unknown"],
  ])("maps upload status %i to TransportError kind %s", async (status, kind) => {
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonRes({ error: "no" }, status));
    await expect(
      spawnNow(fetchFn, CONFIG, {
        prompt: "p",
        metadata: META,
        screenshot: blob(),
        attachScreenshot: true,
      }),
    ).rejects.toMatchObject({ kind });
    expect(fetchFn).toHaveBeenCalledTimes(1); // never reaches session create
  });

  it("maps a network throw to 'unreachable'", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(
      spawnNow(fetchFn, CONFIG, {
        prompt: "p",
        metadata: META,
        screenshot: blob(),
        attachScreenshot: true,
      }),
    ).rejects.toMatchObject({ kind: "unreachable" });
  });

  it("maps a session-create error status too (after a successful upload)", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ path: "/staging/x.png" }, 200))
      .mockResolvedValueOnce(jsonRes({ error: "bad repo" }, 400));
    await expect(
      spawnNow(fetchFn, CONFIG, {
        prompt: "p",
        metadata: META,
        screenshot: blob(),
        attachScreenshot: true,
      }),
    ).rejects.toBeInstanceOf(TransportError);
  });

  it("skips the upload and sends images:[] when attachScreenshot is false", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonRes({ desig: "TASK-9" }, 201));
    const signals: CapturedSignals = {
      console: [{ level: "error", text: "boom", ts: META.timestamp }],
    };
    const desig = await spawnNow(fetchFn, CONFIG, {
      prompt: "no shot",
      metadata: META,
      attachScreenshot: false,
      signals,
    });
    expect(desig).toBe("TASK-9");
    expect(fetchFn).toHaveBeenCalledTimes(1); // sessions only — no /api/uploads
    const [sessUrl, sessInit] = fetchFn.mock.calls[0];
    expect(sessUrl).toBe("http://localhost:7330/api/sessions");
    const sent = JSON.parse(sessInit.body);
    expect(sent.images).toEqual([]);
    expect(sent.prompt).toContain("Console (1):"); // signals reached the prompt
    expect(sent.prompt).toContain("boom");
  });
});
