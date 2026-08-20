/**
 * Isolated headless herdr servers for the compatibility check's live half
 * (SOP: .claude/rules/herdr-version-bump.md).
 *
 * The #2039 recipe, mechanised: each server gets its OWN `HOME`/`XDG_*`/`HERDR_SOCKET_PATH`
 * under a short `/tmp` symlink (unix sockets cap at ~108 path bytes), with `HERDR_ENV`/
 * `HERDR_SESSION` scrubbed, so the operator's live daemon and its running agents are never
 * touched. Every started server is registered for teardown on exit/SIGINT/SIGTERM — a crashed
 * run must not leave a stray daemon. Scratch state lives under
 * `~/.cache/shepherd/herdr-compat/run-<pid>/` so any leftover from a hard kill is visible and
 * removable by hand.
 */

import { mkdirSync, rmSync, rmdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { COMPAT_CACHE_DIR } from "./download";

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface IsolatedServer {
  readonly bin: string;
  readonly label: string;
  /** The env every CLI call against this server must carry. */
  readonly env: Record<string, string>;
  /** Scratch working dir (exists, git-initialisable) for cwd-taking commands. */
  readonly workDir: string;
  run(argv: string[], opts?: { cwd?: string }): Promise<RunResult>;
  /** run() + parse the stdout as JSON; throws on non-zero exit or unparsable output. */
  runJson(argv: string[]): Promise<unknown>;
  stop(): Promise<void>;
}

const live = new Set<{ bin: string; env: Record<string, string>; scratch: string; link: string }>();
let hooksInstalled = false;

function installExitHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  const teardown = () => {
    for (const s of live) {
      try {
        Bun.spawnSync([s.bin, "server", "stop"], {
          env: s.env,
          stdout: "ignore",
          stderr: "ignore",
        });
      } catch {
        /* best effort — the scratch dir stays for post-mortem */
      }
      try {
        rmSync(s.link, { force: true });
      } catch {
        /* ignore */
      }
    }
    live.clear();
  };
  process.on("exit", teardown);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      teardown();
      process.exit(130);
    });
  }
}

export async function startIsolatedServer(bin: string, label: string): Promise<IsolatedServer> {
  installExitHooks();
  const scratch = join(COMPAT_CACHE_DIR, `run-${process.pid}`, label);
  const link = `/tmp/hcmp-${process.pid}-${label}`;
  const home = join(link, "home");
  const workDir = join(scratch, "work");
  mkdirSync(join(scratch, "home"), { recursive: true });
  mkdirSync(join(scratch, "run"), { recursive: true });
  mkdirSync(workDir, { recursive: true });
  rmSync(link, { force: true });
  symlinkSync(scratch, link);

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_RUNTIME_DIR: join(link, "run"),
    HERDR_SOCKET_PATH: join(link, "h.sock"),
  };
  delete env.HERDR_ENV;
  delete env.HERDR_SESSION;

  const rec = { bin, env, scratch, link };
  live.add(rec);

  const logFile = Bun.file(join(scratch, "server.log"));
  const proc = Bun.spawn([bin, "server"], { env, stdout: logFile, stderr: logFile });
  proc.unref();

  const run = async (argv: string[], opts?: { cwd?: string }): Promise<RunResult> => {
    const p = Bun.spawn([bin, ...argv], {
      env,
      cwd: opts?.cwd ?? workDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    return { stdout, stderr, exitCode };
  };

  // Wait for the server to accept API calls (bounded).
  const deadline = Date.now() + 15_000;
  for (;;) {
    const status = await run(["status", "server"]);
    if (status.exitCode === 0 && /status:\s*running/.test(status.stdout)) break;
    if (Date.now() > deadline) {
      live.delete(rec);
      rmSync(link, { force: true });
      throw new Error(
        `isolated herdr server (${label}) did not come up within 15s; log: ${join(scratch, "server.log")}`,
      );
    }
    await Bun.sleep(300);
  }

  return {
    bin,
    label,
    env,
    workDir,
    run,
    async runJson(argv: string[]): Promise<unknown> {
      const res = await run(argv);
      if (res.exitCode !== 0) {
        throw new Error(
          `herdr ${argv.join(" ")} exited ${res.exitCode}: ${res.stderr || res.stdout}`,
        );
      }
      try {
        return JSON.parse(res.stdout);
      } catch {
        throw new Error(`herdr ${argv.join(" ")} printed non-JSON: ${res.stdout.slice(0, 200)}`);
      }
    },
    async stop(): Promise<void> {
      await run(["server", "stop"]).catch(() => undefined);
      live.delete(rec);
      rmSync(link, { force: true });
      rmSync(scratch, { recursive: true, force: true });
      // The per-run parent (run-<pid>/) too, once its last label is gone — otherwise every
      // invocation leaves an empty dir behind. Non-empty (a crashed sibling kept for
      // post-mortem) → rmdir refuses, which is exactly right.
      try {
        rmdirSync(dirname(scratch));
      } catch {
        /* not empty or already gone */
      }
    },
  };
}

/** The default run-scratch root, for the CLI's final leftover note. */
export function runScratchRoot(): string {
  return join(homedir(), ".cache", "shepherd", "herdr-compat", `run-${process.pid}`);
}
