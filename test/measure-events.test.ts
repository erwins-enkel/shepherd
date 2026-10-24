import { expect, test } from "bun:test";
import { measureEvents } from "../scripts/measure-events";

test("measures UTF-8 JSON frames without retaining payloads or credentials", async () => {
  const frame = JSON.stringify({ event: "example:update", data: { text: "Grüße" } });
  const server = Bun.serve({
    port: 0,
    fetch(req, server) {
      expect(req.headers.get("authorization")).toBe("Bearer test-token");
      if (server.upgrade(req)) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      open(ws) {
        ws.send(frame);
        ws.send(frame);
      },
      message() {},
    },
  });
  try {
    const result = await measureEvents(
      new URL(`http://127.0.0.1:${server.port}`),
      "test-token",
      20,
      0,
    );
    expect(result.stationary.events["example:update"]).toEqual({
      count: 2,
      bytes: 2 * Buffer.byteLength(frame),
      maxBytes: Buffer.byteLength(frame),
    });
    // Both frames count toward bytes, not only the largest one.
    expect(result.stationary.bytes).toBe(2 * Buffer.byteLength(frame));
    expect(JSON.stringify(result)).not.toContain("Grüße");
    expect(JSON.stringify(result)).not.toContain("test-token");
  } finally {
    server.stop(true);
  }
});

test("a failed WebSocket handshake rejects without disclosing its response", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response("secret", { status: 401 }) });
  try {
    await expect(
      measureEvents(new URL(`http://127.0.0.1:${server.port}`), "test-token", 20, 0),
    ).rejects.toThrow("Event connection failed");
  } finally {
    server.stop(true);
  }
});

test("does not follow WebSocket redirects or send credentials to another origin", async () => {
  let redirected = false;
  const target = Bun.serve({
    port: 0,
    fetch: () => {
      redirected = true;
      return new Response(null, { status: 401 });
    },
  });
  const source = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(null, {
        status: 302,
        headers: { location: `http://127.0.0.1:${target.port}/events` },
      }),
  });
  try {
    await expect(
      measureEvents(new URL(`http://127.0.0.1:${source.port}`), "test-token", 20, 0),
    ).rejects.toThrow();
    expect(redirected).toBe(false);
  } finally {
    source.stop(true);
    target.stop(true);
  }
});
