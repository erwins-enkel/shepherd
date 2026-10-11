/**
 * The host-touching half of verified capabilities (issue #2770): every check runs as the user this
 * Shepherd runs as, through one injected `exec` with a timeout, so a Mac without Xcode or a box
 * whose `codex` is logged out reports exactly that. Tests inject every seam; nothing here spawns in
 * a test.
 *
 * Privacy: `claude auth status` prints the account's e-mail and organisation. Only its `loggedIn`
 * flag is read; stdout is never logged, stored or returned.
 *
 * It probes platform, agent CLIs (installed + logged in), the Android SDK, the sandbox profiles and,
 * on macOS (#2771), the OS version, the active Xcode, its license, its SDKs and the iOS simulators.
 * Xcode's tools are read for versions only; their paths and device names never reach a snapshot.
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
  /** Read only to recognise Xcode's license refusal, never logged or stored. Absent when the
   *  caller (a test double) has none. */
  stderr?: string;
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
/** `xcrun simctl list -j` on a Mac with many simulators runs well past 64 KiB. */
const EXEC_MAX_BUFFER = 1024 * 1024;
const CAPABILITY_PROBE_INTERVAL_MS = 5 * 60_000;

type Verdict = ({ ok: true; reason: null } | { ok: false; reason: CapabilityReason }) & {
  detail?: string;
};

const OK: Verdict = { ok: true, reason: null };
const fail = (reason: CapabilityReason): Verdict => ({ ok: false, reason });

const defaultExec: CapabilityExec = (cmd, args, { timeoutMs, env }) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: EXEC_MAX_BUFFER, env },
      (err, stdout, stderr) => {
        const out = String(stdout ?? "");
        const errOut = String(stderr ?? "");
        if (!err) {
          return resolve({
            code: 0,
            stdout: out,
            stderr: errOut,
            timedOut: false,
            notFound: false,
          });
        }
        const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: unknown };
        resolve({
          code: typeof e.code === "number" ? e.code : null,
          stdout: out,
          stderr: errOut,
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
  return {
    "platform:linux": own("linux"),
    "platform:macos": own("macos"),
    "platform:windows": own("windows"),
  };
}

/**
 * Every command the macOS probe may run. `scripts/record-xcode-fixtures.ts` records exactly these
 * for the parser fixtures. Absolute paths: Apple's tool shims always live in /usr/bin.
 */
export const MACOS_PROBE_COMMANDS = {
  osVersion: ["/usr/bin/sw_vers", []],
  developerDir: ["/usr/bin/xcode-select", ["-p"]],
  xcodeVersion: ["/usr/bin/xcodebuild", ["-version"]],
  license: ["/usr/bin/xcrun", ["--find", "clang"]],
  sdks: ["/usr/bin/xcodebuild", ["-showsdks"]],
  simulators: ["/usr/bin/xcrun", ["simctl", "list", "-j", "devices", "available"]],
} as const satisfies Record<string, readonly [string, readonly string[]]>;

type XcodeFamily = "xcode" | "sdk:macos" | "sdk:ios" | "ios-simulator";

function runMacos(
  deps: CapabilityProbeDeps,
  command: keyof typeof MACOS_PROBE_COMMANDS,
): Promise<ExecResult> {
  const [cmd, args] = MACOS_PROBE_COMMANDS[command];
  return run(deps, cmd, [...args]);
}

/** One verdict for the whole Xcode family: what keeps Xcode out keeps its SDKs and simulator out,
 *  and each of them names that reason. */
function xcodeFamily(verdict: Verdict): Record<XcodeFamily, Verdict> {
  return { xcode: verdict, "sdk:macos": verdict, "sdk:ios": verdict, "ios-simulator": verdict };
}

/** A failed Xcode tool as a verdict; null when it exited 0. Until its license is agreed to, Xcode
 *  refuses its tools and says so — Homebrew's `check_xcode_license_approved` reads it the same
 *  way. The output is only matched here, never kept. */
function xcodeToolFailure(result: ExecResult): Verdict | null {
  const failed = execFailure(result);
  if (failed?.reason !== "probe_failed") return failed;
  return /license/i.test(`${result.stdout}\n${result.stderr ?? ""}`)
    ? fail("license_not_accepted")
    : failed;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

const versionList = (versions: string[]) => [...new Set(versions)].sort(compareVersions).join(", ");

/** `<version> (<build>)` from two labelled lines; null when the version line is missing. */
function versionWithBuild(stdout: string, version: RegExp, build: RegExp): string | null {
  const v = version.exec(stdout)?.[1];
  if (!v) return null;
  const b = build.exec(stdout)?.[1];
  return b ? `${v} (${b})` : v;
}

/** `xcodebuild -showsdks` → versions per SDK family, read from the `-sdk <family><version>`
 *  column (`-sdk iphoneos18.5`). Null when the output names no SDK at all. */
function parseSdks(stdout: string): Map<string, string[]> | null {
  const sdks = new Map<string, string[]>();
  for (const [, family, version] of stdout.matchAll(/-sdk\s+([a-z]+)(\d+(?:\.\d+)*)\b/g)) {
    if (family && version) sdks.set(family, [...(sdks.get(family) ?? []), version]);
  }
  return sdks.size > 0 ? sdks : null;
}

/** `xcrun simctl list -j devices available` → the iOS runtime versions that have at least one
 *  available device (`com.apple.CoreSimulator.SimRuntime.iOS-18-5` → `18.5`). Null when the output
 *  is not that JSON. */
function parseIosSimulators(stdout: string): string[] | null {
  let devices: unknown;
  try {
    devices = (JSON.parse(stdout) as { devices?: unknown } | null)?.devices;
  } catch {
    return null;
  }
  if (typeof devices !== "object" || devices === null || Array.isArray(devices)) return null;
  const versions: string[] = [];
  for (const [runtime, list] of Object.entries(devices)) {
    const version = /\.SimRuntime\.iOS-(\d+(?:-\d+)*)$/.exec(runtime)?.[1];
    if (!version || !Array.isArray(list)) continue;
    const available = list.some(
      (d: unknown) =>
        typeof d === "object" && d !== null && (d as Record<string, unknown>).isAvailable !== false,
    );
    if (available) versions.push(version.replaceAll("-", "."));
  }
  return versions;
}

/** The SDK entries from `-showsdks` and the simulator from both it and `simctl`. */
function sdkVerdicts(
  sdkRun: ExecResult,
  simRun: ExecResult,
): Record<Exclude<XcodeFamily, "xcode">, Verdict> {
  const sdkFailed = xcodeToolFailure(sdkRun);
  const sdks = sdkFailed ? null : parseSdks(sdkRun.stdout);
  if (!sdks) {
    const failed = sdkFailed ?? fail("probe_failed");
    return { "sdk:macos": failed, "sdk:ios": failed, "ios-simulator": failed };
  }
  const sdk = (family: string): Verdict => {
    const versions = sdks.get(family);
    return versions ? { ...OK, detail: versionList(versions) } : fail("sdk_not_found");
  };
  return {
    "sdk:macos": sdk("macosx"),
    "sdk:ios": sdk("iphoneos"),
    "ios-simulator": sdks.has("iphonesimulator") ? simulatorVerdict(simRun) : fail("sdk_not_found"),
  };
}

function simulatorVerdict(simRun: ExecResult): Verdict {
  const failed = xcodeToolFailure(simRun);
  if (failed) return failed;
  const runtimes = parseIosSimulators(simRun.stdout);
  if (!runtimes) return fail("probe_failed");
  return runtimes.length > 0 ? { ...OK, detail: versionList(runtimes) } : fail("no_simulator");
}

/**
 * Xcode, its SDKs and the iOS simulator. A full Xcode must be selected, answer
 * `xcodebuild -version` and have its license agreed to; the Command Line Tools — enough to build a
 * bare Package.swift — never count, and neither does the platform alone.
 */
async function probeXcode(deps: CapabilityProbeDeps): Promise<Record<XcodeFamily, Verdict>> {
  const dir = await runMacos(deps, "developerDir");
  const noDir = execFailure(dir);
  // Without a developer directory the /usr/bin xcodebuild and xcrun shims open the "install
  // Command Line Tools" dialog, so neither runs.
  if (noDir) return xcodeFamily(noDir.reason === "probe_failed" ? fail("not_installed") : noDir);
  if (/\/CommandLineTools\/?$/.test(dir.stdout.trim())) {
    return xcodeFamily(fail("command_line_tools_only"));
  }
  const versionRun = await runMacos(deps, "xcodeVersion");
  const versionFailed = xcodeToolFailure(versionRun);
  if (versionFailed) return xcodeFamily(versionFailed);
  const detail = versionWithBuild(versionRun.stdout, /^Xcode\s+(\S+)/m, /^Build version\s+(\S+)/m);
  if (!detail) return xcodeFamily(fail("probe_failed"));
  const license = xcodeToolFailure(await runMacos(deps, "license"));
  if (license) return { ...xcodeFamily(license), xcode: { ...license, detail } };
  const [sdkRun, simRun] = await Promise.all([
    runMacos(deps, "sdks"),
    runMacos(deps, "simulators"),
  ]);
  return { xcode: { ...OK, detail }, ...sdkVerdicts(sdkRun, simRun) };
}

/** The macOS entries: the platform with its OS version, and the Xcode family. */
async function probeMacos(
  deps: CapabilityProbeDeps,
): Promise<Partial<Record<Capability, Verdict>>> {
  const [os, xcode] = await Promise.all([runMacos(deps, "osVersion"), probeXcode(deps)]);
  const version =
    os.code === 0
      ? versionWithBuild(os.stdout, /^ProductVersion:\s*(\S+)/m, /^BuildVersion:\s*(\S+)/m)
      : null;
  return { "platform:macos": version ? { ...OK, detail: version } : OK, ...xcode };
}

/** One full probe. Never rejects: every check folds its own failure into a verdict. */
export async function probeCapabilities(
  deps: CapabilityProbeDeps,
  now: () => number = Date.now,
): Promise<CapabilitySnapshot> {
  const [claude, codex, android, macos] = await Promise.all([
    probeAgent(deps, "claude", ["auth", "status", "--json"], claudeLoggedIn),
    probeAgent(deps, deps.codexBin, ["login", "status"], (r) => r.code === 0),
    probeAndroidSdk(deps),
    deps.platform === "macos" ? probeMacos(deps) : null,
  ]);
  const verdicts: Partial<Record<Capability, Verdict>> = {
    ...platformVerdicts(deps.platform),
    ...(macos ?? xcodeFamily(fail("other_platform"))),
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
