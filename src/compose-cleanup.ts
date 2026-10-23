import { spawn } from "node:child_process";
import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
const PROBE_TIMEOUT_MS = 5_000;
const DOWN_TIMEOUT_MS = 60_000;
const PROJECT_LABEL = "com.docker.compose.project";
const WORKING_DIR_LABEL = "com.docker.compose.project.working_dir";
const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]*$/;

/** Docker launches Compose as a child: bound the whole process group, not just the CLI. */
function runDocker(args: string[], timeoutMs: number, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      cwd: "/",
      env,
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const stop = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* process group already gone */
      }
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(() => {
      stop();
      finish(new Error("Docker timed out"));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > 1024 * 1024) {
        stop();
        finish(new Error("Docker output exceeded limit"));
      } else chunks.push(chunk);
    });
    child.on("error", finish);
    child.on("close", (code) => finish(code === 0 ? undefined : new Error("Docker failed")));
  });
}

interface ComposeCleanupDeps {
  run?: (args: string[], timeoutMs: number) => Promise<string>;
  env?: NodeJS.ProcessEnv;
  /** null means uninspectable, never missing. */
  pathExists?: (path: string) => Promise<boolean | null>;
}

function missing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function pathExists(path: string): Promise<boolean | null> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    return missing(err) ? false : null;
  }
}

/** Resolve existing ancestors too: realpath alone cannot handle deleted worktrees. */
async function canonicalPath(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (err) {
    if (!missing(err)) throw err;
    try {
      await lstat(path);
      return null; // present but unresolvable (e.g. a dangling symlink): not safely scoped
    } catch (probeErr) {
      if (!missing(probeErr)) throw probeErr;
    }
    const parent = dirname(path);
    if (parent === path) return null;
    const resolved = await canonicalPath(parent);
    return resolved === null ? null : join(resolved, basename(path));
  }
}

function worktreeRoot(path: string): string | null {
  const marker = `${sep}.shepherd-worktrees${sep}`;
  const offset = path.lastIndexOf(marker);
  if (offset < 0) return null;
  const end = path.indexOf(sep, offset + marker.length);
  return end < 0 ? path : path.slice(0, end);
}

async function scopedRoot(path: string): Promise<string | null> {
  if (!isAbsolute(path) || path.includes("\0")) return null;
  const normalized = resolve(path);
  if (!worktreeRoot(normalized)) return null;
  const canonical = await canonicalPath(normalized);
  return canonical === null ? null : worktreeRoot(canonical);
}

function parseLabels(row: string): { name: string; workingDir: unknown } {
  const values: unknown = JSON.parse(row);
  if (!values || typeof values !== "object" || Array.isArray(values))
    throw new Error("Invalid labels");
  const record = values as Record<string, unknown>;
  const name = record[PROJECT_LABEL];
  if (typeof name !== "string") throw new Error("Missing project label");
  return { name, workingDir: record[WORKING_DIR_LABEL] };
}

/** Best-effort cleanup of Compose resources owned by absent Shepherd worktrees. */
export class ComposeCleanup {
  private readonly run: NonNullable<ComposeCleanupDeps["run"]>;
  private readonly env: NodeJS.ProcessEnv;
  private readonly pathExists: NonNullable<ComposeCleanupDeps["pathExists"]>;
  private readonly inflight = new Map<string, Promise<boolean>>();
  private sweeping = false;

  constructor(deps: ComposeCleanupDeps = {}) {
    this.env = { ...(deps.env ?? process.env) };
    // The selected endpoint is passed explicitly. Compose must not inherit a config/env file
    // from the server or depend on the now-deleted worktree's .env or working directory.
    const env = Object.fromEntries(
      Object.entries(this.env).filter(
        ([key]) => !key.startsWith("COMPOSE_") && key !== "DOCKER_CONTEXT" && key !== "DOCKER_HOST",
      ),
    );
    this.run = deps.run ?? ((args, timeout) => runDocker(args, timeout, env));
    this.pathExists = deps.pathExists ?? pathExists;
  }

  private async localEndpoint(): Promise<string | null> {
    const context = this.env.DOCKER_CONTEXT;
    const endpoint =
      !context && this.env.DOCKER_HOST
        ? this.env.DOCKER_HOST
        : JSON.parse(
            await this.run(
              [
                "context",
                "inspect",
                ...(context ? [context] : []),
                "--format",
                "{{json .Endpoints.docker.Host}}",
              ],
              PROBE_TIMEOUT_MS,
            ),
          );
    return typeof endpoint === "string" &&
      /^unix:\/\/\/.+/.test(endpoint) &&
      !endpoint.includes("\0")
      ? endpoint
      : null;
  }

  private command(endpoint: string, args: string[], timeout = PROBE_TIMEOUT_MS): Promise<string> {
    return this.run(["--host", endpoint, ...args], timeout);
  }

  /** All containers, including stopped ones, must agree before a project-wide down is safe. */
  private async projects(endpoint: string, project?: string): Promise<Map<string, string | null>> {
    const filter = `label=${PROJECT_LABEL}${project ? `=${project}` : ""}`;
    const output = await this.command(endpoint, [
      "ps",
      "-a",
      "--filter",
      filter,
      "--format",
      "{{.ID}}",
    ]);
    const ids = output.trim() ? output.trim().split(/\s+/) : [];
    if (ids.some((id) => !/^[a-f0-9]{12,64}$/i.test(id)))
      throw new Error("Invalid container inventory");
    const groups = new Map<string, string | null>();
    if (!ids.length) return groups;
    const labels = await this.command(endpoint, [
      "inspect",
      "--format",
      "{{json .Config.Labels}}",
      ...ids,
    ]);
    const rows = labels.trim().split("\n");
    if (rows.length !== ids.length) throw new Error("Incomplete container inventory");
    for (const row of rows) {
      const { name, workingDir } = parseLabels(row);
      if (!PROJECT_NAME.test(name)) continue;
      const root = typeof workingDir === "string" ? await scopedRoot(workingDir) : null;
      groups.set(name, groups.has(name) && groups.get(name) !== root ? null : root);
    }
    return groups;
  }

  private async orphans(endpoint: string): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    for (const [project, root] of await this.projects(endpoint)) {
      if (!root) continue;
      const exists = await this.pathExists(root);
      if (exists === null) throw new Error("Worktree state unknown");
      if (!exists) result.set(project, root);
    }
    return result;
  }

  private async inspectOrphans(): Promise<{
    endpoint: string;
    projects: Map<string, string>;
  } | null> {
    const endpoint = await this.localEndpoint();
    if (!endpoint) return null;
    await this.command(endpoint, ["compose", "version"]);
    return { endpoint, projects: await this.orphans(endpoint) };
  }

  /** Read-only: never turns a failed inventory into a reassuring zero. */
  async countOrphans(): Promise<number | null> {
    try {
      return (await this.inspectOrphans())?.projects.size ?? null;
    } catch {
      return null;
    }
  }

  private async down(endpoint: string, project: string, root: string): Promise<boolean> {
    const key = `${endpoint}\0${project}`;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const pending = (async () => {
      const current = await this.projects(endpoint, project);
      if (current.get(project) !== root || (await this.pathExists(root)) !== false) return false;
      await this.command(
        endpoint,
        ["compose", "-p", project, "down", "--remove-orphans", "--timeout", "10"],
        DOWN_TIMEOUT_MS,
      );
      return true;
    })().catch(() => false);
    this.inflight.set(key, pending);
    try {
      return await pending;
    } finally {
      this.inflight.delete(key);
    }
  }

  private async cleanup(target?: string): Promise<number> {
    try {
      const inventory = await this.inspectOrphans();
      if (!inventory) return 0;
      let removed = 0;
      for (const [project, root] of inventory.projects) {
        if (target !== undefined && root !== target) continue;
        if (await this.down(inventory.endpoint, project, root)) removed++;
      }
      return removed;
    } catch {
      return 0;
    }
  }

  /** Invoked after synchronous worktree removal; no live/recreated checkout is stopped. */
  async cleanupWorktree(worktreePath: string): Promise<number> {
    try {
      const root = await scopedRoot(worktreePath);
      return root === null ? 0 : await this.cleanup(root);
    } catch {
      return 0;
    }
  }

  async sweepOrphans(): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    try {
      return await this.cleanup();
    } finally {
      this.sweeping = false;
    }
  }
}
