import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, isPreviewBlocked, uploadFile } from "./api";
import { auth } from "./auth.svelte";
import { m } from "./paraglide/messages";
import { overwriteGetLocale } from "./paraglide/runtime";

class FakeXMLHttpRequest extends EventTarget {
  static instances: FakeXMLHttpRequest[] = [];

  readonly upload = new EventTarget();
  method = "";
  url = "";
  body: Document | XMLHttpRequestBodyInit | null = null;
  status = 0;
  responseText = "";

  constructor() {
    super();
    FakeXMLHttpRequest.instances.push(this);
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  send(body: Document | XMLHttpRequestBodyInit | null = null) {
    this.body = body;
  }

  respond(status: number, body: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.dispatchEvent(new Event("load"));
  }

  fail() {
    this.dispatchEvent(new Event("error"));
  }
}

function request(): FakeXMLHttpRequest {
  expect(FakeXMLHttpRequest.instances).toHaveLength(1);
  return FakeXMLHttpRequest.instances[0]!;
}

async function rejected(promise: Promise<unknown>): Promise<Error> {
  return (await promise.then(
    () => null,
    (error) => error,
  )) as Error;
}

describe("uploadFile progress transport", () => {
  beforeEach(() => {
    FakeXMLHttpRequest.instances = [];
    auth.unauthenticated = false;
    vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest as unknown as typeof XMLHttpRequest);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("progress uploads must not use fetch");
      }),
    );
  });

  afterEach(() => {
    auth.unauthenticated = false;
    overwriteGetLocale(() => "en");
    vi.unstubAllGlobals();
  });

  it("keeps the existing fetch transport when no progress callback is supplied", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ path: "/worktree/plain.txt" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["plain"], "plain.txt", { type: "text/plain" });

    await expect(uploadFile(file, "live-session")).resolves.toBe("/worktree/plain.txt");

    expect(FakeXMLHttpRequest.instances).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/uploads?session=live-session");
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: "POST" });
    expect((fetchMock.mock.calls[0]![1]!.body as FormData).get("file")).toBe(file);
  });

  it("reports upload bytes and resolves only after the server confirms the staged path", async () => {
    const file = new File(["1234567890"], "clip.mp4", { type: "video/mp4" });
    const onProgress = vi.fn();

    const result = uploadFile(file, undefined, onProgress);
    const xhr = request();

    expect(xhr.method).toBe("POST");
    expect(xhr.url).toBe("/api/uploads");
    expect(xhr.body).toBeInstanceOf(FormData);
    expect((xhr.body as FormData).get("file")).toBe(file);

    xhr.upload.dispatchEvent(
      new ProgressEvent("progress", { lengthComputable: true, loaded: 4, total: 10 }),
    );
    expect(onProgress).toHaveBeenCalledWith({
      loaded: 4,
      total: 10,
      lengthComputable: true,
    });

    let settled = false;
    void result.finally(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    xhr.respond(200, { path: "/staged/clip.mp4" });
    await expect(result).resolves.toBe("/staged/clip.mp4");
  });

  it("preserves the session upload URL when progress is requested", async () => {
    const result = uploadFile(new File(["x"], "shot.png"), "session/one", vi.fn());
    const xhr = request();

    expect(xhr.url).toBe("/api/uploads?session=session%2Fone");
    xhr.respond(200, { path: "/worktree/shot.png" });
    await expect(result).resolves.toBe("/worktree/shot.png");
  });

  it("maps a generic HTTP body and a network failure to upload errors", async () => {
    const httpResult = uploadFile(new File(["x"], "large.bin"), undefined, vi.fn());
    request().respond(413, { error: "file too large" });
    const httpError = await rejected(httpResult);

    expect(httpError).toBeInstanceOf(ApiError);
    expect((httpError as ApiError).status).toBe(413);
    expect(httpError.message).toBe("file too large");

    FakeXMLHttpRequest.instances = [];
    const networkResult = uploadFile(new File(["x"], "offline.bin"), undefined, vi.fn());
    request().fail();
    await expect(networkResult).rejects.toThrow(m.api_upload_network_error());
  });

  it("localizes client-authored transport errors", async () => {
    overwriteGetLocale(() => "de");
    const result = uploadFile(new File(["x"], "offline.bin"), undefined, vi.fn());
    request().fail();

    await expect(result).rejects.toThrow("Netzwerkfehler beim Upload");
  });

  it("flips auth state for a 401 response", async () => {
    const result = uploadFile(new File(["x"], "secret.txt"), undefined, vi.fn());
    request().respond(401, { error: "unauthorized" });
    const error = await rejected(result);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect(auth.unauthenticated).toBe(true);
  });

  it("preserves preview-origin 403 classification and localized copy", async () => {
    const result = uploadFile(new File(["x"], "preview.txt"), undefined, vi.fn());
    request().respond(403, { error: "forbidden: origin not allowed" });
    const error = await rejected(result);

    expect(isPreviewBlocked(error)).toBe(true);
    expect(error.message).toBe(m.error_preview_readonly());
  });

  it("preserves host-allowlist 403 ApiError semantics and localized copy", async () => {
    const result = uploadFile(new File(["x"], "host.txt"), undefined, vi.fn());
    request().respond(403, { error: "forbidden: origin host not allowed" });
    const error = await rejected(result);

    expect(isPreviewBlocked(error)).toBe(false);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    expect(error.message).toBe(m.error_origin_host_not_allowed());
    expect((error as ApiError).serverAuthored).toBe(true);
  });
});
