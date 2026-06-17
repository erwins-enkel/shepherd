import { captureSpawn } from "./spawn";
import type { IncusExec, IncusRunner } from "./types";

/** The harness's `shep-onb` Incus profile, owned in-repo so a fresh/misconfigured host
 *  self-heals. limits.memory headroom (4GiB) clears the ~2GB transient peak of claude's
 *  native installer that OOM-killed the 2GiB profile (#749). */
export const HARNESS_PROFILE = {
  name: "shep-onb",
  /** key/value pairs applied via `incus profile set` (additive — never clobbers extras). */
  config: {
    "limits.cpu": "2",
    "limits.memory": "4GiB",
    "security.nesting": "true",
  },
  /** `incus profile device add <name> tun unix-char path=/dev/net/tun`. */
  device: { name: "tun", type: "unix-char", options: ["path=/dev/net/tun"] },
} as const;

/** Backstop kill timeout for any single `incus` call. The genuine hang fix is
 *  `captureSpawn` closing stdin (the incus Go client deadlocks on an open stdin
 *  pipe for operation-streaming commands); this cap only guards a process that
 *  wedges for some other reason. Generous on purpose — a cold image pull and an
 *  in-instance `bun install` legitimately take minutes. */
const RUNNER_TIMEOUT_MS = 20 * 60_000;

/** Default runner: invokes the real `incus` binary, capturing output and never
 *  throwing on a non-zero exit (the caller inspects `code`). */
const defaultRunner: IncusRunner = (args) => captureSpawn("incus", args, RUNNER_TIMEOUT_MS);

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

  /** Idempotently ensures the `shep-onb` Incus profile exists with the configured keys.
   *
   *  Uses additive `create`/`set`/`device add` (NOT declarative `profile edit`) so the
   *  method enforces only the keys it owns and never strips operator-added config (e.g.
   *  a credential disk). Profile names are global — NOT instance-prefixed — so we use
   *  `HARNESS_PROFILE.name` raw, never `this.full()`.
   *
   *  Step 1: `profile create` — tolerated on non-zero (profile already exists is the
   *    normal steady state on a pre-configured host).
   *  Step 2: `profile set` with the full config key/value pairs — MUST succeed;
   *    throws fail-closed on non-zero because a wrong memory cap defeats the fix for #749.
   *  Step 3: `profile device add` — tolerated on non-zero (device already present). */
  async ensureProfile(): Promise<void> {
    const name = HARNESS_PROFILE.name;

    // Step 1: create (tolerate non-zero — already-exists is the steady state).
    await this.run(["profile", "create", name]);

    // Step 2: set all config keys additively (must succeed — applies the memory cap).
    const configArgs: string[] = [];
    for (const [key, value] of Object.entries(HARNESS_PROFILE.config)) {
      configArgs.push(key, value);
    }
    const setResult = await this.run(["profile", "set", name, ...configArgs]);
    if (setResult.code !== 0) {
      throw new Error(
        `incus profile set failed for ${name}: ${setResult.stderr || setResult.stdout}`,
      );
    }

    // Step 3: device add (tolerate non-zero — device already present is fine).
    const { device } = HARNESS_PROFILE;
    await this.run(["profile", "device", "add", name, device.name, device.type, ...device.options]);
  }
}
