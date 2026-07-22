import { spawn } from "node:child_process";

/** Spawn `bash -lc <script>` as a managed child of shepherd (NOT detached), stream
 *  stdout+stderr line-wise to onLine, resolve on exit. The AbortSignal (watchdog)
 *  force-kills a hung child. Shared by the herdr and codex updaters — extracted so
 *  the two don't drift (they were byte-identical copies). `spawnFailLabel` prefixes
 *  the synthetic line emitted when the spawn itself fails. */
export function runScriptChild(
  script: string,
  onLine: (line: string) => void,
  signal: AbortSignal,
  spawnFailLabel: string,
): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", script], { stdio: ["ignore", "pipe", "pipe"] });
    const kill = () => child.kill("SIGKILL");
    if (signal.aborted) kill();
    else signal.addEventListener("abort", kill, { once: true });

    let buf = "";
    const handleChunk = (chunk: Buffer | string) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trimEnd();
        if (trimmed) onLine(trimmed);
      }
    };
    child.stdout?.on("data", handleChunk);
    child.stderr?.on("data", handleChunk);
    const finish = () => {
      signal.removeEventListener("abort", kill);
      if (buf.trim()) onLine(buf.trim());
      resolve();
    };
    child.on("exit", finish);
    child.on("error", (err) => {
      onLine(`${spawnFailLabel} spawn failed: ${err.message}`);
      finish();
    });
  });
}
