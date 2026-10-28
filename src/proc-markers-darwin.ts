import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ProcStat } from "./heavy-slot";

export interface DarwinMarkerScan {
  procs: Map<string, ProcStat>;
  /** Only a complete scan can prove that a job has no remaining processes. */
  complete: boolean;
}

/** KERN_PROCARGS2: argc, executable + padding, argc NUL-terminated args, environ.
 * Empty/redacted environments are deliberately unknown, never negative evidence. */
export function parseProcArgsMarker(data: Buffer): { marker: string | null; complete: boolean } {
  const unknown = { marker: null, complete: false };
  if (data.length < 4) return unknown;
  const argc = data.readInt32LE(0);
  if (argc <= 0 || argc > data.length - 4) return unknown;
  let cursor = data.indexOf(0, 4);
  if (cursor < 0) return unknown;
  while (cursor < data.length && data[cursor] === 0) cursor++;
  let ambiguousMarker = false;
  for (let arg = 0; arg < argc; arg++) {
    const end = data.indexOf(0, cursor);
    if (end < 0) return unknown;
    // Empty argv[0] cannot be distinguished from executable padding. A marker
    // consumed here is not positive evidence, but cannot prove absence either.
    ambiguousMarker ||= data.toString("utf8", cursor, end).startsWith("SHEPHERD_HEAVY_JOB=");
    cursor = end + 1;
  }
  let marker: string | null = null;
  let entries = 0;
  while (cursor < data.length && data[cursor] !== 0) {
    const end = data.indexOf(0, cursor);
    if (end < 0) return { marker, complete: false };
    const entry = data.toString("utf8", cursor, end);
    if (entry.startsWith("SHEPHERD_HEAVY_JOB=")) marker = entry.slice("SHEPHERD_HEAVY_JOB=".length);
    entries++;
    cursor = end + 1;
  }
  return { marker, complete: !ambiguousMarker && entries > 0 && cursor < data.length };
}

/** A vanished process is harmless; any other unreadable own process makes absence unknown. */
export function collectDarwinMarkers(
  ps: string,
  uid: number,
  jobIds: ReadonlySet<string>,
  read: (pid: number) => Buffer | "gone" | null,
): DarwinMarkerScan {
  const procs = new Map<string, ProcStat>();
  let complete = ps.trim().length > 0;
  for (const line of ps.trim().split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)$/);
    if (!match) {
      complete = false;
      continue;
    }
    const [, pidText, uidText, rssText, state] = match;
    if (Number(uidText) !== uid || state!.startsWith("Z")) continue;
    const pid = Number(pidText);
    const rssBytes = Number(rssText) * 1024;
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(rssBytes)) {
      complete = false;
      continue;
    }
    const data = read(pid);
    if (data === "gone") continue;
    if (data === null) {
      complete = false;
      continue;
    }
    const parsed = parseProcArgsMarker(data);
    complete &&= parsed.complete;
    if (!parsed.marker || !jobIds.has(parsed.marker)) continue;
    const stat = procs.get(parsed.marker) ?? { count: 0, rssBytes: 0 };
    stat.count++;
    stat.rssBytes += rssBytes;
    procs.set(parsed.marker, stat);
  }
  return { procs, complete };
}

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
