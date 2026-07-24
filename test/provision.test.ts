import { describe, expect, it, spyOn, beforeEach, afterEach } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { HERDR_LAST_SUPPORTED_VERSION } from "../src/herdr-capabilities";
import {
  PREREQS,
  provision,
  selectPrereqCommand,
  needsInstall,
  decideServicePath,
  guidanceNextSteps,
  macosDegradedBanner,
  noServiceStartHint,
  templateUnit,
  installPrereqs,
  ensureNodeGyp,
  installService,
  buildOnly,
  templateHerdrUnit,
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
    expect(cmd).toContain(`/releases/download/v${HERDR_LAST_SUPPORTED_VERSION}/herdr-`);
    expect(cmd).not.toContain("herdr.dev/install.sh");
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

  it("default repo (~/.shepherd/app) keeps output identical to the source unit", () => {
    // The shipped unit hardcodes %h/.shepherd/app; templating the literal value back
    // in is a no-op — proving the default install is byte-identical.
    const home = homedir();
    const defaultRepo = join(home, ".shepherd", "app");
    const templated = templateUnit(unit, defaultRepo);
    expect(templated).toContain(`WorkingDirectory=${defaultRepo}`);
    // only the WorkingDirectory line changed (from %h-form to absolute)
    expect(
      templated.replace(`WorkingDirectory=${defaultRepo}`, "WorkingDirectory=%h/.shepherd/app"),
    ).toBe(unit);
  });

  it("custom repo retargets WorkingDirectory and leaves ExecStart/Environment alone", () => {
    const templated = templateUnit(unit, "/srv/shepherd-prod");
    expect(templated).toContain("WorkingDirectory=/srv/shepherd-prod");
    expect(templated).not.toContain("WorkingDirectory=%h/.shepherd/app");
    expect(templated).toContain("ExecStart=%h/.bun/bin/bun run src/index.ts");
    expect(templated).toContain("EnvironmentFile=-%h/.shepherd/env");
  });

  it("replaces exactly one WorkingDirectory line", () => {
    const templated = templateUnit(unit, "/x");
    expect(templated.match(/^WorkingDirectory=/gm)?.length).toBe(1);
  });
});

describe("rotate-shepherd-log.sh (self-contained rotator — no external logrotate dep)", () => {
  const script = readFileSync("deploy/rotate-shepherd-log.sh", "utf8");

  it("keeps the copytruncate + size policy that logrotate used to provide", () => {
    // copytruncate semantics: copy aside, truncate the live file in place (`: >`), compress the copy.
    expect(script).toContain('cp "$LOG" "$LOG.1"');
    expect(script).toContain(': >"$LOG"');
    expect(script).toContain('gzip -f "$LOG.1"');
    // 50 MiB cap and 7 kept rotations, matching the former logrotate config.
    expect(script).toContain("52428800");
    expect(script).toContain("SHEPHERD_LOG_KEEP:-7");
  });

  it("invokes no external logrotate binary", () => {
    expect(script).not.toMatch(/\blogrotate\b\s+--/);
  });

  it("the unit execs the rotator from ~/.shepherd via /bin/sh", () => {
    const unit = readFileSync("deploy/shepherd-logrotate.service", "utf8");
    expect(unit).toContain("ExecStart=/bin/sh %h/.shepherd/rotate-shepherd-log.sh");
    expect(unit).not.toContain("ExecStart=logrotate");
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
      probePath: () => "/root/.local/bin/herdr",
      run,
      probe: adequateProbe,
      platform: "linux",
      env: { SHEPHERD_NO_SERVICE: "1" },
      repo: "/repo",
    });
    const flat = calls.map((c) => c.join(" "));
    expect(flat.some((c) => c.includes("bun.sh/install"))).toBe(false);
    expect(flat.some((c) => c.includes("/releases/download/v"))).toBe(false);
    expect(flat.some((c) => c.includes("tailscale.com/install"))).toBe(false);
  });

  it("installs a missing/below-floor prereq via its verbatim command", () => {
    const { calls, run } = recorder();
    // herdr below floor, rest adequate
    const probe = (bin: string) => (bin === "herdr" ? "0.1.0" : "999.0.0");
    provision({ run, probe, platform: "linux", env: { SHEPHERD_NO_SERVICE: "1" }, repo: "/repo" });
    const flat = calls.map((c) => c.join(" "));
    expect(flat.some((c) => c.includes("/releases/download/v"))).toBe(true);
  });

  it("always lays the node-gyp safety net", () => {
    const { calls, run } = recorder();
    provision({
      probePath: () => "/root/.local/bin/herdr",
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
      probePath: () => "/root/.local/bin/herdr",
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
    provision({
      probePath: () => "/root/.local/bin/herdr",
      run,
      fileIO,
      probe: adequateProbe,
      platform: "linux",
      env: { USER: "me" },
      repo,
    });
    const [target, content] = [...writes.entries()].find(([p]) =>
      p.endsWith("systemd/user/shepherd.service"),
    )!;
    expect(target).toContain("systemd/user/shepherd.service");
    // WorkingDirectory points at the custom checkout — proves templating, not passthrough
    expect(content).toContain(`WorkingDirectory=${repo}`);
    expect(content).not.toContain("WorkingDirectory=%h/.shepherd/app");
    // everything else is untouched (ExecStart still relative + %h-based)
    expect(content).toContain("ExecStart=%h/.bun/bin/bun run src/index.ts");
  });

  it("no-service path builds directly and never touches systemd", () => {
    const { calls, run } = recorder();
    provision({
      probePath: () => "/root/.local/bin/herdr",
      run,
      probe: adequateProbe,
      platform: "linux",
      env: { SHEPHERD_NO_SERVICE: "1" },
      repo: "/repo",
    });
    const flat = calls.map((c) => c.join(" "));
    // No systemctl COMMAND issued. (HERDR_SERVE is a bash string that may *mention* systemctl —
    // it prefers an existing unit over racing it — which is not provision touching systemd.)
    expect(calls.some((c) => c[0] === "systemctl")).toBe(false);
    expect(flat.some((c) => c.includes("update.sh"))).toBe(false);
    expect(flat.some((c) => c.includes("/ui") && c.includes("bun run build"))).toBe(true);
    // honors the injected repo root (not process cwd)
    expect(flat.some((c) => c.includes('cd "/repo" && bun install'))).toBe(true);
    expect(flat.some((c) => c.includes('cd "/repo/ui" && bun run build'))).toBe(true);
  });

  it("runs the build steps with ~/.bun/bin on PATH (node-gyp/node-pty rebuild)", () => {
    const { calls, opts, run } = recorder();
    provision({
      probePath: () => "/root/.local/bin/herdr",
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
    // No systemctl COMMAND issued. (HERDR_SERVE is a bash string that may *mention* systemctl —
    // it prefers the unit when one exists — which is not provision touching systemd itself.)
    expect(calls.some((c) => c[0] === "systemctl")).toBe(false);
    const flat = calls.map((c) => c.join(" "));
    expect(flat.some((c) => c.includes("/ui") && c.includes("bun run build"))).toBe(true);
  });
});

describe("extracted helpers (direct)", () => {
  it("installPrereqs skips adequate tools and installs inadequate ones", () => {
    const { calls, run } = recorder();
    const probe = (bin: string) => (bin === "herdr" ? "0.1.0" : "999.0.0");
    installPrereqs(probe, run, { FOO: "bar" });
    const flat = calls.map((c) => c.join(" "));
    expect(flat.some((c) => c.includes("/releases/download/v"))).toBe(true);
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
    installService(
      "/repo",
      run,
      fileIO,
      { USER: "me" },
      "/home/op",
      { PATH: "/x" },
      () => "/root/.local/bin/herdr",
    );
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
    // NO immediate `start shepherd-backup.service` here: the DB doesn't exist yet on a fresh
    // install, so it would fail the oneshot and abort provision (update.sh does the guarded kick).
    expect(flat.some((c) => c.includes("start shepherd-backup.service"))).toBe(false);
    // ~/.shepherd is created before the unit starts (systemd opens StandardOutput=append:
    // there before ExecStart and won't make parent dirs — else first start fails, #725).
    const shepherdDir = join("/home/op", ".shepherd");
    const shepherdMkdirIdx = calls.findIndex((c) => c[0] === "mkdir" && c.includes(shepherdDir));
    expect(shepherdMkdirIdx).toBeGreaterThanOrEqual(0);
    // it must precede the build/start delegation to update.sh
    const updateIdx = calls.findIndex((c) => c.join(" ").includes("deploy/update.sh"));
    expect(shepherdMkdirIdx).toBeLessThan(updateIdx);

    // Log-rotation (#1212): the self-contained rotator is copied to ~/.shepherd (the unit execs it
    // there), both units are written, and the hourly timer enabled --now — UNCONDITIONALLY (no
    // external logrotate binary to gate on anymore, so the log can't stay unbounded).
    const rotatorWrite = [...writes.entries()].find(([p]) =>
      p.endsWith(".shepherd/rotate-shepherd-log.sh"),
    );
    expect(rotatorWrite).toBeDefined();
    expect(rotatorWrite![0]).toBe(join("/home/op", ".shepherd", "rotate-shepherd-log.sh"));
    expect(rotatorWrite![1]).toContain("copytruncate");
    expect(
      [...writes.keys()].some((p) => p.endsWith("systemd/user/shepherd-logrotate.service")),
    ).toBe(true);
    expect(
      [...writes.keys()].some((p) => p.endsWith("systemd/user/shepherd-logrotate.timer")),
    ).toBe(true);
    expect(flat.some((c) => c.includes("enable --now shepherd-logrotate.timer"))).toBe(true);

    const fresh = recorder();
    expect(() =>
      installService(
        "/repo",
        fresh.run,
        fresh.fileIO,
        {},
        "/home/op",
        { PATH: "/x" },
        () => "/root/.local/bin/herdr",
      ),
    ).toThrow(/\$USER/);
  });

  it("installs + enables the herdr unit BEFORE shepherd starts (#1574)", () => {
    const { calls, writes, run, fileIO } = recorder();
    installService(
      "/repo",
      run,
      fileIO,
      { USER: "me" },
      "/home/op",
      { PATH: "/x" },
      () => "/root/.local/bin/herdr",
    );

    expect([...writes.keys()].some((p) => p.endsWith("systemd/user/herdr.service"))).toBe(true);

    const flat = calls.map((c) => c.join(" "));
    const enableHerdr = flat.findIndex((c) => c.includes("enable --now herdr"));
    const startShepherd = flat.findIndex((c) => c.includes("deploy/update.sh"));
    expect(enableHerdr).toBeGreaterThanOrEqual(0);
    // Ordering is the point: update.sh starts Shepherd, which needs a live daemon.
    expect(enableHerdr).toBeLessThan(startShepherd);
  });

  it("buildOnly installs deps + builds UI with the build env, no systemd", () => {
    const { calls, run } = recorder();
    buildOnly("/repo", run, { PATH: "/x" });
    const flat = calls.map((c) => c.join(" "));
    expect(flat.some((c) => c.includes('cd "/repo" && bun install'))).toBe(true);
    expect(flat.some((c) => c.includes('cd "/repo/ui" && bun run build'))).toBe(true);
    // buildOnly issues no systemctl COMMAND of its own (HERDR_SERVE's string may name it).
    expect(calls.some((c) => c[0] === "systemctl")).toBe(false);
  });

  it("buildOnly retries a transient `bun install` flake, then succeeds (#1602)", () => {
    const calls: string[][] = [];
    let rootInstall = 0;
    const run: Runner = (cmd, args) => {
      calls.push([cmd, ...args]);
      if ([cmd, ...args].join(" ").includes('cd "/repo" && bun install')) {
        // First attempt flakes (node-pty tarball extract), retry succeeds.
        if (++rootInstall === 1) throw new Error('Fail extracting tarball for "node-pty"');
      }
    };
    expect(() =>
      buildOnly("/repo", run, { PATH: "/x" }, { attempts: 2, delayMs: 0 }),
    ).not.toThrow();
    expect(rootInstall).toBe(2); // failed once → retried → succeeded
    // The retry didn't swallow the downstream steps.
    const flat = calls.map((c) => c.join(" "));
    expect(flat.some((c) => c.includes('cd "/repo/ui" && bun run build'))).toBe(true);
  });

  it("buildOnly propagates a `bun install` failure that persists past the retry bound (#1602)", () => {
    let attempts = 0;
    const run: Runner = (cmd, args) => {
      if ([cmd, ...args].join(" ").includes('cd "/repo" && bun install')) {
        attempts++;
        throw new Error('Fail extracting tarball for "node-pty"');
      }
    };
    // Fail-closed: a persistent failure still gates (throws) after exactly `attempts` tries.
    expect(() => buildOnly("/repo", run, { PATH: "/x" }, { attempts: 2, delayMs: 0 })).toThrow(
      /node-pty/,
    );
    expect(attempts).toBe(2);
  });

  it("buildOnly does not retry a non-install step — a UI build failure gates immediately", () => {
    let buildAttempts = 0;
    const run: Runner = (cmd, args) => {
      if ([cmd, ...args].join(" ").includes("bun run build")) {
        buildAttempts++;
        throw new Error("build broke");
      }
    };
    expect(() => buildOnly("/repo", run, { PATH: "/x" }, { attempts: 2, delayMs: 0 })).toThrow(
      /build broke/,
    );
    expect(buildAttempts).toBe(1); // only the network install steps are retried
  });

  it("the herdr prereq installs the binary ONLY — no daemon start (#1574)", () => {
    // The shipped `herdr_missing` remediation is `HERDR_INSTALL && (HERDR_SERVE)`. Running that
    // here would leave an unsupervised daemon on the socket, so `enable --now herdr` would hit a
    // bound socket, exit 1, and Restart=always would thrash the unit into `failed` while the
    // orphan kept serving (check reads `ok`, breakage invisible). The UNIT must own the daemon.
    const herdr = PREREQS.find((p) => p.bin === "herdr")!;
    const cmd = selectPrereqCommand(herdr, { version: null })!;
    expect(cmd).toContain(`/releases/download/v${HERDR_LAST_SUPPORTED_VERSION}/herdr-`);
    expect(cmd).not.toContain("herdr.dev/install.sh");
    expect(cmd).not.toContain("server");
    expect(cmd).not.toContain("agent list");
  });

  it("templateHerdrUnit rewrites ExecStart to the resolved herdr path (#1574)", () => {
    const unit = readFileSync("deploy/herdr.service", "utf8");
    const out = templateHerdrUnit(unit, "/usr/local/bin/herdr");
    expect(out).toContain("ExecStart=/usr/local/bin/herdr server");
    expect(out).not.toContain("ExecStart=%h/.local/bin/herdr server");
    // Everything else survives, incl. the restart policy that makes Restart=always honest.
    expect(out).toContain("StartLimitIntervalSec=0");
    expect(out).toContain("Restart=always");
  });

  it("installService writes a TEMPLATED herdr unit and adopts the socket before enabling (#1574)", () => {
    const { calls, writes, run, fileIO } = recorder();
    installService(
      "/repo",
      run,
      fileIO,
      { USER: "me" },
      "/home/op",
      { PATH: "/x" },
      () => "/usr/local/bin/herdr",
    );

    const unit = [...writes.entries()].find(([p]) => p.endsWith("systemd/user/herdr.service"));
    expect(unit).toBeDefined();
    // Resolved path, not the %h default — herdr is not always in ~/.local/bin.
    expect(unit![1]).toContain("ExecStart=/usr/local/bin/herdr server");

    const flat = calls.map((c) => c.join(" "));
    const reloadIdx = flat.findIndex((c) => c.includes("daemon-reload"));
    const tryRestartIdx = flat.findIndex((c) => c.includes("try-restart herdr"));
    const adoptIdx = flat.findIndex((c) => c.includes('"$H" server stop'));
    const enableIdx = flat.findIndex((c) => c.includes("enable --now herdr"));
    expect(adoptIdx).toBeGreaterThanOrEqual(0);
    // try-restart AFTER the reload: `enable --now` won't restart an already-active unit, so a
    // re-provision whose ExecStart changed (herdr moved / HERDR_BIN changed) would otherwise
    // keep running the stale path forever.
    expect(reloadIdx).toBeLessThan(tryRestartIdx);
    // Adopt BEFORE enabling: a foreign daemon on the socket makes ExecStart exit 1 and thrash.
    expect(adoptIdx).toBeLessThan(enableIdx);
  });

  it("skips try-restart when the herdr unit is byte-identical (no needless daemon bounce)", () => {
    // try-restart kills the daemon backing every live agent session. Re-provisioning a host
    // whose unit did not change must not bounce it. (#1574)
    const { calls, writes, run, fileIO } = recorder();
    const herdrPath = "/usr/local/bin/herdr";
    const unitPath = join("/home/op", ".config", "systemd", "user", "herdr.service");
    const desired = templateHerdrUnit(readFileSync("deploy/herdr.service", "utf8"), herdrPath);
    // Installed unit already matches what we would write.
    const preloaded: FileIO = {
      read: (p) => (p === unitPath ? desired : fileIO.read(p)),
      write: fileIO.write,
    };

    installService(
      "/repo",
      run,
      preloaded,
      { USER: "me" },
      "/home/op",
      { PATH: "/x" },
      () => herdrPath,
    );

    const flat = calls.map((c) => c.join(" "));
    expect(flat.some((c) => c.includes("try-restart herdr"))).toBe(false);
    // ...and it is not rewritten either.
    expect([...writes.keys()]).not.toContain(unitPath);
  });

  it("HERDR_ADOPT_SOCKET exports the env file so `server stop` addresses the right socket", () => {
    // A bare `.` leaves HERDR_SESSION / HERDR_SOCKET_PATH unexported, so the `server stop` CHILD
    // targets the default socket, the real orphan survives, and enable --now thrashes forever.
    const { calls, run, fileIO } = recorder();
    installService(
      "/repo",
      run,
      fileIO,
      { USER: "me" },
      "/home/op",
      { PATH: "/x" },
      () => "/usr/local/bin/herdr",
    );
    const adopt = calls.map((c) => c.join(" ")).find((c) => c.includes('"$H" server stop'))!;
    expect(adopt).toContain("set -a;");
    expect(adopt).toContain("set +a;");
    expect(adopt.indexOf("set -a;")).toBeLessThan(adopt.indexOf(".shepherd/env"));
    expect(adopt.indexOf(".shepherd/env")).toBeLessThan(adopt.indexOf("set +a;"));
  });

  it("the herdr unit reads the same env file shepherd.service does (HERDR_BIN/HERDR_SESSION)", () => {
    // Without it, a HERDR_SESSION=<name> host supervises a daemon on the `default` session while
    // Shepherd's liveness probe targets the per-session socket: unit `active`, herdr `offline`.
    const unit = readFileSync("deploy/herdr.service", "utf8");
    expect(unit).toContain("EnvironmentFile=-%h/.shepherd/env");
    // Restart=always is only honest with the start-rate limit disabled.
    expect(unit).toContain("StartLimitIntervalSec=0");
  });

  it("installService refuses to install a unit pointing at a herdr that is not on PATH (#1574)", () => {
    const { run, fileIO } = recorder();
    expect(() =>
      installService("/repo", run, fileIO, { USER: "me" }, "/home/op", { PATH: "/x" }, () => null),
    ).toThrow(/herdr is not on PATH/);
  });

  it("starts a detached herdr daemon, no systemd on this path (#1574)", () => {
    const { calls, run } = recorder();
    buildOnly("/repo", run, { PATH: "/x" });

    const flat = calls.map((c) => c.join(" "));
    const serve = flat.find((c) => c.includes('"$H" server'));
    expect(serve).toBeDefined();
    expect(serve!.startsWith("bash -c")).toBe(true);
    // macOS takes this path and has no setsid.
    expect(serve!).toContain("nohup");
    // It must precede the slow build so a dead daemon fails fast.
    const serveIdx = flat.findIndex((c) => c.includes('"$H" server'));
    const installIdx = flat.findIndex((c) => c.includes("bun install"));
    expect(serveIdx).toBeLessThan(installIdx);
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
      probePath: () => "/root/.local/bin/herdr",
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
      probePath: () => "/root/.local/bin/herdr",
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
    const steps = guidanceNextSteps("/home/op/.shepherd/app").join("\n");
    expect(steps).toContain("http://localhost:7330");
    expect(steps.toLowerCase()).toContain("claude");
    expect(steps).toContain("gh auth login");
    expect(steps).toContain("tailscale serve");
    expect(steps).toContain("SHEPHERD_ALLOWED_HOSTS");
  });

  it("leads with the checkout dir so the operator knows where it landed", () => {
    const steps = guidanceNextSteps("/opt/custom/shepherd").join("\n");
    expect(steps).toContain("Installed to: /opt/custom/shepherd");
  });
});

describe("macosDegradedBanner", () => {
  it("makes the manual-start line copy-pasteable with the checkout dir", () => {
    const banner = macosDegradedBanner("/home/op/.shepherd/app").join("\n");
    expect(banner).toContain("DEGRADED");
    expect(banner).toContain('cd "/home/op/.shepherd/app" && bun run start');
  });

  // #1912: this banner is the authoritative degraded-capability list install.sh
  // defers to, so it must state what is now unavailable (preview STOP + tailnet
  // exposure) rather than the stale "tailscale-serve previews" (previews are now
  // detected on macOS). Pin the wording so it can't silently drift from the docs.
  it("lists the unavailable preview capabilities, not the stale 'previews' bullet", () => {
    const banner = macosDegradedBanner("/home/op/.shepherd/app").join("\n");
    expect(banner).toContain("stopping a preview from the UI");
    expect(banner).toContain("exposing previews over the tailnet");
    expect(banner).not.toContain("tailscale-serve previews");
  });
});

describe("noServiceStartHint", () => {
  it("gives the Linux no-service path a manual-start command with the dir", () => {
    const hint = noServiceStartHint("/opt/custom/shepherd").join("\n");
    expect(hint).toContain("SHEPHERD_NO_SERVICE");
    expect(hint).toContain('cd "/opt/custom/shepherd" && bun run start');
  });
});
