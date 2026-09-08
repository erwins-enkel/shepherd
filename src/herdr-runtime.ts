import { spawn } from "node:child_process";
import { config } from "./config";
import { parseHerdrVersion } from "./herdr-capabilities";

export interface HerdrRuntimeStatus {
  state: "ready" | "restart_required" | "offline" | "unknown";
  installedVersion: string | null;
  serverVersion: string | null;
  reason?: "version_mismatch" | "protocol_mismatch" | "unreachable" | "probe_failed";
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  spawnError: unknown;
  overflow: boolean;
}

const OUTPUT_LIMIT = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function version(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function unknownStatus(installedVersion: string | null = null): HerdrRuntimeStatus {
  return {
    state: "unknown",
    installedVersion,
    serverVersion: null,
    reason: "probe_failed",
  };
}

/** Convert the v0.9 `herdr status --json` document into Shepherd's small runtime state. */
export function parseHerdrRuntimeStatus(value: unknown): HerdrRuntimeStatus {
  const root = object(value);
  const client = object(root?.client);
  const server = object(root?.server);
  const installedVersion = version(client?.version);
  const serverVersion = version(server?.version);

  if (!root || !client || !server || !installedVersion || typeof server.running !== "boolean") {
    return unknownStatus(installedVersion);
  }
  if (!server.running) {
    return {
      state: "offline",
      installedVersion,
      serverVersion: null,
      reason: "unreachable",
    };
  }
  if (!serverVersion) return unknownStatus(installedVersion);
  if (serverVersion !== installedVersion) {
    return {
      state: "restart_required",
      installedVersion,
      serverVersion,
      reason: "version_mismatch",
    };
  }

  const update = object(root.update);
  const restartNeeded = server.restart_needed ?? update?.restart_needed;
  if (
    server.compatible === false ||
    server.endpoint_compatible === false ||
    restartNeeded === true
  ) {
    return {
      state: "restart_required",
      installedVersion,
      serverVersion,
      reason: "protocol_mismatch",
    };
  }
  if (server.compatible !== true || server.endpoint_compatible !== true) {
    return unknownStatus(installedVersion);
  }
  return { state: "ready", installedVersion, serverVersion };
}

function hasProtocolMismatchCode(value: unknown, seen = new Set<object>()): boolean {
  const record = object(value);
  if (!record || seen.has(record)) return false;
  seen.add(record);
  if (record.code === "protocol_mismatch") return true;
  return hasProtocolMismatchCode(record.error, seen);
}

interface JsonScanState {
  depth: number;
  quoted: boolean;
  escaped: boolean;
}

function scanJsonCharacter(state: JsonScanState, character: string): void {
  if (state.quoted) {
    if (state.escaped) state.escaped = false;
    else if (character === "\\") state.escaped = true;
    else if (character === '"') state.quoted = false;
    return;
  }
  if (character === '"') state.quoted = true;
  else if (character === "{") state.depth += 1;
  else if (character === "}") state.depth -= 1;
}

function jsonObjectEnd(text: string, start: number): number | null {
  const state: JsonScanState = { depth: 0, quoted: false, escaped: false };
  for (let end = start; end < text.length; end += 1) {
    scanJsonCharacter(state, text[end]!);
    if (state.depth === 0) return end;
  }
  return null;
}

/** Yield complete JSON objects embedded in a line of diagnostic prose. */
function embeddedJson(text: string): unknown[] {
  const values: unknown[] = [];
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    const end = jsonObjectEnd(text, start);
    if (end === null) continue;
    try {
      values.push(JSON.parse(text.slice(start, end + 1)));
    } catch {
      // A prose brace or malformed envelope is not machine evidence.
    }
  }
  return values;
}

/** Detect only the machine-readable protocol mismatch code, including JSON in process errors. */
export function isHerdrProtocolMismatch(error: unknown): boolean {
  if (hasProtocolMismatchCode(error)) return true;
  if (typeof error === "string")
    return embeddedJson(error).some((value) => hasProtocolMismatchCode(value));
  const record = object(error);
  if (!record) return false;
  for (const field of [record.stdout, record.stderr, record.message]) {
    if (
      typeof field === "string" &&
      embeddedJson(field).some((value) => hasProtocolMismatchCode(value))
    ) {
      return true;
    }
  }
  return false;
}

function appendBounded(current: Buffer, chunk: Buffer, limit: number): Buffer {
  if (chunk.length >= limit) return chunk.subarray(chunk.length - limit);
  if (current.length + chunk.length <= limit) return Buffer.concat([current, chunk]);
  return Buffer.concat([current.subarray(current.length + chunk.length - limit), chunk]);
}

/** Spawn without a shell, drain both pipes, and retain only a small tail for diagnosis. */
async function runBounded(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CommandResult> {
  if (signal?.aborted) {
    return {
      code: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      aborted: true,
      spawnError: null,
      overflow: false,
    };
  }
  return await new Promise((resolve) => {
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let total = 0;
    let settled = false;
    let spawnError: unknown = null;
    const child = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    const finish = (result: Omit<CommandResult, "stdout" | "stderr" | "overflow">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve({
        ...result,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        overflow: total > OUTPUT_LIMIT * 2,
      });
    };
    child.stdout.on("data", (data: Buffer) => {
      total += data.length;
      stdout = appendBounded(stdout, data, OUTPUT_LIMIT);
    });
    child.stderr.on("data", (data: Buffer) => {
      total += data.length;
      stderr = appendBounded(stderr, data, OUTPUT_LIMIT);
    });
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (code) => finish({ code, timedOut: false, aborted: false, spawnError }));
    const timer = setTimeout(
      () => {
        child.kill("SIGKILL");
        finish({ code: null, timedOut: true, aborted: false, spawnError });
      },
      Math.max(1, timeoutMs),
    );
    const abort = () => {
      child.kill("SIGKILL");
      finish({ code: null, timedOut: false, aborted: true, spawnError });
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function explicitOffline(result: CommandResult): boolean {
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return (
    /connection refused/.test(text) ||
    /(?:connect|socket)[^\n]*(?:no such file|not found|enoent)/.test(text) ||
    /no such file[^\n]*(?:connect|socket)/.test(text)
  );
}

function resultEvidence(result: CommandResult): Record<string, unknown> {
  return { stdout: result.stdout, stderr: result.stderr, error: result.spawnError };
}

interface ProbeContext {
  bin: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
}

function commandSucceeded(result: CommandResult): boolean {
  return result.code === 0 && !result.timedOut && !result.aborted && !result.spawnError;
}

function protocolMismatchStatus(
  installedVersion: string | null,
  serverVersion: string | null,
): HerdrRuntimeStatus {
  return {
    state: "restart_required",
    installedVersion,
    serverVersion,
    reason: "protocol_mismatch",
  };
}

function parseModernStatus(result: CommandResult): HerdrRuntimeStatus {
  if (result.overflow) return unknownStatus();
  try {
    return parseHerdrRuntimeStatus(JSON.parse(result.stdout));
  } catch {
    return unknownStatus();
  }
}

function classifyAgentProbe(result: CommandResult, ready: HerdrRuntimeStatus): HerdrRuntimeStatus {
  if (commandSucceeded(result)) return ready;
  if (isHerdrProtocolMismatch(resultEvidence(result))) {
    return protocolMismatchStatus(ready.installedVersion, ready.serverVersion);
  }
  if (explicitOffline(result)) return { ...ready, state: "offline", reason: "unreachable" };
  return unknownStatus(ready.installedVersion);
}

async function probeModernReady(
  context: ProbeContext,
  runtime: HerdrRuntimeStatus,
): Promise<HerdrRuntimeStatus> {
  if (runtime.state !== "ready") return runtime;
  const agents = await runBounded(
    context.bin,
    ["agent", "list"],
    context.env,
    context.timeoutMs,
    context.signal,
  );
  return classifyAgentProbe(agents, runtime);
}

async function probeLegacy(context: ProbeContext): Promise<HerdrRuntimeStatus> {
  const [agents, versionResult] = await Promise.all([
    runBounded(context.bin, ["agent", "list"], context.env, context.timeoutMs, context.signal),
    runBounded(context.bin, ["--version"], context.env, context.timeoutMs, context.signal),
  ]);
  const installedVersion =
    versionResult.code === 0 && !versionResult.timedOut
      ? parseHerdrVersion(versionResult.stdout)
      : null;
  return classifyAgentProbe(agents, {
    state: "ready",
    installedVersion,
    serverVersion: null,
  });
}

export async function probeHerdrRuntime(
  options: {
    bin?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<HerdrRuntimeStatus> {
  const context: ProbeContext = {
    bin: options.bin ?? config.herdrBin,
    env: options.env ?? process.env,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: options.signal,
  };
  const status = await runBounded(
    context.bin,
    ["status", "--json"],
    context.env,
    context.timeoutMs,
    context.signal,
  );

  if (status.timedOut || status.aborted || status.spawnError) return unknownStatus();
  if (isHerdrProtocolMismatch(resultEvidence(status))) {
    return protocolMismatchStatus(null, null);
  }
  if (status.code === 0) {
    return probeModernReady(context, parseModernStatus(status));
  }

  // v0.8 and earlier have no `status` command. A real CLI function call is the liveness test;
  // `--version` only identifies the installed binary and is never treated as daemon evidence.
  return probeLegacy(context);
}
