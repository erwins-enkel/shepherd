import { spawn } from "node:child_process";
import {
  accessSync,
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
} from "node:fs";
import { dirname, delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config";
import { probeHerdrRuntime, type HerdrRuntimeStatus } from "./herdr-runtime";

const WORKER_MARKER = "SHEPHERD_HERDR_RECOVERY_WORKER";
const WORKER_RESTART = "SHEPHERD_HERDR_RECOVERY_RESTART";
const WORKER_BIN = "SHEPHERD_HERDR_RECOVERY_BIN";
const WORKER_EXPECTED = "SHEPHERD_HERDR_RECOVERY_EXPECTED";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_MS = 250;
const CAPTURE_LIMIT = 64 * 1024;

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error: unknown;
}

function setting(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = Number(env[name]);
  return Number.isFinite(value) && value >= 10 && value <= 30_000 ? Math.round(value) : fallback;
}

function tail(current: Buffer, chunk: Buffer): Buffer {
  if (chunk.length >= CAPTURE_LIMIT) return chunk.subarray(chunk.length - CAPTURE_LIMIT);
  if (current.length + chunk.length <= CAPTURE_LIMIT) return Buffer.concat([current, chunk]);
  return Buffer.concat([current.subarray(current.length + chunk.length - CAPTURE_LIMIT), chunk]);
}

function run(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<Result> {
  return new Promise((resolve) => {
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let error: unknown = null;
    let settled = false;
    const child = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk: Buffer) => (stdout = tail(stdout, chunk)));
    child.stderr.on("data", (chunk: Buffer) => (stderr = tail(stderr, chunk)));
    child.on("error", (value) => (error = value));
    const finish = (code: number | null, timedOut: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        timedOut,
        error,
      });
    };
    child.on("close", (code) => finish(code, false));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null, true);
    }, timeoutMs);
  });
}

function resolveBin(bin: string, env: NodeJS.ProcessEnv): string | null {
  const candidates = bin.includes("/")
    ? [bin]
    : (env.PATH ?? "").split(delimiter).map((entry) => join(entry, bin));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Continue to the next PATH entry.
    }
  }
  return null;
}

interface UnitOwnership {
  loaded: boolean;
  related: boolean;
  matching: boolean;
}

function systemdUnescape(value: string): string {
  return value
    .replace(/\\x([0-9a-fA-F]{2})/g, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/\\(.)/g, "$1");
}

interface EnvironmentWordScan {
  words: string[];
  word: string;
  quote: string;
  escaped: boolean;
}

function finishEnvironmentWord(scan: EnvironmentWordScan): void {
  if (scan.word) scan.words.push(scan.word);
  scan.word = "";
}

function scanEnvironmentCharacter(scan: EnvironmentWordScan, character: string): void {
  if (scan.escaped) {
    scan.word += character;
    scan.escaped = false;
    return;
  }
  if (character === "\\") {
    scan.word += character;
    scan.escaped = true;
    return;
  }
  if (scan.quote) {
    if (character === scan.quote) scan.quote = "";
    else scan.word += character;
    return;
  }
  if (character === '"' || character === "'") scan.quote = character;
  else if (/\s/.test(character)) finishEnvironmentWord(scan);
  else scan.word += character;
}

function parseEnvironmentWords(value: string): Map<string, string> {
  const scan: EnvironmentWordScan = { words: [], word: "", quote: "", escaped: false };
  for (const character of value) scanEnvironmentCharacter(scan, character);
  finishEnvironmentWord(scan);
  const values = new Map<string, string>();
  for (const item of scan.words) {
    const equals = item.indexOf("=");
    if (equals > 0) values.set(item.slice(0, equals), systemdUnescape(item.slice(equals + 1)));
  }
  return values;
}

interface ParsedEnvironmentFile {
  values: Map<string, string>;
  certain: boolean;
}

function supportedEnvironmentFileValue(value: string): boolean {
  let quote = "";
  let escaped = false;
  for (const char of value.trim()) {
    if (escaped) escaped = false;
    else if (char === "\\") escaped = true;
    else if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (/\s/.test(char)) return false;
  }
  return !quote && !escaped;
}

function parseEnvironmentFile(path: string, ignoreErrors: boolean): ParsedEnvironmentFile {
  if (!existsSync(path)) return { values: new Map(), certain: ignoreErrors };
  try {
    const values = new Map<string, string>();
    for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || line.startsWith(";")) continue;
      if (/\\$/.test(line)) return { values: new Map(), certain: false };
      const assignment = /^([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
      if (!assignment) return { values: new Map(), certain: false };
      if (!supportedEnvironmentFileValue(assignment[2]!)) {
        return { values: new Map(), certain: false };
      }
      const parsed = parseEnvironmentWords(`${assignment[1]}=${assignment[2]}`);
      if (!parsed.has(assignment[1]!)) return { values: new Map(), certain: false };
      values.set(assignment[1]!, parsed.get(assignment[1]!)!);
    }
    return { values, certain: true };
  } catch {
    return { values: new Map(), certain: false };
  }
}

interface EnvironmentFileReference {
  path: string;
  ignoreErrors: boolean;
}

function environmentFiles(value: string): {
  references: EnvironmentFileReference[];
  certain: boolean;
} {
  const references: EnvironmentFileReference[] = [];
  const pattern = /(?:"([^"]+)"|(\S+))\s+\(ignore_errors=(yes|no)\)/g;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    if (value.slice(cursor, match.index).trim()) return { references: [], certain: false };
    const path = match[1] ?? match[2];
    if (path) {
      references.push({
        path: systemdUnescape(path),
        ignoreErrors: match[3] === "yes",
      });
    }
    cursor = (match.index ?? 0) + match[0].length;
  }
  return {
    references,
    certain: value.slice(cursor).trim().length === 0,
  };
}

function socketFor(env: NodeJS.ProcessEnv, session: string, home: string): string {
  return (
    env.HERDR_SOCKET_PATH ??
    (session === "default"
      ? join(home, ".config", "herdr", "herdr.sock")
      : join(home, ".config", "herdr", "sessions", session, "herdr.sock"))
  );
}

const NO_UNIT: UnitOwnership = { loaded: false, related: false, matching: false };
const AMBIGUOUS_UNIT: UnitOwnership = { loaded: true, related: true, matching: false };

function parseSystemdProperties(stdout: string): Map<string, string> {
  const properties = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const equals = line.indexOf("=");
    if (equals > 0) properties.set(line.slice(0, equals), line.slice(equals + 1));
  }
  return properties;
}

function overlayEnvironment(target: Map<string, string>, source: Map<string, string>): void {
  for (const [key, value] of source) target.set(key, value);
}

async function effectiveUnitEnvironment(
  properties: Map<string, string>,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<Map<string, string> | null> {
  const manager = await run("systemctl", ["--user", "show-environment"], env, timeoutMs);
  const effective =
    manager.code === 0
      ? parseEnvironmentWords(manager.stdout.replace(/\r?\n/g, " "))
      : new Map<string, string>();
  overlayEnvironment(effective, parseEnvironmentWords(properties.get("Environment") ?? ""));
  const files = environmentFiles(properties.get("EnvironmentFiles") ?? "");
  if (!files.certain) return null;
  for (const reference of files.references) {
    const parsed = parseEnvironmentFile(reference.path, reference.ignoreErrors);
    if (!parsed.certain) return null;
    overlayEnvironment(effective, parsed.values);
  }
  return effective;
}

function ownershipFromEnvironment(
  bin: string,
  env: NodeJS.ProcessEnv,
  properties: Map<string, string>,
  unitEnvironment: Map<string, string>,
): UnitOwnership {
  const execStart = properties.get("ExecStart") ?? "";
  const execPath = /(?:^|[;{]\s*)path=(.*?)\s*;/.exec(execStart)?.[1]?.trim() ?? null;
  const unitHome = unitEnvironment.get("HOME");
  if (!unitHome || !execPath) return AMBIGUOUS_UNIT;
  const unitSession = unitEnvironment.get("HERDR_SESSION") ?? "default";
  const unitSocket = socketFor(
    Object.fromEntries(unitEnvironment) as NodeJS.ProcessEnv,
    unitSession,
    unitHome,
  );
  const session = env.HERDR_SESSION ?? "default";
  const related = unitSocket === socketFor(env, session, env.HOME ?? "");
  const resolved = resolveBin(bin, env);
  const binaryMatches = resolved !== null && systemdUnescape(execPath) === resolved;
  return {
    loaded: true,
    related,
    matching: related && binaryMatches && unitSession === session,
  };
}

/**
 * A unit earns control only when systemd's resolved ExecStart names this binary and every
 * non-default herd selector is visible in the unit's effective Environment. A loaded unit that
 * names this herd but a different binary is a competing supervisor, so recovery fails closed.
 */
async function herdrUnitOwnership(
  bin: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<UnitOwnership> {
  const shown = await run(
    "systemctl",
    [
      "--user",
      "show",
      "herdr",
      "--property=LoadState",
      "--property=ExecStart",
      "--property=Environment",
      "--property=EnvironmentFiles",
    ],
    env,
    timeoutMs,
  );
  if (shown.code !== 0 || shown.timedOut || shown.error) return NO_UNIT;
  const properties = parseSystemdProperties(shown.stdout);
  if (properties.get("LoadState") !== "loaded") return NO_UNIT;
  const unitEnvironment = await effectiveUnitEnvironment(properties, env, timeoutMs);
  if (!unitEnvironment) return AMBIGUOUS_UNIT;
  return ownershipFromEnvironment(bin, env, properties, unitEnvironment);
}

function verified(status: HerdrRuntimeStatus): boolean {
  return (
    status.state === "ready" &&
    status.installedVersion !== null &&
    status.serverVersion !== null &&
    status.installedVersion === status.serverVersion
  );
}

function sameSnapshot(actual: HerdrRuntimeStatus, expected: HerdrRuntimeStatus): boolean {
  return (
    actual.state === expected.state &&
    actual.installedVersion === expected.installedVersion &&
    actual.serverVersion === expected.serverVersion &&
    actual.reason === expected.reason
  );
}

function log(logPath: string, message: string): void {
  appendFileSync(logPath, `[herdr-recovery] ${message}\n`);
}

function runFailureFromLog(logPath: string, offset: number): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(logPath, "r");
    const end = fstatSync(fd).size;
    if (end <= offset) return null;
    const start = Math.max(offset, end - CAPTURE_LIMIT);
    const buffer = Buffer.alloc(end - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const prefix = "[herdr-recovery] ";
    const lines = buffer.toString("utf8").split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (lines[index]?.startsWith(prefix)) return lines[index]!.slice(prefix.length);
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

async function waitForVerified(
  bin: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  pollMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    const status = await probeHerdrRuntime({ bin, env, timeoutMs: Math.min(timeoutMs, 1_000) });
    if (verified(status)) return true;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  } while (Date.now() < deadline);
  return false;
}

async function guardStillOffline(
  bin: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<boolean> {
  const status = await probeHerdrRuntime({ bin, env, timeoutMs });
  if (verified(status)) return false;
  if (status.state !== "offline") {
    throw new Error(`runtime guard changed before start: ${status.state}`);
  }
  return true;
}

async function launchDetachedServer(
  bin: string,
  env: NodeJS.ProcessEnv,
  logPath: string,
): Promise<void> {
  const fd = openSync(logPath, "a");
  try {
    const server = spawn(bin, ["server"], {
      detached: true,
      env,
      stdio: ["ignore", fd, fd],
    });
    await new Promise<void>((resolve, reject) => {
      server.once("spawn", resolve);
      server.once("error", reject);
    });
    server.unref();
  } finally {
    closeSync(fd);
  }
}

interface RecoveryContext {
  restart: boolean;
  bin: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
  expected?: HerdrRuntimeStatus;
  timeoutMs: number;
  pollMs: number;
}

function assertExpectedSnapshot(status: HerdrRuntimeStatus, expected?: HerdrRuntimeStatus): void {
  if (expected && !sameSnapshot(status, expected)) {
    throw new Error("runtime changed since confirmation; recovery refused");
  }
}

async function guardInitialRuntime(context: RecoveryContext): Promise<boolean> {
  const initial = await probeHerdrRuntime({
    bin: context.bin,
    env: context.env,
    timeoutMs: context.timeoutMs,
  });
  assertExpectedSnapshot(initial, context.expected);
  if (verified(initial)) {
    log(context.logPath, "runtime already verified");
    return false;
  }
  const requiredState = context.restart ? "restart_required" : "offline";
  if (initial.state !== requiredState) {
    const action = context.restart ? "restart" : "start";
    throw new Error(`runtime guard rejected ${action}: ${initial.state}`);
  }
  return true;
}

function assertCompatibleOwnership(unit: UnitOwnership): void {
  if (unit.loaded && unit.related && !unit.matching) {
    throw new Error(
      "runtime guard rejected recovery: herdr.service owns this herd with different settings",
    );
  }
}

async function stopForRestart(context: RecoveryContext): Promise<boolean> {
  if (!context.restart) return false;
  const beforeStop = await probeHerdrRuntime({
    bin: context.bin,
    env: context.env,
    timeoutMs: context.timeoutMs,
  });
  assertExpectedSnapshot(beforeStop, context.expected);
  if (verified(beforeStop)) {
    log(context.logPath, "runtime became verified before stop");
    return true;
  }
  if (beforeStop.state !== "restart_required") {
    throw new Error(`runtime guard changed before stop: ${beforeStop.state}`);
  }
  log(context.logPath, "stopping selected herdr server");
  const stopped = await run(context.bin, ["server", "stop"], context.env, context.timeoutMs);
  if (stopped.code !== 0 || stopped.timedOut || stopped.error) {
    throw new Error("selected herdr server stop failed");
  }
  // Restart=always supervisors get first chance to recover after the addressed CLI stop.
  const recovered = await waitForVerified(
    context.bin,
    context.env,
    Math.min(context.timeoutMs, 2_000),
    context.pollMs,
  );
  if (recovered) log(context.logPath, "recovery verified after supervisor grace");
  return recovered;
}

async function startMatchingUnit(context: RecoveryContext): Promise<boolean> {
  if (!(await guardStillOffline(context.bin, context.env, context.timeoutMs))) {
    log(context.logPath, "runtime became verified before service start");
    return false;
  }
  log(context.logPath, "starting matching herdr.service");
  await run("systemctl", ["--user", "reset-failed", "herdr"], context.env, context.timeoutMs);
  const started = await run(
    "systemctl",
    ["--user", "start", "herdr"],
    context.env,
    context.timeoutMs,
  );
  if (started.code !== 0 || started.timedOut || started.error) {
    throw new Error("matching herdr.service start failed");
  }
  return true;
}

async function startDetached(context: RecoveryContext): Promise<boolean> {
  // Ownership detection and supervisor grace take time. Re-check immediately before forking so
  // an old supervisor that rebound the socket cannot race an unsupervised second daemon.
  if (!(await guardStillOffline(context.bin, context.env, context.timeoutMs))) {
    log(context.logPath, "runtime became verified before start");
    return false;
  }
  log(context.logPath, "starting detached herdr server");
  await launchDetachedServer(context.bin, context.env, context.logPath);
  return true;
}

async function verifyRecovery(context: RecoveryContext): Promise<void> {
  const recovered = await waitForVerified(
    context.bin,
    context.env,
    context.timeoutMs,
    context.pollMs,
  );
  if (!recovered) throw new Error("herdr recovery failed runtime verification");
  log(context.logPath, "recovery verified");
}

async function worker(
  restart: boolean,
  bin: string,
  env: NodeJS.ProcessEnv,
  logPath: string,
  expected?: HerdrRuntimeStatus,
): Promise<void> {
  const context: RecoveryContext = {
    restart,
    bin,
    env,
    logPath,
    expected,
    timeoutMs: setting(env, "SHEPHERD_HERDR_RECOVERY_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    pollMs: setting(env, "SHEPHERD_HERDR_RECOVERY_POLL_MS", DEFAULT_POLL_MS),
  };
  if (!(await guardInitialRuntime(context))) return;
  const unit = await herdrUnitOwnership(context.bin, context.env, context.timeoutMs);
  assertCompatibleOwnership(unit);
  if (await stopForRestart(context)) return;
  const started = unit.matching ? await startMatchingUnit(context) : await startDetached(context);
  if (!started) return;
  await verifyRecovery(context);
}

export function runHerdrRecovery(options: {
  restart: boolean;
  logPath: string;
  signal: AbortSignal;
  bin?: string;
  env?: NodeJS.ProcessEnv;
  expected?: HerdrRuntimeStatus;
}): Promise<void> {
  if (options.signal.aborted)
    return Promise.reject(options.signal.reason ?? new DOMException("Aborted", "AbortError"));
  const env = options.env ?? process.env;
  const bin = options.bin ?? config.herdrBin;
  mkdirSync(dirname(options.logPath), { recursive: true });
  const fd = openSync(options.logPath, "a");
  const logOffset = fstatSync(fd).size;
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    detached: true,
    env: {
      ...env,
      [WORKER_MARKER]: "1",
      [WORKER_RESTART]: options.restart ? "1" : "0",
      [WORKER_BIN]: bin,
      [WORKER_EXPECTED]: options.expected ? JSON.stringify(options.expected) : "",
      SHEPHERD_HERDR_RECOVERY_LOG: options.logPath,
      // The caller already supplied the selected, config-adjusted socket. Importing config in a
      // worker launched from inside a herdr pane must not reinterpret that explicit snapshot.
      SHEPHERD_HERDR_IGNORE_SESSION: "1",
    },
    stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  child.unref();

  return new Promise((resolve, reject) => {
    let settled = false;
    let abortReason: unknown;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener("abort", aborted);
      if (error !== undefined) reject(error);
      else resolve();
    };
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // The worker exited between observing the signal and killing its process group.
      }
    };
    const aborted = () => {
      abortReason = options.signal.reason ?? new DOMException("Aborted", "AbortError");
      killGroup("SIGKILL");
    };
    options.signal.addEventListener("abort", aborted, { once: true });
    if (options.signal.aborted) aborted();
    child.on("error", (error) => finish(abortReason ?? error));
    child.on("close", (code) =>
      abortReason
        ? finish(abortReason)
        : code === 0
          ? finish()
          : finish(
              new Error(
                runFailureFromLog(options.logPath, logOffset) ??
                  `herdr recovery worker exited ${String(code)}`,
              ),
            ),
    );
  });
}

if (import.meta.main && process.env[WORKER_MARKER] === "1") {
  const logPath = process.env.SHEPHERD_HERDR_RECOVERY_LOG;
  const bin = process.env[WORKER_BIN];
  if (!logPath || !bin) throw new Error("missing herdr recovery worker configuration");
  const globalTimeoutMs = setting(process.env, "SHEPHERD_HERDR_RECOVERY_GLOBAL_TIMEOUT_MS", 30_000);
  const globalTimer = setTimeout(() => {
    log(logPath, "global recovery deadline exceeded");
    try {
      process.kill(-process.pid, "SIGKILL");
    } catch {
      process.exit(1);
    }
  }, globalTimeoutMs);
  try {
    const expectedRaw = process.env[WORKER_EXPECTED];
    const expected = expectedRaw ? (JSON.parse(expectedRaw) as HerdrRuntimeStatus) : undefined;
    await worker(process.env[WORKER_RESTART] === "1", bin, process.env, logPath, expected);
  } catch (error) {
    log(logPath, error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    clearTimeout(globalTimer);
  }
}
