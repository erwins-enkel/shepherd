import { describe, expect, it, vi } from "vitest";
import { fileIssue, ping, spawnNow } from "../src/lib/transport";
import { TransportError, type CaptureConfig, type PageMetadata } from "../src/lib/types";
import type { CapturedSignals } from "../src/lib/signals";

const CONFIG: CaptureConfig = {
  baseUrl: "http://localhost:7330",
  token: "secret",
  repoPath: "~/Work/foo",
  baseBranch: "main",
  model: "opus",
  signals: { screenshot: true, console: false, network: false, a11y: false },
  routingRules: [],
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
      repoPath: "~/Work/foo",
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
        repoPath: "~/Work/foo",
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
        repoPath: "~/Work/foo",
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
        repoPath: "~/Work/foo",
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
        repoPath: "~/Work/foo",
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
      repoPath: "~/Work/foo",
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

  it("sends the routing-resolved repoPath, not config.repoPath", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonRes({ desig: "TASK-3" }, 201));
    await spawnNow(fetchFn, CONFIG, {
      prompt: "p",
      metadata: META,
      attachScreenshot: false,
      repoPath: "~/Work/routed",
    });
    expect(JSON.parse(fetchFn.mock.calls[0][1].body).repoPath).toBe("~/Work/routed");
  });
});

describe("fileIssue", () => {
  it("posts to /api/issues with repo+title+context body and returns {number,url}", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonRes({ number: 7, url: "https://github.com/acme/web/issues/7" }, 201),
      );

    const result = await fileIssue(fetchFn, CONFIG, {
      repoPath: "~/Work/routed",
      title: "Button is broken",
      prompt: "Fix the button",
      metadata: META,
    });

    expect(result).toEqual({ number: 7, url: "https://github.com/acme/web/issues/7" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("http://localhost:7330/api/issues");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers.Authorization).toBe("Bearer secret");
    const sent = JSON.parse(init.body);
    expect(sent.repo).toBe("~/Work/routed");
    expect(sent.title).toBe("Button is broken");
    expect(sent.body).toContain("Fix the button");
    expect(sent.body).toContain("```text");
    expect(sent.body).toContain("URL: https://example.com");
  });

  it("maps a 400 to TransportError kind 'invalid'", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonRes({ error: "invalid repo" }, 400));
    await expect(
      fileIssue(fetchFn, CONFIG, {
        repoPath: "~/Work/x",
        title: "t",
        prompt: "p",
        metadata: META,
      }),
    ).rejects.toMatchObject({ kind: "invalid" });
  });

  it("maps an unreachable fetch to kind 'unreachable'", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(
      fileIssue(fetchFn, CONFIG, {
        repoPath: "~/Work/x",
        title: "t",
        prompt: "p",
        metadata: META,
      }),
    ).rejects.toMatchObject({ kind: "unreachable" });
  });

  it("throws when the response is missing number or url", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonRes({ number: 7 }, 201));
    await expect(
      fileIssue(fetchFn, CONFIG, {
        repoPath: "~/Work/x",
        title: "t",
        prompt: "p",
        metadata: META,
      }),
    ).rejects.toBeInstanceOf(TransportError);
  });
});

describe("ping", () => {
  it("POSTs to /api/ping with bearer auth and resolves on 200", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonRes({}, 200));
    await expect(ping(fetchFn, CONFIG)).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("http://localhost:7330/api/ping");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer secret");
  });

  it("omits Authorization when no token", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonRes({}, 200));
    await ping(fetchFn, { ...CONFIG, token: "" });
    expect(fetchFn.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it.each([
    [403, "origin"],
    [401, "auth"],
  ])("maps status %i to TransportError kind %s", async (status, kind) => {
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonRes({ error: "no" }, status));
    await expect(ping(fetchFn, CONFIG)).rejects.toMatchObject({ kind });
  });

  it("maps a network throw to 'unreachable'", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(ping(fetchFn, CONFIG)).rejects.toMatchObject({ kind: "unreachable" });
  });
});
