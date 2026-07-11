#!/usr/bin/env bun
/**
 * Captures a SANITIZED response-shape manifest from a LIVE herdr over its native Unix socket
 * (issue #1529 opportunity #5, Task 2). For each read-only method it records ONLY the observed
 * `result.type` (a fixed enum) and the sorted top-level result field names — schema-level facts
 * already public in the vendored schema — never the raw response body, which can carry the
 * operator's real agent names, cwds, and terminal text. The committed manifest is later used
 * (Task 4) to prove the curated `HERDR_METHOD_RESULT` map in `src/generated/herdr-protocol.ts`
 * matches real herdr responses.
 *
 * herdr serves exactly ONE request per connection then closes it, so this opens a FRESH
 * connection per call (connect -> write one `{id,method,params}\n` line -> read one
 * `\n`-terminated reply line -> close). A small inline connector is used here rather than
 * importing the runtime `HerdrSocketClient` (`src/herdr-socket-client.ts`), which pulls in
 * config/maintenance side effects unwanted in dev tooling — mirrors `scripts/gen-herdr-schema.ts`.
 *
 * Robust to a missing/unreachable socket or an `{error}` reply: any such method is logged and
 * SKIPPED, never crashes the run and never writes a partial-then-throws manifest. `agent.read` is
 * intentionally NOT captured — its target addressing is unreliable here and its result would
 * contain terminal text; it stays documented-per-entry in `HERDR_METHOD_RESULT`.
 *
 * Usage: bun run gen:herdr-fixtures   (HERDR_SOCKET_PATH env overrides the socket path)
 */
import * as net from "node:net";
import { homedir } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const SOCKET_REQUEST_TIMEOUT_MS = 10_000;

const socketPath =
  process.env.HERDR_SOCKET_PATH || join(homedir(), ".config", "herdr", "herdr.sock");
const outPath = join(import.meta.dir, "..", "test", "fixtures", "herdr-responses", "manifest.json");

type RpcResponse = {
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
};

/** One request/response over a fresh connection; mirrors `HerdrSocketClient`'s wire framing
 *  (one JSON object per `\n`-delimited line). Resolves the parsed reply object (success OR
 *  `{error}`) — never rejects on an application-level error, only on transport failure
 *  (ENOENT, timeout, malformed line, premature close). */
function request(method: string, params: object): Promise<RpcResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = "";
    const socket = net.createConnection(socketPath);

    const settle = (run: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      run();
    };

    const timer = setTimeout(() => {
      settle(() =>
        reject(
          new Error(
            `herdr socket request timed out after ${SOCKET_REQUEST_TIMEOUT_MS}ms: ${method}`,
          ),
        ),
      );
    }, SOCKET_REQUEST_TIMEOUT_MS);

    socket.on("error", (err) => settle(() => reject(err)));

    socket.on("connect", () => {
      socket.write(JSON.stringify({ id: "1", method, params }) + "\n");
    });

    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      buffer += chunk.toString("utf8");
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
      settle(() => resolve(parsed as RpcResponse));
    });

    const onPrematureClose = () =>
      settle(() => reject(new Error("herdr socket closed before response")));
    socket.on("close", onPrematureClose);
    socket.on("end", onPrematureClose);
  });
}

type CaptureEntry = { type: string; resultKeys: string[] };

/** Calls `method`; returns a sanitized `{type, resultKeys}` entry, or `null` (after logging a
 *  warning) on any transport failure, `{error}` reply, or malformed result. Never throws — one
 *  misbehaving method must not abort the rest of the capture run. */
async function capture(method: string, params: object): Promise<CaptureEntry | null> {
  let res: RpcResponse;
  try {
    res = await request(method, params);
  } catch (err) {
    console.warn(
      `[gen-herdr-fixtures] skipping ${method}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  if (res.error) {
    console.warn(
      `[gen-herdr-fixtures] skipping ${method}: herdr replied with error ${JSON.stringify(res.error)}`,
    );
    return null;
  }
  if (typeof res.result !== "object" || res.result === null) {
    console.warn(`[gen-herdr-fixtures] skipping ${method}: result is not an object`);
    return null;
  }
  const result = res.result as Record<string, unknown>;
  const type = result.type;
  if (typeof type !== "string") {
    console.warn(`[gen-herdr-fixtures] skipping ${method}: result.type is not a string`);
    return null;
  }
  return { type, resultKeys: Object.keys(result).sort() };
}

const manifest: Record<string, CaptureEntry> = {};

for (const [method, params] of [
  ["ping", {}],
  ["agent.list", {}],
  ["workspace.list", {}],
] as const) {
  const entry = await capture(method, params);
  if (entry) manifest[method] = entry;
}

// pane.process_info needs a live pane_id — derive one from pane.list, and skip cleanly (no
// guessed id) if pane.list itself fails or there are simply no panes open right now.
let paneListRes: RpcResponse | null = null;
try {
  paneListRes = await request("pane.list", {});
} catch (err) {
  console.warn(
    `[gen-herdr-fixtures] skipping pane.process_info: pane.list failed: ${err instanceof Error ? err.message : String(err)}`,
  );
}
if (paneListRes && paneListRes.error) {
  console.warn(
    `[gen-herdr-fixtures] skipping pane.process_info: pane.list replied with error ${JSON.stringify(paneListRes.error)}`,
  );
} else if (paneListRes) {
  const panes = (paneListRes.result as Record<string, unknown> | undefined)?.panes;
  const firstPane = Array.isArray(panes)
    ? (panes[0] as Record<string, unknown> | undefined)
    : undefined;
  const paneId = firstPane?.pane_id;
  if (typeof paneId !== "string") {
    console.warn("[gen-herdr-fixtures] skipping pane.process_info: no panes available");
  } else {
    const entry = await capture("pane.process_info", { pane_id: paneId });
    if (entry) manifest["pane.process_info"] = entry;
  }
}

// Sorted-key object so the committed manifest is diff-stable regardless of capture order.
const sortedManifest = Object.fromEntries(
  Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)),
);

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify(sortedManifest, null, 2) + "\n");
console.log(`Wrote ${outPath} (${Object.keys(sortedManifest).length} methods)`);
