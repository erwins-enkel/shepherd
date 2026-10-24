import { describe, expect, spyOn, test } from "bun:test";
import { compressJsonResponse, jsonResponse } from "../src/json-response";

const body = { text: "repeat ".repeat(500) };
const request = (encoding?: string, method = "GET") =>
  new Request("http://localhost/api/sessions", {
    method,
    headers: encoding === undefined ? {} : { "Accept-Encoding": encoding },
  });
const decoded = async (res: Response) =>
  JSON.parse(Buffer.from(Bun.gunzipSync(new Uint8Array(await res.arrayBuffer()))).toString());

describe("JSON compression", () => {
  test("gzip roundtrip preserves JSON, status, headers and multiple cookies", async () => {
    const original = jsonResponse(body, 201, {
      vary: "Origin",
      "content-length": String(Buffer.byteLength(JSON.stringify(body))),
    });
    original.headers.append("Set-Cookie", "a=1; Path=/");
    original.headers.append("Set-Cookie", "b=2; Path=/");
    const res = await compressJsonResponse(request("gzip"), original);
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("content-length")).toBeNull();
    expect(res.headers.get("vary")).toBe("Origin, Accept-Encoding");
    expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    expect(await decoded(res)).toEqual(body);
  });

  test.each([
    [undefined, false],
    ["br, deflate", false],
    ["xgzip", false],
    ["gzip;q=0", false],
    ["gzip;q=0, *;q=1", false],
    ["gzip;q=bad", false],
    ["gzip;q=2", false],
    ["gzip;q=-1", false],
    ["GZip; q=0.5", true],
    ["br, gzip", true],
    ["*", true],
    ["*;q=0", false],
  ])("negotiates %s (gzip=%s)", async (encoding, compressed) => {
    const original = jsonResponse(body);
    const res = await compressJsonResponse(request(encoding), original);
    expect(res.headers.get("content-encoding")).toBe(compressed ? "gzip" : null);
    expect(res.headers.get("vary")).toBe("Accept-Encoding");
    if (compressed) expect(await decoded(res)).toEqual(body);
    else expect(await res.json()).toEqual(body);
  });

  test.each([
    [1023, false],
    [1024, true],
  ])("threshold uses %i UTF-8 bytes", async (size, compressed) => {
    const value = "x".repeat(size - 2); // JSON string adds two quotes.
    const res = await compressJsonResponse(request("gzip"), jsonResponse(value));
    expect(res.headers.get("content-encoding")).toBe(compressed ? "gzip" : null);
    expect(compressed ? await decoded(res) : await res.json()).toBe(value);
  });

  test("counts UTF-8 bytes rather than characters", async () => {
    const value = "ä".repeat(511); // 1,024 encoded bytes including quotes.
    const res = await compressJsonResponse(request("gzip"), jsonResponse(value));
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(await decoded(res)).toBe(value);
  });

  test.each(["accept-encoding, Origin", "*"])("preserves existing Vary %s", async (vary) => {
    const res = await compressJsonResponse(request("gzip"), jsonResponse(body, 200, { vary }));
    expect(res.headers.get("vary")).toBe(vary);
  });

  test("does not gzip when output would grow", async () => {
    // Simulate an encoder result with no savings; the original JSON must remain readable.
    const encoder = spyOn(Bun, "gzipSync").mockReturnValue(new Uint8Array(4000));
    try {
      const res = await compressJsonResponse(request("gzip"), jsonResponse(body));
      expect(res.headers.get("content-encoding")).toBeNull();
      expect(await res.json()).toEqual(body);
    } finally {
      encoder.mockRestore();
    }
  });

  test("leaves HEAD, already encoded and bodyless responses unread", async () => {
    const head = jsonResponse(body);
    expect(await compressJsonResponse(request("gzip", "HEAD"), head)).toBe(head);
    expect(head.bodyUsed).toBe(false);
    const encoded = jsonResponse(body, 200, { "content-encoding": "br" });
    expect(await compressJsonResponse(request("gzip"), encoded)).toBe(encoded);
    expect(encoded.bodyUsed).toBe(false);
    const empty = new Response(null, { status: 204 });
    expect(await compressJsonResponse(request("gzip"), empty)).toBe(empty);
  });

  test.each(["text/event-stream", "application/json"])(
    "never reads unregistered %s streams",
    async (type) => {
      let pulls = 0;
      const stream = new ReadableStream(
        {
          pull() {
            pulls++;
          },
        },
        { highWaterMark: 0 },
      );
      const res = new Response(stream, { headers: { "content-type": type } });
      expect(await compressJsonResponse(request("gzip"), res)).toBe(res);
      expect(pulls).toBe(0);
      expect(res.bodyUsed).toBe(false);
      await stream.cancel();
    },
  );

  test("does not compress twice", async () => {
    const first = await compressJsonResponse(request("gzip"), jsonResponse(body));
    expect(await compressJsonResponse(request("gzip"), first)).toBe(first);
    expect(await decoded(first)).toEqual(body);
  });
});
