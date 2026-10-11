/**
 * The host-touching half of verified capabilities (issue #2770): every check runs as the user this
 * Shepherd runs as, through one injected `exec` with a timeout, so a Mac without Xcode or a box
 * whose `codex` is logged out reports exactly that. Tests inject every seam; nothing here spawns in
 * a test.
 *
 * Privacy: `claude auth status` prints the account's e-mail and organisation. Only its `loggedIn`
 * flag is read; stdout is never logged, stored or returned.
 *
 * This slice probes platform, agent CLIs (installed + logged in), the Android SDK and the sandbox
 * profiles. Xcode, SDKs and simulators are reported `not_probed` on macOS until #2771.
 */
import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "../config";
import { detectEgressBackend } from "../egress";
import { detectBackend, safeRealpath } from "../sandbox";
import {
  CAPABILITIES,
  CAPABILITY_VOCABULARY_VERSION,
  type Capability,
  type CapabilityReason,
  type CapabilityReport,
  type CapabilitySnapshot,
  type MissingCapability,
  capabilityReport,
  missingRequirements,
} from "./capabilities";
import { instancePlatform } from "./identity";

export interface ExecResult {
  /** Exit code; null when the process did not exit normally (signal, spawn failure). */
  code: number | null;
  stdout: string;
  timedOut: boolean;
  /** The binary does not exist (ENOENT). */
  notFound: boolean;
}

export type CapabilityExec = (
  cmd: string,
  args: string[],
  opts: { timeoutMs: number; env: NodeJS.ProcessEnv },
) => Promise<ExecResult>;

export interface CapabilityProbeDeps {
  exec: CapabilityExec;
  /** `linux` | `macos` | `windows` | raw host platform. */
  platform: string;
  env: NodeJS.ProcessEnv;
  home: string;
  codexBin: string;
  /** Directory entries, or null when the directory cannot be read. */
  readdir: (path: string) => string[] | null;
  /** Whether a spawn would get the bwrap sandbox, and the egress firewall on top of it. */
  detectSandbox: () => { backend: boolean; egress: boolean };
}

const EXEC_TIMEOUT_MS = 5_000;
const EXEC_MAX_BUFFER = 64 * 1024;
const CAPABILITY_PROBE_INTERVAL_MS = 5 * 60_000;

type Verdict = { ok: true; reason: null } | { ok: false; reason: CapabilityReason };

const OK: Verdict = { ok: true, reason: null };
const fail = (reason: CapabilityReason): Verdict => ({ ok: false, reason });

const defaultExec: CapabilityExec = (cmd, args, { timeoutMs, env }) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: EXEC_MAX_BUFFER, env },
      (err, stdout) => {
        const out = String(stdout ?? "");
        if (!err) return resolve({ code: 0, stdout: out, timedOut: false, notFound: false });
        const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: unknown };
        resolve({
          code: typeof e.code === "number" ? e.code : null,
          stdout: out,
          timedOut: e.killed === true && e.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          notFound: e.code === "ENOENT",
        });
      },
    );
  });

function defaultReaddir(path: string): string[] | null {
  try {
    return readdirSync(path);
  } catch {
    return null;
  }
}

/** The same cached self-tests the spawn path uses (`SessionService.detectBackend`), so the report
 *  says what a spawn would actually get. Synchronous and cached per process. */
function defaultDetectSandbox(): { backend: boolean; egress: boolean } {
  const probe = {
    home: homedir(),
    claudeDir: config.claudeDir,
    nodeBinReal: safeRealpath(config.nodeBin),
  };
  const backend = detectBackend(probe) !== null;
  return { backend, egress: backend && detectEgressBackend(probe) !== null };
}

function defaultProbeDeps(): CapabilityProbeDeps {
  return {
    exec: defaultExec,
    platform: instancePlatform(),
    env: process.env,
    home: homedir(),
    codexBin: config.codexBin,
    readdir: defaultReaddir,
    detectSandbox: defaultDetectSandbox,
  };
}

function run(deps: CapabilityProbeDeps, cmd: string, args: string[]): Promise<ExecResult> {
  // A status probe must never start a CLI self-update.
  const env = { ...deps.env, DISABLE_AUTOUPDATER: "1" };
  return deps.exec(cmd, args, { timeoutMs: EXEC_TIMEOUT_MS, env });
}

/** A failed exec as a verdict; null when it exited 0. */
function execFailure(result: ExecResult): Verdict | null {
  if (result.notFound) return fail("not_installed");
  if (result.timedOut) return fail("timeout");
  return result.code === 0 ? null : fail("probe_failed");
}

function claudeLoggedIn(result: ExecResult): boolean {
  try {
    return (JSON.parse(result.stdout) as { loggedIn?: unknown } | null)?.loggedIn === true;
  } catch {
    return false;
  }
}

/** Installed (`--version` exits 0), then logged in. */
async function probeAgent(
  deps: CapabilityProbeDeps,
  bin: string,
  authArgs: string[],
  loggedIn: (result: ExecResult) => boolean,
): Promise<Verdict> {
  const installed = execFailure(await run(deps, bin, ["--version"]));
  if (installed) return installed;
  const auth = await run(deps, bin, authArgs);
  if (auth.notFound) return fail("not_installed");
  if (auth.timedOut) return fail("timeout");
  return loggedIn(auth) ? OK : fail("not_logged_in");
}

function androidSdkRoot(deps: CapabilityProbeDeps): string {
  const fallback = deps.platform === "macos" ? "Library/Android/sdk" : "Android/Sdk";
  return deps.env.ANDROID_HOME || deps.env.ANDROID_SDK_ROOT || join(deps.home, fallback);
}

function hasEntries(deps: CapabilityProbeDeps, path: string): boolean {
  return (deps.readdir(path) ?? []).some((entry) => !entry.startsWith("."));
}

/** An SDK root with at least one platform and one build-tools version, whose `adb` runs here. */
async function probeAndroidSdk(deps: CapabilityProbeDeps): Promise<Verdict> {
  const root = androidSdkRoot(deps);
  if (deps.readdir(root) === null) return fail("sdk_not_found");
  if (!hasEntries(deps, join(root, "platforms")) || !hasEntries(deps, join(root, "build-tools"))) {
    return fail("sdk_incomplete");
  }
  const adb = await run(deps, join(root, "platform-tools", "adb"), ["version"]);
  if (adb.notFound) return fail("sdk_incomplete");
  return execFailure(adb) ?? OK;
}

function sandboxVerdicts(deps: CapabilityProbeDeps): Partial<Record<Capability, Verdict>> {
  let found = { backend: false, egress: false };
  try {
    found = deps.detectSandbox();
  } catch {
    // A throwing detector means no usable sandbox, never a crashed probe.
  }
  return {
    "sandbox:trusted": OK,
    "sandbox:standard": found.backend ? OK : fail("no_backend"),
    "sandbox:autonomous": !found.backend
      ? fail("no_backend")
      : found.egress
        ? OK
        : fail("no_egress"),
  };
}

function platformVerdicts(platform: string): Partial<Record<Capability, Verdict>> {
  const own = (p: string) => (platform === p ? OK : fail("other_platform"));
  const apple = fail(platform === "macos" ? "not_probed" : "other_platform");
  return {
    "platform:linux": own("linux"),
    "platform:macos": own("macos"),
    "platform:windows": own("windows"),
    xcode: apple,
    "sdk:macos": apple,
    "sdk:ios": apple,
    "ios-simulator": apple,
  };
}

/** One full probe. Never rejects: every check folds its own failure into a verdict. */
export async function probeCapabilities(
  deps: CapabilityProbeDeps,
  now: () => number = Date.now,
): Promise<CapabilitySnapshot> {
  const [claude, codex, android] = await Promise.all([
    probeAgent(deps, "claude", ["auth", "status", "--json"], claudeLoggedIn),
    probeAgent(deps, deps.codexBin, ["login", "status"], (r) => r.code === 0),
    probeAndroidSdk(deps),
  ]);
  const verdicts: Partial<Record<Capability, Verdict>> = {
    ...platformVerdicts(deps.platform),
    ...sandboxVerdicts(deps),
    "android-sdk": android,
    "agent:claude": claude,
    "agent:codex": codex,
  };
  return {
    vocabulary: CAPABILITY_VOCABULARY_VERSION,
    probedAt: now(),
    checks: CAPABILITIES.map((id) => ({ id, ...(verdicts[id] ?? fail("not_probed")) })),
  };
}

const okIds = (snapshot: CapabilitySnapshot | null) =>
  snapshot?.checks.flatMap((c) => (c.ok ? [c.id] : [])).join(", ") ?? "";

/**
 * This instance's capabilities: probed every 5 minutes once started, on demand via `refresh()`, and
 * freshly for every create that carries requirements (`verify`). Holds the last snapshot in memory.
 */
export class CapabilityService {
  private current: CapabilitySnapshot | null = null;
  private inflight: Promise<CapabilitySnapshot | null> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly deps: CapabilityProbeDeps;
  private readonly now: () => number;

  constructor(deps: Partial<CapabilityProbeDeps> & { now?: () => number } = {}) {
    const { now, ...probe } = deps;
    this.deps = { ...defaultProbeDeps(), ...probe };
    this.now = now ?? Date.now;
  }

  /** The last snapshot with its current age and stale verdict; null before the first probe. */
  report(): CapabilityReport | null {
    return this.current ? capabilityReport(this.current, this.now()) : null;
  }

  /** Probe now, joining a probe already in flight. Resolves to the fresh snapshot, or null when the
   *  probe failed outright — the previous snapshot then stays on display (and ages). Never rejects. */
  refresh(): Promise<CapabilitySnapshot | null> {
    this.inflight ??= probeCapabilities(this.deps, this.now)
      .then((snapshot) => {
        if (okIds(snapshot) !== okIds(this.current)) {
          console.log(`[capabilities] available: ${okIds(snapshot) || "none"}`);
        }
        this.current = snapshot;
        return snapshot;
      })
      .catch((err: unknown) => {
        console.warn(
          "[capabilities] probe failed:",
          err instanceof Error ? err.message : String(err),
        );
        return null;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  /**
   * The requirements this instance does not meet, checked against a probe that finishes after this
   * call (a fresh one, or one already in flight). If that probe fails, every requirement is
   * refused — the previous snapshot never admits a start.
   */
  async verify(requirements: readonly Capability[]): Promise<MissingCapability[]> {
    const snapshot = await this.refresh();
    if (!snapshot)
      return requirements.map((capability) => ({ capability, reason: "probe_failed" }));
    return missingRequirements(snapshot, requirements);
  }

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), CAPABILITY_PROBE_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
