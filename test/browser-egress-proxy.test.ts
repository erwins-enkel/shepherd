import { afterEach, describe, expect, test } from "bun:test";
import { connect, createServer, type Server, type Socket } from "node:net";
import {
  BrowserEgressProxy,
  parseSocksGreeting,
  parseSocksRequest,
} from "../src/browser-egress-proxy";
import type { LookupFn, OriginPolicy } from "../src/browser-origin-policy";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

/** A loopback echo server prefixing replies with "echo:". */
async function echoServer(): Promise<number> {
  const server: Server = createServer((s) => s.on("data", (d) => s.write(`echo:${d}`)));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  cleanup.push(() => server.close());
  return (server.address() as { port: number }).port;
}

function domainRequest(host: string, port: number): Buffer {
  const name = Buffer.from(host, "latin1");
  const p = Buffer.alloc(2);
  p.writeUInt16BE(port);
  return Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, p]);
}

/** SOCKS handshake + CONNECT; resolves the reply code and the open socket. */
async function socksConnect(
  proxyPort: number,
  host: string,
  port: number,
): Promise<{ rep: number; socket: Socket }> {
  const socket = connect(proxyPort, "127.0.0.1");
  cleanup.push(() => socket.destroy());
  let buf = Buffer.alloc(0);
  const read = (n: number) =>
    new Promise<Buffer>((resolve, reject) => {
      const check = () => {
        if (buf.length >= n) {
          const out = buf.subarray(0, n);
          buf = buf.subarray(n);
          socket.off("data", onData);
          resolve(out);
        }
      };
      const onData = (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        check();
      };
      socket.on("data", onData);
      socket.once("close", () => reject(new Error("closed")));
      check();
    });
  await new Promise<void>((r) => socket.once("connect", () => r()));
  socket.write(Buffer.from([5, 1, 0]));
  expect([...(await read(2))]).toEqual([5, 0]);
  socket.write(domainRequest(host, port));
  const rep = (await read(10))[1]!;
  return { rep, socket };
}

function roundTrip(socket: Socket, text: string): Promise<string> {
  return new Promise((resolve) => {
    socket.once("data", (d) => resolve(d.toString()));
    socket.write(text);
  });
}

describe("BrowserEgressProxy", () => {
  test("tunnels the Preview port, refuses other loopback ports and unlisted hosts", async () => {
    const devPort = await echoServer();
    const other = await echoServer();
    const policy: OriginPolicy = { allowedHosts: () => [], previewPort: () => devPort };
    const proxy = await BrowserEgressProxy.start(policy);
    cleanup.push(() => proxy.close());
    expect(proxy.url).toBe(`socks5://127.0.0.1:${proxy.port}`);

    const ok = await socksConnect(proxy.port, "localhost", devPort);
    expect(ok.rep).toBe(0);
    expect(await roundTrip(ok.socket, "hi")).toBe("echo:hi");

    expect((await socksConnect(proxy.port, "127.0.0.1", other)).rep).toBe(2);
    expect((await socksConnect(proxy.port, "example.com", 443)).rep).toBe(2);
  });

  test("tunnels localhost:<devPort> to the in-netns forward's host port (#2889)", async () => {
    const hostPort = await echoServer();
    const other = await echoServer();
    const policy: OriginPolicy = {
      allowedHosts: () => [],
      previewPort: () => null,
      devForward: async (port) => (port === 5173 ? hostPort : null),
    };
    const proxy = await BrowserEgressProxy.start(policy);
    cleanup.push(() => proxy.close());

    const ok = await socksConnect(proxy.port, "localhost", 5173);
    expect(ok.rep).toBe(0);
    expect(await roundTrip(ok.socket, "hi")).toBe("echo:hi");

    expect((await socksConnect(proxy.port, "localhost", hostPort)).rep).toBe(2);
    expect((await socksConnect(proxy.port, "localhost", other)).rep).toBe(2);
  });

  test("allowlisted names resolving privately or on non-web ports are refused", async () => {
    const port = await echoServer();
    const lookup: LookupFn = async (host) =>
      host === "private.example.com"
        ? [{ address: "10.0.0.5", family: 4 }]
        : [{ address: "93.184.216.34", family: 4 }];
    const policy: OriginPolicy = {
      allowedHosts: () => ["app.example.com", "private.example.com"],
      previewPort: () => null,
    };
    const proxy = await BrowserEgressProxy.start(policy, { lookup });
    cleanup.push(() => proxy.close());
    expect((await socksConnect(proxy.port, "private.example.com", 443)).rep).toBe(2);
    expect((await socksConnect(proxy.port, "app.example.com", port)).rep).toBe(2);
  });

  test("close() tears down live tunnels", async () => {
    const devPort = await echoServer();
    const proxy = await BrowserEgressProxy.start({
      allowedHosts: () => [],
      previewPort: () => devPort,
    });
    const { rep, socket } = await socksConnect(proxy.port, "localhost", devPort);
    expect(rep).toBe(0);
    const closed = new Promise<void>((r) => socket.once("close", () => r()));
    proxy.close();
    await closed;
  });
});

describe("SOCKS parsing", () => {
  test("greeting needs the no-auth method", () => {
    expect(parseSocksGreeting(Buffer.from([5]))).toEqual({ need: true });
    expect(parseSocksGreeting(Buffer.from([5, 1, 0]))).toEqual({ consumed: 3 });
    expect(parseSocksGreeting(Buffer.from([5, 1, 2]))).toEqual({ error: -1 });
    expect(parseSocksGreeting(Buffer.from([4, 1, 0]))).toEqual({ error: -1 });
  });
  test("CONNECT requests for every address type; other commands refused", () => {
    expect(parseSocksRequest(domainRequest("a.com", 443))).toEqual({
      host: "a.com",
      port: 443,
      consumed: 12,
    });
    expect(parseSocksRequest(Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, 0, 80]))).toEqual({
      host: "127.0.0.1",
      port: 80,
      consumed: 10,
    });
    const v6 = Buffer.concat([
      Buffer.from([5, 1, 0, 4]),
      Buffer.alloc(15),
      Buffer.from([1, 0, 80]),
    ]);
    expect(parseSocksRequest(v6)).toEqual({ host: "0:0:0:0:0:0:0:1", port: 80, consumed: 22 });
    expect(parseSocksRequest(Buffer.from([5, 2, 0, 1]))).toEqual({ need: true });
    expect(parseSocksRequest(Buffer.from([5, 2, 0, 1, 0]))).toEqual({ error: 7 });
    expect(parseSocksRequest(domainRequest("a.com", 443).subarray(0, 8))).toEqual({ need: true });
  });
});
