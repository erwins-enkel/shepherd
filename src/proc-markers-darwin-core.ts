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
  const env = parseEnvironmentMarker(data, cursor);
  return { marker: env.marker, complete: !ambiguousMarker && env.complete };
}

function parseEnvironmentMarker(data: Buffer, cursor: number) {
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
  return { marker, complete: entries > 0 && cursor < data.length };
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
    const proc = parseOwnProcess(line, uid);
    if (proc === "skip") continue;
    if (proc === null) {
      complete = false;
      continue;
    }
    const { pid, rssBytes } = proc;
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

/** Malformed rows are unknown; foreign users and zombies are outside the scan. */
function parseOwnProcess(
  line: string,
  uid: number,
): { pid: number; rssBytes: number } | "skip" | null {
  const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)$/);
  if (!match) return null;
  const [, pidText, uidText, rssText, state] = match;
  if (Number(uidText) !== uid || state!.startsWith("Z")) return "skip";
  const pid = Number(pidText);
  const rssBytes = Number(rssText) * 1024;
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(rssBytes)) return null;
  return { pid, rssBytes };
}
