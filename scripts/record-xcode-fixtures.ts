// Records a parser fixture for the macOS capability probe (issue #2771). It runs every command the
// probe may run (`MACOS_PROBE_COMMANDS`) as this user and stores their raw output, next to an
// `expected` verdict taken from OTHER sources — the Xcode bundle's plists, `xcrun
// --show-sdk-version`, the text form of `simctl list` — so a fixture pins the probe's parsers
// instead of restating them. `test/capability-probe-xcode.test.ts` replays every file under
// `test/fixtures/xcode/` on Linux.
//
// Run it on the Mac, as the user the Mac Shepherd runs as:
//
//   bun scripts/record-xcode-fixtures.ts test/fixtures/xcode/macbook.json --source "MacBook"
//
// It then prints this Mac's live capability snapshot (verdicts and versions only). The home
// directory is redacted to `~` in what it records; still read the file for anything personal (a
// simulator named after someone) before committing it.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CapabilityService, MACOS_PROBE_COMMANDS } from "../src/remote-instances/capability-probe";

export interface RecordedRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** What the recording host's other sources say, per macOS entry; an entry it lacks is missing. */
export type XcodeExpected = Partial<
  Record<"platform:macos" | "xcode" | "sdk:macos" | "sdk:ios" | "ios-simulator", string>
>;

export interface XcodeRecording {
  /** Where, on which macOS and Xcode, and when it was recorded. */
  source: string;
  /** Keyed `"<cmd> <args…>"`, as the probe's exec sees them. */
  commands: Record<string, RecordedRun>;
  expected: XcodeExpected;
}

// Generous: a cold CoreSimulatorService can take a while; recording is not on any hot path.
const RECORD_TIMEOUT_MS = 60_000;

function sh(cmd: string, args: readonly string[]): RecordedRun {
  const result = spawnSync(cmd, [...args], {
    encoding: "utf8",
    timeout: RECORD_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, DISABLE_AUTOUPDATER: "1" },
  });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** A command's trimmed output when it succeeds and prints something, else null. */
function value(cmd: string, args: readonly string[]): string | null {
  const run = sh(cmd, args);
  return run.code === 0 ? run.stdout.trim() || null : null;
}

function redact(text: string): string {
  const home = homedir();
  return home.length > 1 ? text.replaceAll(home, "~") : text;
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

/** The iOS sections of the text `simctl list devices available` that list at least one device:
 *  `-- iOS 18.5 --` followed by indented device lines. */
function iosRuntimesWithDevices(text: string): string[] {
  const found = new Set<string>();
  let runtime: string | null = null;
  for (const line of text.split("\n")) {
    const header = /^-- (.+) --$/.exec(line.trim());
    if (header) {
      runtime = /^iOS (\d+(?:\.\d+)*)$/.exec(header[1] ?? "")?.[1] ?? null;
    } else if (runtime && /^\s+\S/.test(line)) {
      found.add(runtime);
    }
  }
  return [...found].sort(compareVersions);
}

/** The expected verdicts, from sources the probe does not parse. */
function expectedFromOtherSources(developerDir: RecordedRun): XcodeExpected {
  const expected: XcodeExpected = {};
  const os = value("/usr/bin/sw_vers", ["-productVersion"]);
  const osBuild = value("/usr/bin/sw_vers", ["-buildVersion"]);
  if (os) expected["platform:macos"] = osBuild ? `${os} (${osBuild})` : os;

  const dir = developerDir.code === 0 ? developerDir.stdout.trim() : "";
  if (!dir || dir.endsWith("/CommandLineTools")) return expected;
  // A refused license (or a broken toolchain) leaves the whole Xcode family missing.
  if (sh("/usr/bin/xcrun", ["--find", "clang"]).code !== 0) return expected;

  const contents = dirname(dir); // …/Xcode.app/Contents
  const plist = (key: string, file: string) =>
    value("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", join(contents, file)]);
  const version = plist("CFBundleShortVersionString", "Info.plist");
  if (!version) return expected;
  const build = plist("ProductBuildVersion", "version.plist");
  expected.xcode = build ? `${version} (${build})` : version;

  const sdk = (name: string) => value("/usr/bin/xcrun", ["--sdk", name, "--show-sdk-version"]);
  const macosSdk = sdk("macosx");
  if (macosSdk) expected["sdk:macos"] = macosSdk;
  const iosSdk = sdk("iphoneos");
  if (iosSdk) expected["sdk:ios"] = iosSdk;
  if (sdk("iphonesimulator")) {
    const list = sh("/usr/bin/xcrun", ["simctl", "list", "devices", "available"]);
    const runtimes = list.code === 0 ? iosRuntimesWithDevices(list.stdout) : [];
    if (runtimes.length > 0) expected["ios-simulator"] = runtimes.join(", ");
  }
  return expected;
}

/** Records this Mac under `host`. Never calls an Xcode tool without a developer directory: the
 *  /usr/bin shims would open the "install Command Line Tools" dialog. */
export function recordXcode(host: string): XcodeRecording {
  const commands: Record<string, RecordedRun> = {};
  const record = (name: keyof typeof MACOS_PROBE_COMMANDS): RecordedRun => {
    const [cmd, args] = MACOS_PROBE_COMMANDS[name];
    const run = sh(cmd, args);
    commands[[cmd, ...args].join(" ")] = {
      code: run.code,
      stdout: redact(run.stdout),
      stderr: redact(run.stderr),
    };
    return run;
  };
  record("osVersion");
  const developerDir = record("developerDir");
  if (developerDir.code === 0) {
    for (const name of ["xcodeVersion", "license", "sdks", "simulators"] as const) record(name);
  }
  const expected = expectedFromOtherSources(developerDir);
  const source = [
    host,
    `macOS ${expected["platform:macos"] ?? "?"}`,
    `Xcode ${expected.xcode ?? "none"}`,
    `recorded ${new Date().toISOString().slice(0, 10)} by scripts/record-xcode-fixtures.ts`,
  ].join(", ");
  return { source, commands, expected };
}

async function main(argv: string[]): Promise<void> {
  const [out, flag, label] = argv;
  if (process.platform !== "darwin") {
    console.error("record-xcode-fixtures: run this on the Mac whose Xcode you want to record");
    process.exit(1);
  }
  if (!out || (flag !== undefined && (flag !== "--source" || !label))) {
    console.error('usage: bun scripts/record-xcode-fixtures.ts <out.json> [--source "<host>"]');
    process.exit(2);
  }
  const recording = recordXcode(label ?? "a Mac");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(recording, null, 2)}\n`);
  console.error(`wrote ${out}`);
  console.log(JSON.stringify(await new CapabilityService().refresh(), null, 2));
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
