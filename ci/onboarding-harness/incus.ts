import { spawn } from "node:child_process";
import type { IncusExec, IncusRunner } from "./types";

/** Backstop kill timeout for any single `incus` call. The genuine hang fix is
 *  closing stdin (below); this cap only guards a process that wedges for some
 *  other reason. Generous on purpose — a cold image pull and an in-instance
 *  `bun install` legitimately take minutes. */
const RUNNER_TIMEOUT_MS = 20 * 60_000;

/** Default runner: invokes the real `incus` binary, capturing output and never
 *  throwing on a non-zero exit (the caller inspects `code`).
 *
 *  stdin MUST be `"ignore"`, NOT an (execFile-style) pipe: the incus Go client
 *  DEADLOCKS forever on an open stdin pipe for its operation-streaming commands
 *  (`launch`, `exec`, `file push`) — every worker thread parks in `futex_wait`
 *  and the call never resolves. `execFile` forces a stdin pipe, which is why the
 *  harness hung on the very first launch. Closing stdin lets these commands
 *  return; the backstop timeout above is belt-and-suspenders only. */
const defaultRunner: IncusRunner = (args) =>
  new Promise((resolve) => {
    const child = spawn("incus", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      stderr += `\nincus ${args[0] ?? ""} killed after ${RUNNER_TIMEOUT_MS}ms (timeout)`;
      child.kill("SIGKILL");
    }, RUNNER_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + String(err), code: 1 });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });

/** Thin, throw-away-instance lifecycle wrapper over the `incus` CLI. All managed
 *  instances carry `prefix` in their name so `sweep()` can reap leaks. */
export class IncusDriver {
  constructor(
    private run: IncusRunner = defaultRunner,
    private prefix = "shep-onb-",
  ) {}

  private full(name: string): string {
    return this.prefix + name;
  }

  async launch(
    image: string,
    name: string,
    opts: { vm?: boolean; profiles?: string[] } = {},
  ): Promise<void> {
    const args = ["launch", image, this.full(name)];
    if (opts.vm) args.push("--vm");
    // Each `--profile` STACKS; the caller must include `default` explicitly, since
    // passing only a custom profile REPLACES default and strips its root disk + NIC
    // ("No root device could be found"). See seed.ts for the canonical list.
    for (const p of opts.profiles ?? []) args.push("--profile", p);
    const r = await this.run(args);
    if (r.code !== 0) throw new Error(`incus launch failed: ${r.stderr || r.stdout}`);
  }

  async exec(name: string, cmd: string[]): Promise<IncusExec> {
    return this.run(["exec", this.full(name), "--", ...cmd]);
  }

  async push(name: string, localPath: string, remotePath: string): Promise<void> {
    const r = await this.run(["file", "push", localPath, `${this.full(name)}${remotePath}`]);
    if (r.code !== 0) throw new Error(`incus file push failed: ${r.stderr}`);
  }

  async pull(name: string, remotePath: string, localPath: string): Promise<void> {
    const r = await this.run(["file", "pull", `${this.full(name)}${remotePath}`, localPath]);
    if (r.code !== 0) throw new Error(`incus file pull failed: ${r.stderr}`);
  }

  async delete(name: string): Promise<void> {
    await this.run(["delete", this.full(name), "--force"]);
  }

  /** Names of all instances carrying the managed prefix. */
  async listManaged(): Promise<string[]> {
    const r = await this.run(["list", "--format", "json"]);
    if (r.code !== 0) return [];
    const rows = JSON.parse(r.stdout) as Array<{ name: string }>;
    return rows.map((x) => x.name).filter((n) => n.startsWith(this.prefix));
  }

  /** Force-delete every managed instance (orphan reaper, run at start + teardown). */
  async sweep(): Promise<void> {
    for (const full of await this.listManaged()) {
      await this.run(["delete", full, "--force"]);
    }
  }
}
