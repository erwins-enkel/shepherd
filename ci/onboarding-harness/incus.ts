import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IncusExec, IncusRunner } from "./types";

const execFileAsync = promisify(execFile);

/** Default runner: invokes the real `incus` binary, capturing output and never
 *  throwing on a non-zero exit (the caller inspects `code`). */
const defaultRunner: IncusRunner = async (args) => {
  try {
    const { stdout, stderr } = await execFileAsync("incus", args, { encoding: "utf8" });
    return { stdout: stdout.toString(), stderr: stderr.toString(), code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1 };
  }
};

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
    opts: { vm?: boolean; profile?: string } = {},
  ): Promise<void> {
    const args = ["launch", image, this.full(name)];
    if (opts.vm) args.push("--vm");
    if (opts.profile) args.push("--profile", opts.profile);
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
