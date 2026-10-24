import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { constants, inflateRawSync } from "node:zlib";
import { PtyBridge, type PtySocket } from "../src/pty-bridge";
import { SessionStore } from "../src/store";
import { SessionService } from "../src/service";
import { EventHub } from "../src/events";
import { makeApp, serve, type AppDeps } from "../src/server";
import { config } from "../src/config";
import { SESSION_COOKIE, SESSION_TTL_MS, signCookie } from "../src/operator-auth";

function makeDeps(): AppDeps {
  const store = new SessionStore(":memory:");
  const events = new EventHub();
  const service = new SessionService({
    store,
    events,
    namer: async () => "compression",
    worktree: {} as any,
    herdr: { list: () => [] } as any,
  });
  store.create({
    name: "compression",
    prompt: "compressible prompt ".repeat(200),
    repoPath: "/r",
    baseBranch: "main",
    branch: "shepherd/compression",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_compression",
  });
  return {
    store,
    service,
    events,
    usageLimits: {
      limits: () => ({
        session5h: null,
        week: null,
        perModelWeek: [],
        credits: null,
        stale: true,
        calibratedAt: null,
        subscriptionOnly: false,
      }),
      projections: () => [],
    },
  };
}

const previous = { secret: config.cookieSecret, token: config.token, hash: config.passwordHash };
afterEach(() => {
  config.cookieSecret = previous.secret;
  config.token = previous.token;
  config.passwordHash = previous.hash;
});

function disableAuth() {
  config.cookieSecret = null;
  config.token = null;
  config.passwordHash = null;
}

const unzip = async (res: Response) =>
  JSON.parse(Buffer.from(Bun.gunzipSync(new Uint8Array(await res.arrayBuffer()))).toString());

describe("server compression", () => {
  test("session list gzip matches identity and preserves timing", async () => {
    disableAuth();
    const app = makeApp(makeDeps());
    const plain = await app.fetch(new Request("http://localhost/api/sessions"));
    const res = await app.fetch(
      new Request("http://localhost/api/sessions", {
        headers: { "Accept-Encoding": "gzip" },
      }),
    );
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("server-timing")).toMatch(/^app;dur=/);
    expect(res.headers.get("vary")).toContain("Accept-Encoding");
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(await unzip(res)).toEqual(await plain.json());
  });

  test("cookie restamping retains gzip and the decoded session list", async () => {
    disableAuth();
    config.cookieSecret = "compression-test-secret";
    const cookie = signCookie(config.cookieSecret, SESSION_TTL_MS, Date.now() - SESSION_TTL_MS / 2);
    const res = await makeApp(makeDeps()).fetch(
      new Request("http://localhost/api/sessions", {
        headers: { "Accept-Encoding": "gzip", Cookie: `${SESSION_COOKIE}=${cookie}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.getSetCookie()).toHaveLength(1);
    expect((await unzip(res))[0].name).toBe("compression");
  });

  test("normalizes and compresses a large handler error", async () => {
    disableAuth();
    const deps = makeDeps();
    const message = "large error ".repeat(200);
    const spy = spyOn(deps.store, "list").mockImplementation(() => {
      throw new Error(message);
    });
    try {
      const res = await makeApp(deps).fetch(
        new Request("http://localhost/api/sessions", {
          headers: { "Accept-Encoding": "gzip" },
        }),
      );
      expect(res.status).toBe(500);
      expect(res.headers.get("content-encoding")).toBe("gzip");
      expect(await unzip(res)).toEqual({ error: message });
    } finally {
      spy.mockRestore();
    }
  });

  test("curl --compressed decodes the real HTTP session response", async () => {
    disableAuth();
    const server = serve(makeDeps(), 0);
    try {
      const curl = Bun.spawn(
        [
          "curl",
          "--silent",
          "--show-error",
          "--compressed",
          "--max-time",
          "3",
          "--dump-header",
          "-",
          `http://127.0.0.1:${server.port}/api/sessions`,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const output = await new Response(curl.stdout).text();
      expect(await curl.exited).toBe(0);
      const split = output.indexOf("\r\n\r\n");
      expect(output.slice(0, split).toLowerCase()).toContain("content-encoding: gzip");
      expect(JSON.parse(output.slice(split + 4))[0].name).toBe("compression");
    } finally {
      server.stop(true);
    }
  });
});

interface Frame {
  opcode: number;
  compressed: boolean;
  payload: Buffer;
}

// Inspect actual server frames: Fetch/WebSocket clients otherwise hide transport compression.
async function rawFrames(
  port: number,
  path: string,
  compression: boolean,
  count: number,
  onHandshake = () => {},
): Promise<{ headers: string; frames: Frame[] }> {
  const result = Promise.withResolvers<{ headers: string; frames: Frame[] }>();
  let pending = Buffer.alloc(0);
  let headers: string | undefined;
  const frames: Frame[] = [];
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      open(socket) {
        socket.write(
          [
            `GET ${path} HTTP/1.1`,
            `Host: localhost:${port}`,
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Version: 13",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
            ...(compression ? ["Sec-WebSocket-Extensions: permessage-deflate"] : []),
            "",
            "",
          ].join("\r\n"),
        );
      },
      data(_socket, data) {
        try {
          pending = Buffer.concat([pending, data]);
          if (headers === undefined) {
            const end = pending.indexOf("\r\n\r\n");
            if (end < 0) return;
            headers = pending.subarray(0, end).toString();
            if (!headers.startsWith("HTTP/1.1 101")) throw new Error(headers);
            pending = pending.subarray(end + 4);
            onHandshake();
          }
          while (pending.length >= 2) {
            const first = pending[0]!;
            const second = pending[1]!;
            let size = second & 0x7f;
            let offset = 2;
            if (size === 126) {
              if (pending.length < 4) return;
              size = pending.readUInt16BE(2);
              offset = 4;
            } else if (size === 127) {
              if (pending.length < 10) return;
              const large = pending.readBigUInt64BE(2);
              if (large > 1024n * 1024n) throw new Error("oversize test frame");
              size = Number(large);
              offset = 10;
            }
            if (pending.length < offset + size) return;
            if (second & 0x80 || !(first & 0x80))
              throw new Error("unexpected masked/fragmented server frame");
            const frame = {
              opcode: first & 0x0f,
              compressed: !!(first & 0x40),
              payload: Buffer.from(pending.subarray(offset, offset + size)),
            };
            pending = pending.subarray(offset + size);
            if (frame.opcode === 8) throw new Error("server closed before output");
            if (frame.opcode !== 1 && frame.opcode !== 2) continue;
            frames.push(frame);
            if (frames.length === count) {
              result.resolve({ headers, frames });
              return;
            }
          }
        } catch (error) {
          result.reject(error);
        }
      },
      error(_socket, error) {
        result.reject(error);
      },
      close() {
        if (frames.length < count) result.reject(new Error("socket closed before output"));
      },
    },
  });
  const timeout = setTimeout(() => result.reject(new Error("WebSocket frames timed out")), 3000);
  try {
    return await result.promise;
  } finally {
    clearTimeout(timeout);
    socket.end();
  }
}

function inflateFrame(frame: Frame): Buffer {
  return frame.compressed
    ? inflateRawSync(Buffer.concat([frame.payload, Buffer.from([0, 0, 255, 255])]), {
        finishFlush: constants.Z_SYNC_FLUSH,
      })
    : frame.payload;
}

describe("server WebSocket compression", () => {
  test.each([true, false])(
    "event frames negotiate compression=%s and preserve JSON",
    async (compression) => {
      disableAuth();
      const deps = makeDeps();
      const server = serve(deps, 0);
      const data = { text: "large event ".repeat(8000) }; // Also exercises the 64-bit identity frame length.
      try {
        const { headers, frames } = await rawFrames(server.port!, "/events", compression, 2, () => {
          deps.events.emit("compression:test", data);
        });
        expect(headers.toLowerCase().includes("sec-websocket-extensions: permessage-deflate")).toBe(
          compression,
        );
        expect(frames[0]!.compressed).toBe(compression);
        expect(JSON.parse(inflateFrame(frames[0]!).toString())).toEqual({
          event: "terminal:owners",
          data: { owners: {} },
        });
        const event = frames[1]!;
        expect(event.compressed).toBe(compression);
        expect(JSON.parse(inflateFrame(event).toString())).toEqual({
          event: "compression:test",
          data,
        });
        if (compression) expect(event.payload.length).toBeLessThan(1000);
      } finally {
        server.stop(true);
      }
    },
  );

  test.each([true, false])(
    "WebSocket client decodes events with compression=%s",
    async (compression) => {
      disableAuth();
      const deps = makeDeps();
      const server = serve(deps, 0);
      // The DOM constructor type lacks Bun's compression option.
      const options = { perMessageDeflate: compression } satisfies Bun.WebSocketOptions;
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/events`, options as never);
      const data = { text: "decoded event ".repeat(500) };
      try {
        const received = await new Promise<unknown>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("client event timed out")), 3000);
          socket.onerror = () => {
            clearTimeout(timeout);
            reject(new Error("WebSocket client failed"));
          };
          socket.onmessage = (message) => {
            const value = JSON.parse(String(message.data));
            if (value.event === "terminal:owners") deps.events.emit("compression:test", data);
            else {
              clearTimeout(timeout);
              resolve(value);
            }
          };
        });
        expect(received).toEqual({ event: "compression:test", data });
      } finally {
        socket.close();
        server.stop(true);
      }
    },
  );

  test.each([false, true])(
    "terminal output preserves text/binary and compresses (remote=%s)",
    async (remote) => {
      disableAuth();
      const deps = makeDeps();
      const text = "terminal paint ".repeat(500);
      const binary = Buffer.from("binary paint ".repeat(500));
      const paint = (sink: PtySocket) => {
        sink.send(text);
        sink.send(binary);
      };
      let spy: { mockRestore(): void } | undefined;
      let path: string;
      const previousSocketTerminal = config.herdrSocketTerminal;
      config.herdrSocketTerminal = false;
      if (remote) {
        path = "/pty/remote-compression";
        deps.remoteSessions = {
          has: (id: string) => id === "remote-compression",
          openTerminal: (_id: string, sink: PtySocket) => {
            paint(sink);
            return { write() {}, close() {} };
          },
        } as unknown as AppDeps["remoteSessions"];
      } else {
        path = `/pty/${deps.store.list()[0]!.id}`;
        deps.herdr = {
          listAsync: async () => [{ terminalId: "term_compression", cwd: "/wt" }],
        } as any;
        spy = spyOn(PtyBridge.prototype, "open").mockImplementation(function (this: PtyBridge) {
          paint((this as unknown as { ws: PtySocket }).ws);
        });
      }
      const server = serve(deps, 0);
      try {
        const { frames } = await rawFrames(server.port!, path, true, 2);
        expect(frames.map((f) => f.opcode)).toEqual([1, 2]);
        expect(frames.map((f) => f.compressed)).toEqual([true, true]);
        expect(inflateFrame(frames[0]!).toString()).toBe(text);
        expect(inflateFrame(frames[1]!)).toEqual(binary);
      } finally {
        server.stop(true);
        spy?.mockRestore();
        config.herdrSocketTerminal = previousSocketTerminal;
      }
    },
  );
});
