import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HerdrSocketClient, HerdrSocketError } from "../src/herdr-socket-client";
import { maintenance } from "../src/maintenance";
import { HerdrUnavailableError } from "../src/herdr";

/** Minimal NDJSON JSON-RPC fake server mirroring herdr's real socket behavior:
 *  each accepted connection gets exactly ONE request read, ONE response written
 *  (unless `onRequest` chooses not to reply), then the connection is ended —
 *  never reused for a second round trip. */
function startFakeServer(
  socketPath: string,
  onRequest: (req: { id: string; method: string; params: unknown }, socket: net.Socket) => void,
): net.Server {
  const server = net.createServer((socket) => {
    let buf = "";
    let handled = false;
    socket.on("data", (chunk) => {
      if (handled) return; // herdr only ever answers the first request per connection
      buf += chunk.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim() || handled) continue;
        handled = true;
        onRequest(JSON.parse(line), socket);
      }
    });
  });
  server.listen(socketPath);
  return server;
}

function closeServer(server: net.Server | null): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
}

/** `request()` is now typed strictly against the generated `HerdrMethod`/`HerdrParams` schema
 *  (see herdr-socket-client.ts), but a couple of tests below deliberately probe the DUMB WIRE
 *  TRANSPORT itself — connection-per-call semantics — with synthetic, non-schema method names
 *  ("fast"/"slow"). This cast is the minimal bypass for that: it does not change any production
 *  typing, only lets these specific tests keep using made-up methods. */
function rawRequest(
  client: HerdrSocketClient,
  method: string,
  params: unknown,
): Promise<{ echo: { n: number } }> {
  return (client.request as unknown as (m: string, p: unknown) => Promise<{ echo: { n: number } }>)(
    method,
    params,
  );
}

describe("HerdrSocketClient", () => {
  let socketPath: string;
  let server: net.Server | null;
  let client: HerdrSocketClient | null;

  beforeEach(() => {
    socketPath = path.join(
      os.tmpdir(),
      `herdr-socket-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
    );
    server = null;
    client = null;
  });

  afterEach(async () => {
    client?.close();
    await closeServer(server);
    try {
      fs.unlinkSync(socketPath);
    } catch {
      /* already gone */
    }
    maintenance.end();
  });

  test("round trip: request() resolves result, ping() surfaces pong fields", async () => {
    server = startFakeServer(socketPath, (req, socket) => {
      if (req.method === "ping") {
        socket.write(
          JSON.stringify({
            id: req.id,
            result: {
              type: "pong",
              version: "0.7.2",
              protocol: 16,
              capabilities: { live_handoff: true, detached_server_daemon: false },
            },
          }) + "\n",
        );
      }
      socket.end();
    });
    client = new HerdrSocketClient(socketPath);

    const raw = await client.request("ping", {});
    expect(raw.type).toBe("pong");

    const pong = await client.ping();
    expect(pong.version).toBe("0.7.2");
    expect(pong.protocol).toBe(16);
    expect(pong.capabilities).toEqual({ live_handoff: true, detached_server_daemon: false });
  });

  test("sequential requests each open a fresh connection", async () => {
    let connectionCount = 0;
    server = startFakeServer(socketPath, (req, socket) => {
      connectionCount++;
      socket.write(JSON.stringify({ id: req.id, result: { echo: req.params } }) + "\n");
      socket.end();
    });
    client = new HerdrSocketClient(socketPath);

    const first = await rawRequest(client, "fast", { n: 1 });
    const second = await rawRequest(client, "fast", { n: 2 });

    expect(first.echo.n).toBe(1);
    expect(second.echo.n).toBe(2);
    expect(connectionCount).toBe(2);
  });

  test("concurrent requests each get their own connection and resolve independently", async () => {
    server = startFakeServer(socketPath, (req, socket) => {
      // Reply in REVERSE order relative to arrival: the slow request answers
      // after the fast one, proving there is no shared per-connection queue.
      if (req.method === "slow") {
        setTimeout(() => {
          socket.write(JSON.stringify({ id: req.id, result: { echo: req.params } }) + "\n");
          socket.end();
        }, 20);
      } else {
        socket.write(JSON.stringify({ id: req.id, result: { echo: req.params } }) + "\n");
        socket.end();
      }
    });
    client = new HerdrSocketClient(socketPath);

    const first = rawRequest(client, "slow", { n: 1 });
    const second = rawRequest(client, "fast", { n: 2 });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.echo.n).toBe(1);
    expect(secondResult.echo.n).toBe(2);
  });

  test("error response rejects with HerdrSocketError carrying code + message", async () => {
    server = startFakeServer(socketPath, (req, socket) => {
      socket.write(
        JSON.stringify({ id: req.id, error: { code: "not_found", message: "no such agent" } }) +
          "\n",
      );
      socket.end();
    });
    client = new HerdrSocketClient(socketPath);

    const params = { target: "agent-1", source: "visible" as const };
    await expect(client.request("agent.read", params)).rejects.toMatchObject({
      name: "HerdrSocketError",
      code: "not_found",
      message: "no such agent",
    });
    await expect(client.request("agent.read", params)).rejects.toBeInstanceOf(HerdrSocketError);
  });

  test("timeout: unanswered request rejects after timeoutMs", async () => {
    server = startFakeServer(socketPath, () => {
      /* never respond */
    });
    client = new HerdrSocketClient(socketPath);

    await expect(client.request("ping", {}, { timeoutMs: 50 })).rejects.toThrow(/timed out/);
  });

  test("closed before response: connection dropped without a reply rejects (not hang)", async () => {
    server = startFakeServer(socketPath, (_req, socket) => {
      socket.destroy();
    });
    client = new HerdrSocketClient(socketPath);

    await expect(client.request("ping", {})).rejects.toThrow(/closed before response/);
  });

  test("maintenance gate: rejects with HerdrUnavailableError and sends no bytes", async () => {
    let bytesReceived = 0;
    server = startFakeServer(socketPath, () => {
      bytesReceived++;
    });
    client = new HerdrSocketClient(socketPath);

    maintenance.begin();
    await expect(client.request("ping", {})).rejects.toBeInstanceOf(HerdrUnavailableError);

    // Give the fake server's event loop a tick — if a connection/write had actually
    // gone out, this is ample time for it to arrive.
    await new Promise((r) => setTimeout(r, 20));
    expect(bytesReceived).toBe(0);
  });
});
