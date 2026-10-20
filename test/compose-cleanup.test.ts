import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComposeCleanup } from "../src/compose-cleanup";
import { composeDocker } from "./helpers/compose-docker";

describe("compose cleanup", () => {
  let base: string;
  let gone: string;
  let docker: ReturnType<typeof composeDocker>;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "compose-cleanup-"));
    mkdirSync(join(base, ".shepherd-worktrees"));
    gone = join(base, ".shepherd-worktrees", "repo-gone");
    docker = composeDocker();
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));
  const downs = () => docker.calls.filter(({ args }) => args.includes("down"));
  const cleanup = () => new ComposeCleanup({ run: docker.run, env: {} });

  test("counts projects, sweeps absent worktrees and preserves live and foreign stacks and volumes", async () => {
    docker.add("gone", gone);
    docker.add("gone", join(gone, "infra"));
    docker.add("second", join(gone, "other"));
    const live = join(base, ".shepherd-worktrees", "repo-live");
    mkdirSync(live);
    docker.add("live", join(live, "deleted-subdir"));
    docker.add("calendar-testserver", join(base, "services"));
    const service = cleanup();
    expect(await service.countOrphans()).toBe(2);
    expect(downs()).toHaveLength(0);
    expect(await service.sweepOrphans()).toBe(2);
    expect([...docker.containers.values()].map((l) => l["com.docker.compose.project"])).toEqual([
      "live",
      "calendar-testserver",
    ]);
    expect([...docker.volumes]).toEqual(["persistent-data"]);
    expect(await service.countOrphans()).toBe(0);
    expect(await service.sweepOrphans()).toBe(0);
    for (const { args, timeoutMs } of downs()) {
      expect(args).toEqual([
        "--host",
        "unix:///var/run/docker.sock",
        "compose",
        "-p",
        expect.any(String),
        "down",
        "--remove-orphans",
        "--timeout",
        "10",
      ]);
      expect(timeoutMs).toBe(60_000);
    }
    expect(
      docker.calls
        .filter(({ args }) => !args.includes("down"))
        .every(({ timeoutMs }) => timeoutMs === 5_000),
    ).toBe(true);
  });

  test("cleanupWorktree only tears down its exact worktree and its subdirectories", async () => {
    docker.add("target", gone);
    docker.add("nested", join(gone, "infra"));
    docker.add("neighbor", `${gone}-neighbor`);
    const service = cleanup();
    expect(await service.cleanupWorktree(gone)).toBe(2);
    expect([...docker.containers.values()][0]!["com.docker.compose.project"]).toBe("neighbor");
  });

  test.each([
    "relative/.shepherd-worktrees/repo",
    "/",
    "",
    "--help",
    "outside",
    ".shepherd-worktrees",
    ".shepherd-worktrees-old/repo",
    ".shepherd-worktrees/repo/../../service",
  ])("refuses unsafe working_dir %s", async (path) => {
    const dir = path.startsWith(".") || path === "outside" ? join(base, path) : path;
    docker.add("unsafe", dir);
    expect(await cleanup().sweepOrphans()).toBe(0);
    expect(await cleanup().cleanupWorktree(dir)).toBe(0);
    expect(downs()).toHaveLength(0);
  });

  test("refuses symlinks to outside, including dangling symlinks", async () => {
    const outside = join(base, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(base, ".shepherd-worktrees", "escape"));
    symlinkSync(join(base, "missing"), join(base, ".shepherd-worktrees", "dangling"));
    docker.add("escape", join(base, ".shepherd-worktrees", "escape", "missing"));
    docker.add("dangling", join(base, ".shepherd-worktrees", "dangling"));
    expect(await cleanup().sweepOrphans()).toBe(0);
    expect(downs()).toHaveLength(0);
  });

  test.each([undefined, "/srv/services", "other-worktree"])(
    "spares a whole project with conflicting labels: %s",
    async (other) => {
      docker.add("shared", gone);
      docker.add("shared", other === "other-worktree" ? `${gone}-other` : other);
      expect(await cleanup().countOrphans()).toBe(0);
      expect(await cleanup().sweepOrphans()).toBe(0);
      expect(downs()).toHaveLength(0);
    },
  );

  test.each(["-danger", "bad name", "UPPER", "x;echo hi"])(
    "rejects invalid project name %s",
    async (name) => {
      docker.add(name, gone);
      expect(await cleanup().sweepOrphans()).toBe(0);
      expect(downs()).toHaveLength(0);
    },
  );

  test("treats malformed or incomplete inventory as unavailable", async () => {
    docker.add("gone", gone);
    for (const output of ["{bad json", "", "null", "{}", "[]"]) {
      const service = new ComposeCleanup({
        env: {},
        run: (args, timeout) =>
          args.includes("inspect") ? Promise.resolve(output) : docker.run(args, timeout),
      });
      expect(await service.countOrphans()).toBeNull();
      expect(await service.sweepOrphans()).toBe(0);
    }
    expect(downs()).toHaveLength(0);
  });

  test.each(["version", "ps", "inspect"])(
    "silently skips failed %s and retries on the next call",
    async (command) => {
      docker.add("gone", gone);
      let fail = true;
      const service = new ComposeCleanup({
        env: {},
        run: (args, timeout) => {
          if (fail && args.includes(command))
            return Promise.reject(new Error("unavailable/timeout"));
          return docker.run(args, timeout);
        },
      });
      expect(await service.countOrphans()).toBeNull();
      expect(await service.cleanupWorktree(gone)).toBe(0);
      fail = false;
      expect(await service.sweepOrphans()).toBe(1);
    },
  );

  test("a failed down does not prevent other projects or a later retry", async () => {
    docker.add("broken", gone);
    docker.add("healthy", `${gone}-other`);
    let fail = true;
    const service = new ComposeCleanup({
      env: {},
      run: (args, timeout) => {
        if (fail && args.includes("down") && args.includes("broken"))
          return Promise.reject(new Error("timeout"));
        return docker.run(args, timeout);
      },
    });
    expect(await service.sweepOrphans()).toBe(1);
    expect(await service.countOrphans()).toBe(1);
    fail = false;
    expect(await service.sweepOrphans()).toBe(1);
  });

  test("does not mistake an unknown filesystem state for a missing worktree", async () => {
    docker.add("gone", gone);
    const service = new ComposeCleanup({ env: {}, run: docker.run, pathExists: async () => null });
    expect(await service.countOrphans()).toBeNull();
    expect(await service.sweepOrphans()).toBe(0);
    expect(downs()).toHaveLength(0);
  });

  test.each(["recreated", "foreign labels"])("revalidates before down: %s", async (change) => {
    const id = docker.add("gone", gone);
    let inventories = 0;
    const service = new ComposeCleanup({
      env: {},
      run: async (args, timeout) => {
        if (args.includes("inspect") && ++inventories === 2) {
          if (change === "recreated") mkdirSync(gone);
          else
            docker.containers.set(id, {
              "com.docker.compose.project": "gone",
              "com.docker.compose.project.working_dir": "/srv/services",
            });
        }
        return docker.run(args, timeout);
      },
    });
    expect(await service.sweepOrphans()).toBe(0);
    expect(downs()).toHaveLength(0);
  });

  test.each(["ssh://remote", "tcp://127.0.0.1:2375", "garbage"])(
    "skips nonlocal endpoint %s",
    async (endpoint) => {
      docker.setEndpoint(endpoint);
      docker.add("gone", gone);
      expect(await cleanup().countOrphans()).toBeNull();
      expect(await cleanup().sweepOrphans()).toBe(0);
      expect(downs()).toHaveLength(0);
    },
  );

  test("DOCKER_CONTEXT overrides DOCKER_HOST and the resolved endpoint is pinned", async () => {
    docker.add("gone", gone);
    const service = new ComposeCleanup({
      run: docker.run,
      env: { DOCKER_CONTEXT: "chosen", DOCKER_HOST: "ssh://remote" },
    });
    expect(await service.sweepOrphans()).toBe(1);
    expect(docker.calls[0]!.args).toContain("chosen");
    expect(downs()[0]!.args.slice(0, 2)).toEqual(["--host", "unix:///var/run/docker.sock"]);
  });

  test("a remote DOCKER_HOST is skipped without changing context", async () => {
    docker.add("gone", gone);
    const service = new ComposeCleanup({
      run: docker.run,
      env: { DOCKER_HOST: "tcp://remote:2375" },
    });
    expect(await service.sweepOrphans()).toBe(0);
    expect(docker.calls).toHaveLength(0);
  });

  test("overlapping sweeps and worktree cleanup issue only one down per project", async () => {
    docker.add("gone", gone);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new ComposeCleanup({
      env: {},
      run: async (args, timeout) => {
        if (args.includes("down")) {
          entered();
          await gate;
        }
        return docker.run(args, timeout);
      },
    });
    const first = service.sweepOrphans();
    await started;
    expect(await service.sweepOrphans()).toBe(0);
    const second = service.cleanupWorktree(gone);
    release();
    await Promise.all([first, second]);
    expect(downs()).toHaveLength(1);
  });

  test("the production runner kills plugin children on timeout and sanitizes its environment", async () => {
    const bin = join(base, "bin");
    const metadata = join(base, "child.json");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "docker"),
      `#!${process.execPath}
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(metadata)}, JSON.stringify({ pid: child.pid, cwd: process.cwd(),
  composeFile: process.env.COMPOSE_FILE, dockerHost: process.env.DOCKER_HOST }));
setInterval(() => {}, 1000);
`,
      { mode: 0o755 },
    );
    let pid: number | undefined;
    const running = () => {
      try {
        const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
          encoding: "utf8",
        }).trim();
        return state !== "" && !state.startsWith("Z");
      } catch {
        return false;
      }
    };
    try {
      const service = new ComposeCleanup({
        env: {
          PATH: bin,
          DOCKER_HOST: "unix:///fake.sock",
          COMPOSE_FILE: "/unrelated/compose.yaml",
        },
      });
      expect(await service.countOrphans()).toBeNull();
      const child = JSON.parse(readFileSync(metadata, "utf8"));
      pid = child.pid;
      expect(child).toEqual({ pid: expect.any(Number), cwd: "/" });
      for (let attempt = 0; attempt < 50 && running(); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(running()).toBe(false);
    } finally {
      if (pid && running()) process.kill(pid, "SIGKILL");
    }
  }, 15_000);
});
