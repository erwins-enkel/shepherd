import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HerdrSocketClient, HerdrSocketError } from "../src/herdr-socket-client";
import { maintenance } from "../src/maintenance";
import { HerdrUnavailableError } from "../src/herdr";

/** Minimal NDJSON JSON-RPC fake server: reads line-delimited requests, hands each
 *  parsed `{id, method, params}` to `onRequest`, which returns the response object(s)
 *  to write back (or `null` to answer nothing — for the timeout/drop tests). */
function startFakeServer(
  socketPath: string,
  onRequest: (req: { id: string; method: string; params: unknown }, socket: net.Socket) => void,
): net.Server {
  const server = net.createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
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
    });
    client = new HerdrSocketClient(socketPath);

    const raw = await client.request<{ type: string }>("ping", {});
    expect(raw.type).toBe("pong");

    const pong = await client.ping();
    expect(pong.version).toBe("0.7.2");
    expect(pong.protocol).toBe(16);
    expect(pong.capabilities).toEqual({ live_handoff: true, detached_server_daemon: false });
  });

  test("id dispatch: concurrent requests resolve to their own result even out of order", async () => {
    server = startFakeServer(socketPath, (req, socket) => {
      // Reply in REVERSE order relative to arrival: stash id=1's reply until id=2 arrives.
      if (req.method === "slow") {
        setTimeout(() => {
          socket.write(JSON.stringify({ id: req.id, result: { echo: req.params } }) + "\n");
        }, 20);
      } else {
        socket.write(JSON.stringify({ id: req.id, result: { echo: req.params } }) + "\n");
      }
    });
    client = new HerdrSocketClient(socketPath);

    const first = client.request<{ echo: { n: number } }>("slow", { n: 1 });
    const second = client.request<{ echo: { n: number } }>("fast", { n: 2 });

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
    });
    client = new HerdrSocketClient(socketPath);

    await expect(client.request("agent.read", {})).rejects.toMatchObject({
      name: "HerdrSocketError",
      code: "not_found",
      message: "no such agent",
    });
    await expect(client.request("agent.read", {})).rejects.toBeInstanceOf(HerdrSocketError);
  });

  test("timeout: unanswered request rejects after timeoutMs", async () => {
    server = startFakeServer(socketPath, () => {
      /* never respond */
    });
    client = new HerdrSocketClient(socketPath);

    await expect(client.request("hang", {}, { timeoutMs: 50 })).rejects.toThrow(/timed out/);
  });

  test("reconnect: mid-flight drop rejects the pending request; next request() reconnects", async () => {
    server = startFakeServer(socketPath, (_req, socket) => {
      // Drop the connection instead of answering.
      socket.destroy();
    });
    client = new HerdrSocketClient(socketPath);

    await expect(client.request("ping", {})).rejects.toThrow(/disconnected/);

    await closeServer(server);
    try {
      fs.unlinkSync(socketPath);
    } catch {
      /* already gone */
    }

    server = startFakeServer(socketPath, (req, socket) => {
      socket.write(JSON.stringify({ id: req.id, result: { type: "pong" } }) + "\n");
    });

    const result = await client.request<{ type: string }>("ping", {});
    expect(result.type).toBe("pong");
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
