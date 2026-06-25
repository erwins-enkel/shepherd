import { describe, expect, it, spyOn, beforeEach, afterEach } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import {
  PREREQS,
  provision,
  selectPrereqCommand,
  needsInstall,
  decideServicePath,
  guidanceNextSteps,
  templateUnit,
  installPrereqs,
  ensureNodeGyp,
  installService,
  buildOnly,
  lowMemoryWarning,
  INSTALL_RAM_FLOOR_BYTES,
  type FileIO,
  type Runner,
} from "../deploy/provision";
import { BUN_MIN_VERSION, NODE_MIN_VERSION, HERDR_MIN_VERSION } from "../src/config";

describe("needsInstall (version-guard predicate)", () => {
  it("flags a missing tool (null version) for install", () => {
    expect(needsInstall(null, BUN_MIN_VERSION)).toBe(true);
  });

  it("flags a below-floor tool for install", () => {
    expect(needsInstall("0.5.0", HERDR_MIN_VERSION)).toBe(true);
    expect(needsInstall("19.9.0", NODE_MIN_VERSION)).toBe(true);
  });

  it("skips a tool at the floor", () => {
    expect(needsInstall(NODE_MIN_VERSION, NODE_MIN_VERSION)).toBe(false);
  });

  it("skips a tool above the floor", () => {
    expect(needsInstall("24.0.0", NODE_MIN_VERSION)).toBe(false);
    expect(needsInstall("1.3.0", BUN_MIN_VERSION)).toBe(false);
  });

  it("presence-only (no floor) installs only when absent", () => {
    expect(needsInstall(null, undefined)).toBe(true);
    expect(needsInstall("anything", undefined)).toBe(false);
  });
});

describe("selectPrereqCommand", () => {
  it("returns the autoFix command for an inadequate (missing) tool", () => {
    const bun = PREREQS.find((p) => p.bin === "bun")!;
    const cmd = selectPrereqCommand(bun, { version: null });
    expect(cmd).toContain("bun.sh/install");
  });

  it("returns nothing for an adequate tool (above floor)", () => {
    const bun = PREREQS.find((p) => p.bin === "bun")!;
    expect(selectPrereqCommand(bun, { version: "1.3.0" })).toBeUndefined();
  });

  it("returns nothing for an adequate presence-only tool (claude present)", () => {
    const claude = PREREQS.find((p) => p.bin === "claude")!;
    expect(selectPrereqCommand(claude, { version: "1.0.0" })).toBeUndefined();
  });

  it("selects an install for a below-floor herdr", () => {
    const herdr = PREREQS.find((p) => p.bin === "herdr")!;
    const cmd = selectPrereqCommand(herdr, { version: "0.1.0" });
    expect(cmd).toContain("herdr.dev/install.sh");
  });

  it("never selects tailscale (guidance-only) — it is not a prereq", () => {
    expect(PREREQS.some((p) => p.bin === "tailscale")).toBe(false);
  });
});

describe("decideServicePath", () => {
  it("linux + SHEPHERD_NO_SERVICE unset ⇒ service path", () => {
    const d = decideServicePath("linux", undefined);
    expect(d.service).toBe(true);
    expect(d.degradedBanner).toBe(false);
  });

  it("linux + SHEPHERD_NO_SERVICE='' ⇒ service path", () => {
    expect(decideServicePath("linux", "").service).toBe(true);
  });

  it("linux + SHEPHERD_NO_SERVICE set ⇒ no-service path", () => {
    const d = decideServicePath("linux", "1");
    expect(d.service).toBe(false);
    expect(d.degradedBanner).toBe(false);
  });

  it("darwin ⇒ no-service path + degraded banner", () => {
    const d = decideServicePath("darwin", undefined);
    expect(d.service).toBe(false);
    expect(d.degradedBanner).toBe(true);
  });

  it("darwin ignores SHEPHERD_NO_SERVICE (still no-service + banner)", () => {
    const d = decideServicePath("darwin", "1");
    expect(d.service).toBe(false);
    expect(d.degradedBanner).toBe(true);
  });
});

describe("templateUnit", () => {
  const unit = readFileSync("deploy/shepherd.service", "utf8");

  it("default repo (~/Work/shepherd) keeps output identical to the source unit", () => {
    // The shipped unit hardcodes %h/Work/shepherd; templating the literal value back
    // in is a no-op — proving the default install is byte-identical to today.
    const home = homedir();
    const defaultRepo = join(home, "Work", "shepherd");
    const templated = templateUnit(unit, defaultRepo);
    expect(templated).toContain(`WorkingDirectory=${defaultRepo}`);
    // only the WorkingDirectory line changed (from %h-form to absolute)
    expect(
      templated.replace(`WorkingDirectory=${defaultRepo}`, "WorkingDirectory=%h/Work/shepherd"),
    ).toBe(unit);
  });

  it("custom repo retargets WorkingDirectory and leaves ExecStart/Environment alone", () => {
    const templated = templateUnit(unit, "/srv/shepherd-prod");
    expect(templated).toContain("WorkingDirectory=/srv/shepherd-prod");
    expect(templated).not.toContain("WorkingDirectory=%h/Work/shepherd");
    expect(templated).toContain("ExecStart=%h/.bun/bin/bun run src/index.ts");
    expect(templated).toContain("EnvironmentFile=-%h/.shepherd/env");
  });

  it("replaces exactly one WorkingDirectory line", () => {
    const templated = templateUnit(unit, "/x");
    expect(templated.match(/^WorkingDirectory=/gm)?.length).toBe(1);
  });
});

function recorder() {
  const calls: string[][] = [];
  const opts: ({ env?: NodeJS.ProcessEnv } | undefined)[] = [];
  const run: Runner = (cmd, args, o) => {
    calls.push([cmd, ...args]);
    opts.push(o);
  };
  // Fake fileIO: reads serve the real unit template from the repo (so templating is
  // exercised against the true file), writes are recorded in-memory.
  const writes = new Map<string, string>();
  const fileIO: FileIO = {
    read: (path) => readFileSync(path.replace(/^.*\/deploy\//, "deploy/"), "utf8"),
    write: (path, content) => {
      writes.set(path, content);
    },
  };
  return { calls, opts, run, writes, fileIO };
}

// All prereqs adequate → no prereq install runs; only node-gyp + the branch work.
const adequateProbe = () => "999.0.0";

describe("provision orchestration (injected runner, no real installs)", () => {
  it("skips adequate prereqs and never installs tailscale", () => {
    const { calls, run } = recorder();
    provision({
      run,
      probe: adequateProbe,
      platform: "linux",
      env: { SHEPHERD_NO_SERVICE: "1" },
      repo: "/repo",
    });
    const flat = calls.map((c) => c.join(" "));
    expect(flat.some((c) => c.includes("bun.sh/install"))).toBe(false);
    expect(flat.some((c) => c.includes("herdr.dev/install"))).toBe(false);
    expect(flat.some((c) => c.includes("tailscale.com/install"))).toBe(false);
  });

  it("installs a missing/below-floor prereq via its verbatim command", () => {
    const { calls, run } = recorder();
    // herdr below floor, rest adequate
    const probe = (bin: string) => (bin === "herdr" ? "0.1.0" : "999.0.0");
    provision({ run, probe, platform: "linux", env: { SHEPHERD_NO_SERVICE: "1" }, repo: "/repo" });
    const flat = calls.map((c) => c.join(" "));
    expect(flat.some((c) => c.includes("herdr.dev/install"))).toBe(true);
  });

  it("always lays the node-gyp safety net", () => {
    const { calls, run } = recorder();
    provision({
      run,
      probe: adequateProbe,
      platform: "linux",
      env: { SHEPHERD_NO_SERVICE: "1" },
      repo: "/repo",
    });
    const flat = calls.map((c) => c.join(" "));
    expect(flat.some((c) => c.includes("bun add -g node-gyp"))).toBe(true);
  });

  it("service path installs+enables the unit and delegates build to update.sh", () => {
    const { calls, run, writes, fileIO } = recorder();
    provision({
      run,
      fileIO,
      probe: adequateProbe,
      platform: "linux",
      env: { USER: "me" },
      repo: "/repo",
    });
    const flat = calls.map((c) => c.join(" "));
    // The unit is now templated+written via fileIO (not a runner `cp`).
    const unitTargets = [...writes.keys()].filter((p) =>
      p.endsWith("systemd/user/shepherd.service"),
    );
    expect(unitTargets.length).toBe(1);
    expect(flat.some((c) => c.includes("daemon-reload"))).toBe(true);
    expect(flat.some((c) => c.includes("enable-linger"))).toBe(true);
    expect(flat.some((c) => c === "systemctl --user enable shepherd")).toBe(true);
    expect(flat.some((c) => c.includes("deploy/update.sh"))).toBe(true);
    // service path must NOT duplicate update.sh's deps/build
    expect(flat.some((c) => c.includes("ui && bun run build"))).toBe(false);
    // no verbatim `cp` of the unit anymore
    expect(flat.some((c) => c.startsWith("cp ") && c.includes("shepherd.service"))).toBe(false);
  });

  it("templates the installed unit's WorkingDirectory to the repo path (not a copy)", () => {
    const { writes, run, fileIO } = recorder();
    const repo = "/home/op/custom-shepherd-dir";
    provision({ run, fileIO, probe: adequateProbe, platform: "linux", env: { USER: "me" }, repo });
    const [target, content] = [...writes.entries()].find(([p]) =>
      p.endsWith("systemd/user/shepherd.service"),
    )!;
    expect(target).toContain("systemd/user/shepherd.service");
    // WorkingDirectory points at the custom checkout — proves templating, not passthrough
    expect(content).toContain(`WorkingDirectory=${repo}`);
    expect(content).not.toContain("WorkingDirectory=%h/Work/shepherd");
    // everything else is untouched (ExecStart still relative + %h-based)
    expect(content).toContain("ExecStart=%h/.bun/bin/bun run src/index.ts");
  });

  it("no-service path builds directly and never touches systemd", () => {
    const { calls, run } = recorder();
    provision({
      run,
      probe: adequateProbe,
      platform: "linux",
      env: { SHEPHERD_NO_SERVICE: "1" },
      repo: "/repo",
    });
    const flat = calls.map((c) => c.join(" "));
    expect(flat.some((c) => c.includes("systemctl"))).toBe(false);
    expect(flat.some((c) => c.includes("update.sh"))).toBe(false);
    expect(flat.some((c) => c.includes("/ui") && c.includes("bun run build"))).toBe(true);
    // honors the injected repo root (not process cwd)
    expect(flat.some((c) => c.includes('cd "/repo" && bun install'))).toBe(true);
    expect(flat.some((c) => c.includes('cd "/repo/ui" && bun run build'))).toBe(true);
  });

  it("runs the build steps with ~/.bun/bin on PATH (node-gyp/node-pty rebuild)", () => {
    const { calls, opts, run } = recorder();
    provision({
      run,
      probe: adequateProbe,
      platform: "linux",
      env: { SHEPHERD_NO_SERVICE: "1", PATH: "/usr/bin" },
      repo: "/repo",
    });
    // find the bun install / build steps and assert their env PATH carries .bun/bin
    const buildIdxs = calls
      .map((c, i) => ({ c: c.join(" "), i }))
      .filter(({ c }) => c.includes("bun install") || c.includes("bun run build"))
      .map(({ i }) => i);
    expect(buildIdxs.length).toBeGreaterThan(0);
    for (const i of buildIdxs) {
      const path = opts[i]?.env?.PATH ?? "";
      expect(path).toContain(`${join(homedir(), ".bun", "bin")}`);
    }
  });

  it("darwin takes no-service path (no systemd)", () => {
    const { calls, run } = recorder();
    provision({ run, probe: adequateProbe, platform: "darwin", env: {}, repo: "/repo" });
    const flat = calls.map((c) => c.join(" "));
    expect(flat.some((c) => c.includes("systemctl"))).toBe(false);
    expect(flat.some((c) => c.includes("/ui") && c.includes("bun run build"))).toBe(true);
  });
});

describe("extracted helpers (direct)", () => {
  it("installPrereqs skips adequate tools and installs inadequate ones", () => {
    const { calls, run } = recorder();
    const probe = (bin: string) => (bin === "herdr" ? "0.1.0" : "999.0.0");
    installPrereqs(probe, run, { FOO: "bar" });
    const flat = calls.map((c) => c.join(" "));
    expect(flat.some((c) => c.includes("herdr.dev/install"))).toBe(true);
    expect(flat.some((c) => c.includes("bun.sh/install"))).toBe(false);
  });

  it("ensureNodeGyp installs node-gyp and returns build env with ~/.bun/bin on PATH", () => {
    const { calls, run } = recorder();
    const buildEnv = ensureNodeGyp(run, { PATH: "/usr/bin" }, "/home/op");
    const flat = calls.map((c) => c.join(" "));
    expect(flat.some((c) => c.includes("bun add -g node-gyp"))).toBe(true);
    expect(buildEnv.PATH).toContain("/home/op/.bun/bin");
    expect(buildEnv.PATH).toContain("/home/op/.local/bin");
    expect(buildEnv.PATH).toContain("/usr/bin");
  });

  it("installService templates+writes the unit, enables, delegates build, throws without $USER", () => {
    const { calls, writes, run, fileIO } = recorder();
    installService("/repo", run, fileIO, { USER: "me" }, "/home/op", { PATH: "/x" });
    const flat = calls.map((c) => c.join(" "));
    expect([...writes.keys()].some((p) => p.endsWith("systemd/user/shepherd.service"))).toBe(true);
    expect(flat.some((c) => c.includes("daemon-reload"))).toBe(true);
    expect(flat.some((c) => c.includes("enable-linger"))).toBe(true);
    expect(flat.some((c) => c.includes("deploy/update.sh"))).toBe(true);
    // Backup units (#1080): both written, the .service templated to the checkout, the timer
    // enabled --now, and the backup-expected marker written.
    const backupSvcWrite = [...writes.entries()].find(([p]) =>
      p.endsWith("systemd/user/shepherd-backup.service"),
    );
    expect(backupSvcWrite).toBeDefined();
    expect(backupSvcWrite![1]).toContain("WorkingDirectory=/repo");
    expect([...writes.keys()].some((p) => p.endsWith("systemd/user/shepherd-backup.timer"))).toBe(
      true,
    );
    expect([...writes.keys()].some((p) => p.endsWith(".backup-configured"))).toBe(true);
    expect(flat.some((c) => c.includes("enable --now shepherd-backup.timer"))).toBe(true);
    // kicks one immediate backup so a fresh box has a .last-success before the staleness probe
    expect(flat.some((c) => c.includes("start shepherd-backup.service"))).toBe(true);
    // ~/.shepherd is created before the unit starts (systemd opens StandardOutput=append:
    // there before ExecStart and won't make parent dirs — else first start fails, #725).
    const shepherdDir = join("/home/op", ".shepherd");
    const shepherdMkdirIdx = calls.findIndex((c) => c[0] === "mkdir" && c.includes(shepherdDir));
    expect(shepherdMkdirIdx).toBeGreaterThanOrEqual(0);
    // it must precede the build/start delegation to update.sh
    const updateIdx = calls.findIndex((c) => c.join(" ").includes("deploy/update.sh"));
    expect(shepherdMkdirIdx).toBeLessThan(updateIdx);

    const fresh = recorder();
    expect(() =>
      installService("/repo", fresh.run, fresh.fileIO, {}, "/home/op", { PATH: "/x" }),
    ).toThrow(/\$USER/);
  });

  it("buildOnly installs deps + builds UI with the build env, no systemd", () => {
    const { calls, run } = recorder();
    buildOnly("/repo", run, { PATH: "/x" });
    const flat = calls.map((c) => c.join(" "));
    expect(flat.some((c) => c.includes('cd "/repo" && bun install'))).toBe(true);
    expect(flat.some((c) => c.includes('cd "/repo/ui" && bun run build'))).toBe(true);
    expect(flat.some((c) => c.includes("systemctl"))).toBe(false);
  });
});

describe("lowMemoryWarning (pure)", () => {
  it("returns null at exactly the floor", () => {
    expect(lowMemoryWarning(INSTALL_RAM_FLOOR_BYTES)).toBeNull();
  });

  it("returns null above the floor", () => {
    expect(lowMemoryWarning(4 * 1024 ** 3)).toBeNull();
  });

  it("returns a non-null string below the floor that mentions the detected amount", () => {
    const result = lowMemoryWarning(2 * 1024 ** 3);
    expect(result).not.toBeNull();
    expect(result).toContain("2.0 GiB");
  });

  it("custom floor: above custom floor → null", () => {
    expect(lowMemoryWarning(2 * 1024 ** 3, 1 * 1024 ** 3)).toBeNull();
  });
});

describe("provision — low-memory advisory wiring", () => {
  let written: string[];
  let restore: () => void;

  beforeEach(() => {
    written = [];
    const spy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    restore = () => spy.mockRestore();
  });

  afterEach(() => restore());

  it("emits the advisory when totalMem is below the floor", () => {
    const { run, fileIO } = recorder();
    provision({
      run,
      fileIO,
      probe: adequateProbe,
      platform: "linux",
      env: { SHEPHERD_NO_SERVICE: "1" },
      repo: "/repo",
      totalMem: () => 2 * 1024 ** 3,
    });
    const all = written.join("");
    expect(all).toContain("low memory");
    expect(all).toContain("2.0 GiB");
  });

  it("does NOT emit the advisory when totalMem is above the floor", () => {
    const { run, fileIO } = recorder();
    provision({
      run,
      fileIO,
      probe: adequateProbe,
      platform: "linux",
      env: { SHEPHERD_NO_SERVICE: "1" },
      repo: "/repo",
      totalMem: () => 8 * 1024 ** 3,
    });
    const all = written.join("");
    expect(all).not.toContain("low memory");
  });
});

describe("guidanceNextSteps", () => {
  it("includes the local URL and the human-secret follow-ups", () => {
    const steps = guidanceNextSteps().join("\n");
    expect(steps).toContain("http://localhost:7330");
    expect(steps.toLowerCase()).toContain("claude");
    expect(steps).toContain("gh auth login");
    expect(steps).toContain("tailscale serve");
    expect(steps).toContain("SHEPHERD_ALLOWED_HOSTS");
  });
});
