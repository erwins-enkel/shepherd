import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ProcStat } from "./heavy-slot";

import type { DarwinMarkerScan } from "./proc-markers-darwin-core";

type MarkerRunner = (ids: string[]) => Promise<string>;
const runHelper: MarkerRunner = (ids) =>
  new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.SHEPHERD_HEAVY_JOB;
    const child = execFile(
      process.execPath,
      [fileURLToPath(new URL("./proc-markers-darwin-helper.ts", import.meta.url))],
      {
        timeout: 3000,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
        env,
      },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
    // A helper that fails before reading stdin must still resolve as an unknown scan.
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(ids));
  });

function decodeScan(text: string, ids: ReadonlySet<string>): DarwinMarkerScan {
  const raw = JSON.parse(text);
  if (typeof raw?.complete !== "boolean" || !Array.isArray(raw.procs))
    throw new Error("invalid scan");
  const procs = new Map<string, ProcStat>();
  for (const entry of raw.procs) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new Error("invalid entry");
    const [id, stat] = entry;
    if (
      typeof id !== "string" ||
      !ids.has(id) ||
      procs.has(id) ||
      !Number.isSafeInteger(stat?.count) ||
      stat.count <= 0 ||
      !Number.isSafeInteger(stat?.rssBytes) ||
      stat.rssBytes < 0
    )
      throw new Error("invalid stat");
    procs.set(id, { count: stat.count, rssBytes: stat.rssBytes });
  }
  return { procs, complete: raw.complete };
}

/** Each request gets fresh evidence, with at most one helper in flight. */
export function makeDarwinMarkerScanner(run: MarkerRunner = runHelper) {
  let pending: Promise<unknown> = Promise.resolve();
  return (ids: ReadonlySet<string>): Promise<DarwinMarkerScan> => {
    const scan = pending.then(async () => {
      try {
        return decodeScan(await run([...ids]), ids);
      } catch {
        return { procs: new Map<string, ProcStat>(), complete: false };
      }
    });
    pending = scan;
    return scan;
  };
}

export const scanMarkersDarwin = makeDarwinMarkerScanner();
