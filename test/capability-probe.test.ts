import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { CapabilityCheck } from "../src/remote-instances/capabilities";
import {
  type CapabilityExec,
  type CapabilityProbeDeps,
  CapabilityService,
  type ExecResult,
  probeCapabilities,
} from "../src/remote-instances/capability-probe";

// The capability probe (#2770) through an injected `exec`: nothing here spawns a process, reads the
// real file system or runs the real sandbox self-test.

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, timedOut: false, notFound: false });
const exit = (code: number, stdout = ""): ExecResult => ({
  code,
  stdout,
  timedOut: false,
  notFound: false,
});
const refused = (code: number, stderr: string): ExecResult => ({
  code,
  stdout: "",
  stderr,
  timedOut: false,
  notFound: false,
});
const missing: ExecResult = { code: null, stdout: "", timedOut: false, notFound: true };
const hung: ExecResult = { code: null, stdout: "", timedOut: true, notFound: false };

const SDK = "/opt/android-sdk";

/** A Linux host: claude installed and logged in, codex installed but logged out, an Android SDK
 *  under ANDROID_HOME, bwrap without the egress firewall. */
function linuxHost(over: Record<string, ExecResult> = {}) {
  const table: Record<string, ExecResult> = {
    "claude --version": ok("2.1.296 (Claude Code)\n"),
    "claude auth status --json": ok(
      JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "secret@example.test" }),
    ),
    "codex --version": ok("codex-cli 0.162.1\n"),
    "codex login status": exit(1, "Not logged in\n"),
    [`${SDK}/platform-tools/adb version`]: ok("Android Debug Bridge version 1.0.41\n"),
    ...over,
  };
  const calls: { key: string; env: NodeJS.ProcessEnv; timeoutMs: number }[] = [];
  const exec: CapabilityExec = async (cmd, args, opts) => {
    const key = [cmd, ...args].join(" ");
    calls.push({ key, env: opts.env, timeoutMs: opts.timeoutMs });
    return table[key] ?? missing;
  };
  const dirs: Record<string, string[]> = {
    [SDK]: ["platforms", "build-tools", "platform-tools"],
    [`${SDK}/platforms`]: ["android-35"],
    [`${SDK}/build-tools`]: ["35.0.0"],
  };
  const deps: CapabilityProbeDeps = {
    exec,
    platform: "linux",
    env: { ANDROID_HOME: SDK, PATH: "/usr/bin" },
    home: "/home/svc",
    codexBin: "codex",
    readdir: (path) => dirs[path] ?? null,
    detectSandbox: () => ({ backend: true, egress: false }),
  };
  return { deps, calls, dirs, table };
}

const byId = (checks: CapabilityCheck[]) =>
  Object.fromEntries(checks.map((c) => [c.id, c.ok ? "ok" : c.reason]));

const XCODE = "/Applications/Xcode.app/Contents/Developer";
const IOS_RUNTIME = "com.apple.CoreSimulator.SimRuntime.iOS-";
const SHOWSDKS = [
  "DriverKit SDKs:",
  "\tDriverKit 24.5                \t-sdk driverkit24.5",
  "",
  "iOS SDKs:",
  "\tiOS 18.5                      \t-sdk iphoneos18.5",
  "",
  "iOS Simulator SDKs:",
  "\tSimulator - iOS 18.5          \t-sdk iphonesimulator18.5",
  "",
  "macOS SDKs:",
  "\tmacOS 15.5                    \t-sdk macosx15.5",
  "",
].join("\n");
const simctl = (devices: Record<string, { name: string; isAvailable?: boolean }[]>) =>
  ok(JSON.stringify({ devices }));
// What Xcode prints for every tool until its license is agreed to; exit 69 is EX_UNAVAILABLE.
const LICENSE_REFUSAL =
  "Agreeing to the Xcode/iOS license requires admin privileges, please run “sudo xcodebuild -license” and then retry this command.\n";

/** A Mac whose service user has Xcode 16.4 selected, its license agreed to, the macOS and iOS
 *  SDKs and iOS 18.5 + 26.0 simulators (plus a watchOS one that must not count). */
function macHost(over: Record<string, ExecResult> = {}) {
  const host = linuxHost({
    "/usr/bin/sw_vers": ok(
      "ProductName:\t\tmacOS\nProductVersion:\t\t15.5\nBuildVersion:\t\t24F74\n",
    ),
    "/usr/bin/xcode-select -p": ok(`${XCODE}\n`),
    "/usr/bin/xcodebuild -version": ok("Xcode 16.4\nBuild version 16F6\n"),
    "/usr/bin/xcrun --find clang": ok(
      `${XCODE}/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang\n`,
    ),
    "/usr/bin/xcodebuild -showsdks": ok(SHOWSDKS),
    "/usr/bin/xcrun simctl list -j devices available": simctl({
      [`${IOS_RUNTIME}26-0`]: [{ name: "iPhone 17 Pro", isAvailable: true }],
      [`${IOS_RUNTIME}18-5`]: [{ name: "iPhone 16", isAvailable: true }],
      "com.apple.CoreSimulator.SimRuntime.watchOS-11-5": [
        { name: "Apple Watch", isAvailable: true },
      ],
    }),
    ...over,
  });
  host.deps.platform = "macos";
  return host;
}

const APPLE = ["platform:macos", "xcode", "sdk:macos", "sdk:ios", "ios-simulator"];
/** The macOS entries as `ok <detail>` or their reason. */
const apple = (checks: CapabilityCheck[]) =>
  Object.fromEntries(
    checks
      .filter((c) => APPLE.includes(c.id))
      .map((c) => [c.id, c.ok ? `ok ${c.detail ?? ""}`.trim() : c.reason]),
  );
const xcodeTools = (calls: { key: string }[]) =>
  calls.filter((c) => /^\/usr\/bin\/(xcodebuild|xcrun) /.test(c.key)).map((c) => c.key);

describe("probeCapabilities", () => {
  test("reports a Linux host's capabilities, agent login included, stamped with probedAt", async () => {
    const { deps } = linuxHost();
    const snap = await probeCapabilities(deps, () => 1_234);
    expect(snap.probedAt).toBe(1_234);
    expect(snap.vocabulary).toBe(1);
    expect(byId(snap.checks)).toEqual({
      "platform:linux": "ok",
      "platform:macos": "other_platform",
      "platform:windows": "other_platform",
      xcode: "other_platform",
      "sdk:macos": "other_platform",
      "sdk:ios": "other_platform",
      "ios-simulator": "other_platform",
      "android-sdk": "ok",
      "agent:claude": "ok",
      "agent:codex": "not_logged_in",
      "sandbox:trusted": "ok",
      "sandbox:standard": "ok",
      "sandbox:autonomous": "no_egress",
    });
  });

  test("never lets the account details claude prints reach the snapshot", async () => {
    const { deps } = linuxHost();
    expect(JSON.stringify(await probeCapabilities(deps))).not.toContain("secret@example.test");
  });

  test("runs every command with a timeout and without a self-update", async () => {
    for (const { deps, calls } of [linuxHost(), macHost()]) {
      await probeCapabilities(deps);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.timeoutMs).toBe(5_000);
        expect(call.env.DISABLE_AUTOUPDATER).toBe("1");
        expect(call.env.PATH).toBe("/usr/bin");
      }
    }
  });

  test("tells not installed, not logged in, timeout and a broken binary apart", async () => {
    const cases: [Record<string, ExecResult>, string][] = [
      [{ "claude --version": missing }, "not_installed"],
      [{ "claude --version": hung }, "timeout"],
      [{ "claude --version": exit(2) }, "probe_failed"],
      [{ "claude auth status --json": hung }, "timeout"],
      [
        { "claude auth status --json": exit(1, JSON.stringify({ loggedIn: false })) },
        "not_logged_in",
      ],
      [{ "claude auth status --json": ok("not json") }, "not_logged_in"],
    ];
    for (const [over, reason] of cases) {
      const snap = await probeCapabilities(linuxHost(over).deps);
      expect(byId(snap.checks)["agent:claude"]).toBe(reason);
    }
  });

  test("codex counts as logged in on a zero exit of its status command", async () => {
    const snap = await probeCapabilities(linuxHost({ "codex login status": ok("Logged in") }).deps);
    expect(byId(snap.checks)["agent:codex"]).toBe("ok");
  });

  test("uses the configured codex binary", async () => {
    const { deps, calls } = linuxHost({
      "/opt/codex --version": ok(),
      "/opt/codex login status": ok(),
    });
    const snap = await probeCapabilities({ ...deps, codexBin: "/opt/codex" });
    expect(byId(snap.checks)["agent:codex"]).toBe("ok");
    expect(calls.some((c) => c.key.startsWith("codex "))).toBe(false);
  });

  test("Android SDK: not found, incomplete, and a non-running adb", async () => {
    const absent = linuxHost();
    absent.deps.env = {};
    expect(byId((await probeCapabilities(absent.deps)).checks)["android-sdk"]).toBe(
      "sdk_not_found",
    );

    const noPlatforms = linuxHost();
    noPlatforms.dirs[`${SDK}/platforms`] = [".DS_Store"];
    expect(byId((await probeCapabilities(noPlatforms.deps)).checks)["android-sdk"]).toBe(
      "sdk_incomplete",
    );

    const noAdb = linuxHost({ [`${SDK}/platform-tools/adb version`]: missing });
    expect(byId((await probeCapabilities(noAdb.deps)).checks)["android-sdk"]).toBe(
      "sdk_incomplete",
    );

    const hungAdb = linuxHost({ [`${SDK}/platform-tools/adb version`]: hung });
    expect(byId((await probeCapabilities(hungAdb.deps)).checks)["android-sdk"]).toBe("timeout");
  });

  test("falls back to ANDROID_SDK_ROOT, then the platform's default SDK path", async () => {
    const viaRoot = linuxHost();
    viaRoot.deps.env = { ANDROID_SDK_ROOT: SDK };
    expect(byId((await probeCapabilities(viaRoot.deps)).checks)["android-sdk"]).toBe("ok");

    const seen: string[] = [];
    const fallback = linuxHost();
    fallback.deps.env = {};
    fallback.deps.readdir = (path) => (seen.push(path), null);
    await probeCapabilities(fallback.deps);
    await probeCapabilities({ ...fallback.deps, platform: "macos" });
    expect(seen).toContain("/home/svc/Android/Sdk");
    expect(seen).toContain("/home/svc/Library/Android/sdk");
  });

  test("sandbox profiles follow the detected backends; a throwing detector means none", async () => {
    const none = linuxHost();
    none.deps.detectSandbox = () => ({ backend: false, egress: false });
    expect(byId((await probeCapabilities(none.deps)).checks)).toMatchObject({
      "sandbox:trusted": "ok",
      "sandbox:standard": "no_backend",
      "sandbox:autonomous": "no_backend",
    });

    const full = linuxHost();
    full.deps.detectSandbox = () => ({ backend: true, egress: true });
    expect(byId((await probeCapabilities(full.deps)).checks)["sandbox:autonomous"]).toBe("ok");

    const broken = linuxHost();
    broken.deps.detectSandbox = () => {
      throw new Error("bwrap exploded");
    };
    expect(byId((await probeCapabilities(broken.deps)).checks)["sandbox:standard"]).toBe(
      "no_backend",
    );
  });

  test("a Windows host reports platform:windows", async () => {
    const snap = await probeCapabilities({ ...linuxHost().deps, platform: "windows" });
    expect(byId(snap.checks)["platform:windows"]).toBe("ok");
  });

  test("Linux and Windows run no Apple tool and leave the Xcode family to macOS", async () => {
    for (const platform of ["linux", "windows"]) {
      const { deps, calls } = linuxHost();
      const snap = await probeCapabilities({ ...deps, platform });
      expect(calls.some((c) => c.key.startsWith("/usr/bin/"))).toBe(false);
      expect(apple(snap.checks)).toMatchObject({
        xcode: "other_platform",
        "sdk:macos": "other_platform",
        "ios-simulator": "other_platform",
      });
    }
  });
});

describe("probeCapabilities on macOS (#2771)", () => {
  test("reports the macOS version, Xcode, its SDKs and the iOS simulator runtimes", async () => {
    const snap = await probeCapabilities(macHost().deps);
    expect(apple(snap.checks)).toEqual({
      "platform:macos": "ok 15.5 (24F74)",
      xcode: "ok 16.4 (16F6)",
      "sdk:macos": "ok 15.5",
      "sdk:ios": "ok 18.5",
      "ios-simulator": "ok 18.5, 26.0",
    });
    expect(byId(snap.checks)["platform:linux"]).toBe("other_platform");
  });

  test("keeps paths and device names out of the snapshot", async () => {
    const text = JSON.stringify(await probeCapabilities(macHost().deps));
    expect(text).not.toContain("/Applications");
    expect(text).not.toContain("iPhone");
  });

  test("without a developer directory Xcode is not installed and no Xcode tool runs", async () => {
    const cases: [ExecResult, string][] = [
      [exit(2), "not_installed"],
      [missing, "not_installed"],
      [hung, "timeout"],
    ];
    for (const [result, reason] of cases) {
      const { deps, calls } = macHost({ "/usr/bin/xcode-select -p": result });
      const snap = await probeCapabilities(deps);
      expect(apple(snap.checks)).toEqual({
        "platform:macos": "ok 15.5 (24F74)",
        xcode: reason,
        "sdk:macos": reason,
        "sdk:ios": reason,
        "ios-simulator": reason,
      });
      expect(xcodeTools(calls)).toEqual([]);
    }
  });

  test("the Command Line Tools alone are not Xcode, though they build a Package.swift", async () => {
    const { deps, calls } = macHost({
      "/usr/bin/xcode-select -p": ok("/Library/Developer/CommandLineTools\n"),
    });
    expect(apple((await probeCapabilities(deps)).checks)).toMatchObject({
      "platform:macos": "ok 15.5 (24F74)",
      xcode: "command_line_tools_only",
      "sdk:macos": "command_line_tools_only",
      "sdk:ios": "command_line_tools_only",
      "ios-simulator": "command_line_tools_only",
    });
    expect(xcodeTools(calls)).toEqual([]);
  });

  test("names an unaccepted license on Xcode and everything that needs it", async () => {
    const viaXcrun = macHost({ "/usr/bin/xcrun --find clang": refused(69, LICENSE_REFUSAL) });
    const snap = await probeCapabilities(viaXcrun.deps);
    expect(snap.checks.find((c) => c.id === "xcode")).toEqual({
      id: "xcode",
      ok: false,
      reason: "license_not_accepted",
      detail: "16.4 (16F6)",
    });
    expect(apple(snap.checks)).toMatchObject({
      "sdk:macos": "license_not_accepted",
      "sdk:ios": "license_not_accepted",
      "ios-simulator": "license_not_accepted",
    });
    expect(xcodeTools(viaXcrun.calls)).not.toContain("/usr/bin/xcodebuild -showsdks");

    const viaXcodebuild = macHost({
      "/usr/bin/xcodebuild -version": exit(
        69,
        "You have not agreed to the Xcode license agreements.",
      ),
    });
    expect(byId((await probeCapabilities(viaXcodebuild.deps)).checks).xcode).toBe(
      "license_not_accepted",
    );
  });

  test("a broken, silent or hung xcodebuild is a failed check, never Xcode", async () => {
    const cases: [ExecResult, string][] = [
      [hung, "timeout"],
      [refused(1, "xcodebuild: error: something else\n"), "probe_failed"],
      [ok("\n"), "probe_failed"],
    ];
    for (const [result, reason] of cases) {
      const snap = await probeCapabilities(
        macHost({ "/usr/bin/xcodebuild -version": result }).deps,
      );
      expect(byId(snap.checks)).toMatchObject({ xcode: reason, "sdk:macos": reason });
    }
  });

  test("an Xcode without the iOS platform has the macOS SDK only", async () => {
    const snap = await probeCapabilities(
      macHost({
        "/usr/bin/xcodebuild -showsdks": ok("macOS SDKs:\n\tmacOS 15.5 \t-sdk macosx15.5\n"),
      }).deps,
    );
    expect(apple(snap.checks)).toMatchObject({
      xcode: "ok 16.4 (16F6)",
      "sdk:macos": "ok 15.5",
      "sdk:ios": "sdk_not_found",
      "ios-simulator": "sdk_not_found",
    });
  });

  test("SDKs that cannot be listed fail the SDKs and the simulator, not Xcode", async () => {
    for (const result of [exit(1), ok("no sdks here\n")]) {
      const snap = await probeCapabilities(
        macHost({ "/usr/bin/xcodebuild -showsdks": result }).deps,
      );
      expect(apple(snap.checks)).toMatchObject({
        xcode: "ok 16.4 (16F6)",
        "sdk:macos": "probe_failed",
        "sdk:ios": "probe_failed",
        "ios-simulator": "probe_failed",
      });
    }
  });

  test("the iOS simulator needs an available iOS device; simctl failures are its own", async () => {
    const SIMCTL = "/usr/bin/xcrun simctl list -j devices available";
    const cases: [ExecResult, string][] = [
      [
        simctl({
          [`${IOS_RUNTIME}18-5`]: [{ name: "iPhone 16", isAvailable: false }],
          [`${IOS_RUNTIME}26-0`]: [],
          "com.apple.CoreSimulator.SimRuntime.watchOS-11-5": [{ name: "Apple Watch" }],
        }),
        "no_simulator",
      ],
      [exit(1), "probe_failed"],
      [ok("not json"), "probe_failed"],
      [hung, "timeout"],
      [refused(69, LICENSE_REFUSAL), "license_not_accepted"],
    ];
    for (const [result, reason] of cases) {
      const snap = await probeCapabilities(macHost({ [SIMCTL]: result }).deps);
      expect(apple(snap.checks)).toMatchObject({
        "sdk:ios": "ok 18.5",
        "ios-simulator": reason,
      });
    }
  });

  test("a failed sw_vers leaves the platform without a version", async () => {
    const snap = await probeCapabilities(macHost({ "/usr/bin/sw_vers": missing }).deps);
    expect(snap.checks.find((c) => c.id === "platform:macos")).toEqual({
      id: "platform:macos",
      ok: true,
      reason: null,
    });
  });
});

describe("CapabilityService", () => {
  let service: CapabilityService | null = null;
  afterEach(() => service?.stop());

  test("has no report before the first probe, then one with its age", async () => {
    let now = 10_000;
    service = new CapabilityService({ ...linuxHost().deps, now: () => now });
    expect(service.report()).toBeNull();
    await service.refresh();
    now = 70_000;
    expect(service.report()).toMatchObject({ probedAt: 10_000, ageMs: 60_000, stale: false });
  });

  test("joins a probe already in flight", async () => {
    const { deps, calls } = linuxHost();
    service = new CapabilityService(deps);
    await Promise.all([service.refresh(), service.refresh()]);
    expect(calls.filter((c) => c.key === "claude --version")).toHaveLength(1);
  });

  test("verify probes afresh and names what is missing", async () => {
    const { deps, calls } = linuxHost();
    service = new CapabilityService(deps);
    await service.refresh();
    const before = calls.length;
    expect(await service.verify(["agent:claude", "agent:codex", "xcode"])).toEqual([
      { capability: "agent:codex", reason: "not_logged_in" },
      { capability: "xcode", reason: "other_platform" },
    ]);
    expect(calls.length).toBeGreaterThan(before);
    expect(await service.verify(["platform:linux", "android-sdk"])).toEqual([]);
  });

  test("verify names a missing Xcode license for every Xcode requirement", async () => {
    service = new CapabilityService(
      macHost({ "/usr/bin/xcrun --find clang": refused(69, LICENSE_REFUSAL) }).deps,
    );
    expect(await service.verify(["platform:macos", "sdk:ios", "xcode"])).toEqual([
      { capability: "sdk:ios", reason: "license_not_accepted" },
      { capability: "xcode", reason: "license_not_accepted" },
    ]);
  });

  test("a probe that fails outright refuses every requirement instead of using old data", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { deps } = linuxHost();
      let explode = false;
      service = new CapabilityService({
        ...deps,
        exec: async (cmd, args, opts) => {
          if (explode) throw new Error("spawn exploded");
          return deps.exec(cmd, args, opts);
        },
      });
      await service.refresh();
      explode = true;
      expect(await service.verify(["platform:linux"])).toEqual([
        { capability: "platform:linux", reason: "probe_failed" },
      ]);
      // The old snapshot is still shown (and ages), but it admitted nothing.
      expect(service.report()?.checks.find((c) => c.id === "platform:linux")?.ok).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test("start probes right away and keeps one timer; stop clears it", async () => {
    const { deps, calls } = linuxHost();
    const setInt = spyOn(globalThis, "setInterval");
    try {
      service = new CapabilityService(deps);
      service.start();
      service.start();
      await service.refresh();
      expect(calls.some((c) => c.key === "claude --version")).toBe(true);
      expect(setInt.mock.calls.filter(([, ms]) => ms === 5 * 60_000)).toHaveLength(1);
    } finally {
      setInt.mockRestore();
    }
  });
});
