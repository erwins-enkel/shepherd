import { spawn } from "node:child_process";

export interface Captured {
  stdout: string;
  stderr: string;
  code: number;
}

/** Spawn `bin args`, capture stdout/stderr, and resolve (never throw) so the
 *  caller inspects `code`. stdin is `"ignore"`, NOT a pipe: the incus Go client
 *  DEADLOCKS forever on an open stdin pipe for operation-streaming commands
 *  (`launch`/`exec`/`file push`) — closing it lets them return. `timeoutMs`, when
 *  given, SIGKILLs a wedged process as a backstop. Shared by the incus + gh
 *  runners. */
export function captureSpawn(bin: string, args: string[], timeoutMs?: number): Promise<Captured> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = timeoutMs
      ? setTimeout(() => {
          stderr += `\n${bin} ${args[0] ?? ""} killed after ${timeoutMs}ms (timeout)`;
          child.kill("SIGKILL");
        }, timeoutMs)
      : null;
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr: stderr + String(err), code: 1 });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}
