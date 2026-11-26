// Shared Docker CLI plumbing for Shepherd-managed containers (compose cleanup, Postgres #4232).
// Async only: the server is one Bun loop, so nothing here may block it.
import { spawn } from "node:child_process";

const OUTPUT_LIMIT = 1024 * 1024;

export interface DockerRunOptions {
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  /** Written to the child's stdin (e.g. SQL for `docker exec -i … psql -f -`); never argv. */
  input?: string;
}

/** Run `docker <args>` and resolve its stdout. Rejects on a non-zero exit, timeout or oversized
 *  output. Docker may launch helpers (Compose): the whole process group is bounded, not just the
 *  CLI. */
export function runDocker(args: string[], opts: DockerRunOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      cwd: "/",
      env: opts.env,
      detached: true,
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const stop = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* best-effort: process group already gone */
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
    }, opts.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > OUTPUT_LIMIT) {
        stop();
        finish(new Error("Docker output exceeded limit"));
      } else chunks.push(chunk);
    });
    if (opts.input !== undefined && child.stdin) {
      child.stdin.on("error", () => {}); // EPIPE when docker exits early: the exit code reports it
      child.stdin.end(opts.input);
    }
    child.on("error", finish);
    child.on("close", (code) => finish(code === 0 ? undefined : new Error("Docker failed")));
  });
}

/** The server env minus everything that would redirect the CLI: the endpoint is passed
 *  explicitly with `--host`, and Compose must not pick up a stray config/env file. */
export function dockerChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => !key.startsWith("COMPOSE_") && key !== "DOCKER_CONTEXT" && key !== "DOCKER_HOST",
    ),
  );
}

/** The local Docker endpoint (`unix:///…`) the server env selects — `DOCKER_HOST` unless a context
 *  is set, else the (current or named) context's endpoint. null for anything non-local. */
export async function resolveDockerEndpoint(
  run: (args: string[], timeoutMs: number) => Promise<string>,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string | null> {
  const context = env.DOCKER_CONTEXT;
  const endpoint: unknown =
    !context && env.DOCKER_HOST
      ? env.DOCKER_HOST
      : JSON.parse(
          await run(
            [
              "context",
              "inspect",
              ...(context ? [context] : []),
              "--format",
              "{{json .Endpoints.docker.Host}}",
            ],
            timeoutMs,
          ),
        );
  return typeof endpoint === "string" && /^unix:\/\/\/.+/.test(endpoint) && !endpoint.includes("\0")
    ? endpoint
    : null;
}
