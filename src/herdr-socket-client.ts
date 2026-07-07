import * as net from "node:net";
import { config } from "./config";
import { maintenance } from "./maintenance";
import { HerdrUnavailableError } from "./herdr";

/** Hard ceiling on any single socket round trip, mirroring `HERDR_TIMEOUT_MS` in
 *  `herdr.ts` — a request that never gets a reply (dead server, dropped connection
 *  mid-flight) must not hang a caller forever. */
const SOCKET_REQUEST_TIMEOUT_MS = 10_000;

/** Thrown when herdr's NDJSON JSON-RPC socket replies `{id, error:{code,message}}`. */
export class HerdrSocketError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "HerdrSocketError";
    this.code = code;
  }
}

type PendingEntry = {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

type RpcResponse = {
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
};

/**
 * Persistent NDJSON JSON-RPC transport over herdr's Unix-domain socket (issue #1529).
 * Dumb transport only: it knows the wire framing (one JSON object per `\n`-delimited
 * line, requests keyed by a monotonic string `id`) and nothing about herdr's method
 * shapes — that lives in the future socket-backed `HerdrDriver`. Lazily opens the
 * socket on first use, reuses it across calls, and transparently reconnects after a
 * drop (e.g. a herdr update/handoff) on the NEXT request.
 */
export class HerdrSocketClient {
  private socket: net.Socket | null = null;
  private connecting: Promise<net.Socket> | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<string, PendingEntry>();

  constructor(private socketPath: string = config.herdrSocketPath) {}

  /** JSON-RPC round trip: `{id, method, params}` out, `result` (typed `T`) back.
   *  Rejects `HerdrSocketError` on an `{error}` reply, on timeout (default
   *  `SOCKET_REQUEST_TIMEOUT_MS`), or on connection failure. Refuses synchronously
   *  (throws `HerdrUnavailableError`, no bytes sent) while `maintenance.active` —
   *  mirrors `makeHerdrRunner`/`makeHerdrAsyncRunner` so nothing pokes the socket
   *  mid-update. */
  async request<T = unknown>(
    method: string,
    params: object,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    if (maintenance.active) throw new HerdrUnavailableError();

    const socket = await this.ensureConnected();
    const id = String(this.nextId++);
    const timeoutMs = opts?.timeoutMs ?? SOCKET_REQUEST_TIMEOUT_MS;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`herdr socket request timed out after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      socket.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  /** `ping` round trip; surfaces the `pong` result's `version`/`protocol`/`capabilities`. */
  ping(): Promise<{ version: string; protocol: number; capabilities: Record<string, boolean> }> {
    return this.request("ping", {});
  }

  /** Tear down the live socket (if any) and reject any in-flight requests. Idempotent. */
  close(): void {
    this.rejectAllPending(new Error("herdr socket closed"));
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this.connecting = null;
    this.buffer = "";
  }

  private rejectAllPending(err: unknown): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  /** Lazily opens (or reuses) the persistent connection. Concurrent callers during
   *  the initial connect share the same in-flight promise rather than racing separate
   *  `net.createConnection` calls. */
  private ensureConnected(): Promise<net.Socket> {
    if (this.socket) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<net.Socket>((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);

      const onError = (err: unknown) => {
        this.connecting = null;
        this.socket = null;
        // Reconnect attempt itself failed before ever going live — reject only the
        // connect promise; there is nothing pending on this dead socket yet.
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      socket.once("error", onError);
      socket.once("connect", () => {
        socket.removeListener("error", onError);
        this.socket = socket;
        this.connecting = null;
        this.buffer = "";

        // From here on, an error/close means an already-live connection dropped —
        // fail every in-flight request and let the NEXT request() reconnect.
        socket.on("error", () => this.handleDisconnect());
        socket.on("close", () => this.handleDisconnect());
        socket.on("data", (chunk: Buffer) => this.handleData(chunk));

        resolve(socket);
      });
    });

    return this.connecting;
  }

  private handleDisconnect(): void {
    if (!this.socket) return; // already handled (error + close both fire)
    this.socket.removeAllListeners();
    this.socket = null;
    this.connecting = null;
    this.buffer = "";
    this.rejectAllPending(new Error("herdr socket disconnected"));
  }

  private handleData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? ""; // trailing partial line (or "") stays buffered

    for (const line of lines) {
      if (!line.trim()) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // malformed line — nothing we can dispatch it to; ignore defensively
    }
    const res = parsed as RpcResponse;
    const id = typeof res.id === "string" ? res.id : undefined;
    const entry = id !== undefined ? this.pending.get(id) : undefined;
    if (!entry) return; // unmatched id (or malformed-request echo) — ignore defensively

    clearTimeout(entry.timer);
    this.pending.delete(id!);

    if (res.error) {
      const code = typeof res.error.code === "string" ? res.error.code : "unknown";
      const message = typeof res.error.message === "string" ? res.error.message : "";
      entry.reject(new HerdrSocketError(code, message));
    } else {
      entry.resolve(res.result);
    }
  }
}
