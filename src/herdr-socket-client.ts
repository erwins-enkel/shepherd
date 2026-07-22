import * as net from "node:net";
import { config } from "./config";
import { maintenance } from "./maintenance";
import { HerdrUnavailableError } from "./herdr";
import type { HerdrMethod, HerdrParams, HerdrResult } from "./generated/herdr-protocol";

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

type RpcResponse = {
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
};

/**
 * NDJSON JSON-RPC transport over herdr's Unix-domain socket (issue #1529).
 * Empirically, herdr's socket handles exactly ONE request/response per connection
 * and then closes it (confirmed against live herdr 0.7.2 — a second request sent
 * on an already-answered connection never gets a reply). So `request()` opens a
 * fresh connection every call: connect → write one request line → read the one
 * response line → settle → destroy. This is still spawn-free (a Unix-socket
 * connect is far cheaper than fork/exec of the herdr binary), and it makes
 * concurrency trivial — every request is an independent connection, so there is
 * no shared line-reader, no head-of-line blocking, no multiplexing state.
 *
 * Dumb transport only: it knows the wire framing (one JSON object per
 * `\n`-delimited line, requests keyed by a monotonic string `id`) and nothing
 * about herdr's method shapes — that lives in the socket-backed `HerdrDriver`.
 */
export class HerdrSocketClient {
  private nextId = 1;

  constructor(private socketPath: string = config.herdrSocketPath) {}

  /** JSON-RPC round trip: `{id, method, params}` out, `result` (typed `T`) back,
   *  over a NEW connection opened just for this call. Rejects `HerdrSocketError`
   *  on an `{error}` reply, with a timeout error (default `SOCKET_REQUEST_TIMEOUT_MS`)
   *  if no reply arrives in time, or with a "closed before response" error if the
   *  connection drops before a response was parsed. Refuses synchronously (throws
   *  `HerdrUnavailableError`, no socket opened) while `maintenance.active` — mirrors
   *  `makeHerdrRunner`/`makeHerdrAsyncRunner` so nothing pokes the socket mid-update. */
  async request<M extends HerdrMethod>(
    method: M,
    params: HerdrParams[M],
    opts?: { timeoutMs?: number },
  ): Promise<HerdrResult<M>> {
    return this.roundTrip<HerdrResult<M>>(method, params, opts);
  }

  /**
   * Untyped escape hatch for the ≤0.7.4 (protocol ≤16) driver arm to call methods that the
   * VENDORED (protocol 17) schema no longer describes: `agent.send` was removed in p17 (replaced
   * by `agent.send_keys`) and `agent.start` was reshaped incompatibly (`{ kind, pane_id, … }`).
   * Both are still valid on a live ≤0.7.4 server, so the socket driver keeps speaking them on the
   * legacy branch — but they are no longer `HerdrMethod`s, so `request()` can't type them. This
   * keeps that concession in ONE place (the transport, which is protocol-agnostic by design)
   * instead of scattering casts through the driver, and everything on the 0.7.5 path plus every
   * unchanged shared method stays fully typed via `request()`.
   */
  requestLegacy<T>(
    method: string,
    params: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    return this.roundTrip<T>(method, params, opts);
  }

  /** Shared NDJSON round-trip core for {@link request} / {@link requestLegacy}. */
  private async roundTrip<T>(
    method: string,
    params: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    if (maintenance.active) throw new HerdrUnavailableError();

    const id = String(this.nextId++);
    const timeoutMs = opts?.timeoutMs ?? SOCKET_REQUEST_TIMEOUT_MS;

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let buffer = "";
      const socket = net.createConnection(this.socketPath);

      const timer = setTimeout(() => {
        settle(() =>
          reject(new Error(`herdr socket request timed out after ${timeoutMs}ms: ${method}`)),
        );
      }, timeoutMs);

      // Whoever settles first (response, timeout, error, or premature close) wins;
      // the rest are no-ops. Always clean up the timer and the socket on settle.
      const settle = (run: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeAllListeners();
        socket.destroy();
        run();
      };

      // Attach the error handler before any await/tick so a connect failure
      // (e.g. ENOENT, ECONNREFUSED) can never surface as an unhandled error.
      socket.on("error", (err) => settle(() => reject(err)));

      socket.on("connect", () => {
        socket.write(JSON.stringify({ id, method, params }) + "\n");
      });

      socket.on("data", (chunk: Buffer) => {
        if (settled) return;
        buffer += chunk.toString("utf8");
        // Relies on herdr's NDJSON framing: the reply is one newline-terminated line.
        // A response sent without a trailing "\n" before FIN would be treated as a
        // premature close (onPrematureClose) — safe per the 0.7.2 wire contract.
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) return; // still waiting for the rest of the line
        const line = buffer.slice(0, newlineIndex);
        if (!line.trim()) return;

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (err) {
          settle(() => reject(err instanceof Error ? err : new Error(String(err))));
          return;
        }
        const res = parsed as RpcResponse;
        settle(() => {
          if (res.error) {
            const code = typeof res.error.code === "string" ? res.error.code : "unknown";
            const message = typeof res.error.message === "string" ? res.error.message : "";
            reject(new HerdrSocketError(code, message));
          } else {
            resolve(res.result as T);
          }
        });
      });

      // The server FINs right after its one reply — normal case already settled
      // above, so this is a no-op then. If close/end arrives BEFORE a response
      // was parsed, that's a real failure: reject rather than hang.
      const onPrematureClose = () => {
        settle(() => reject(new Error("herdr socket closed before response")));
      };
      socket.on("close", onPrematureClose);
      socket.on("end", onPrematureClose);
    });
  }

  /** `ping` round trip; surfaces the `pong` result's `version`/`protocol`/`capabilities`. */
  ping(): Promise<HerdrResult<"ping">> {
    return this.request("ping", {});
  }

  /** No-op: kept for API symmetry and existing call sites (e.g. `selectHerdrDriver`'s
   *  fallback path). There is no persistent connection to tear down — every
   *  `request()` opens, uses, and closes its own connection. Idempotent. */
  close(): void {
    // Intentionally empty.
  }
}
