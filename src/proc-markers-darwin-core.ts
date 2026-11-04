import type { ProcStat } from "./heavy-slot";

/** Live marker processes per job id; null when the process table itself could not be read. */
export type DarwinMarkerScan = Map<string, ProcStat> | null;

const MARKER = "SHEPHERD_HEAVY_JOB=";

/** KERN_PROCARGS2: argc, executable + padding, argc NUL-terminated args, environ. The job id the
 * process carries, or null (none, or an unreadable block). An empty argv[0] is indistinguishable
 * from the executable's padding and shifts the first environment entry into the last argument, so
 * a marker there counts too: a shifted marker is never missed, and an argument naming a live job
 * id belongs to that job anyway. */
export function parseProcArgsMarker(data: Buffer): string | null {
  if (data.length < 4) return null;
  const argc = data.readInt32LE(0);
  if (argc <= 0 || argc > data.length - 4) return null;
  let cursor = data.indexOf(0, 4);
  if (cursor < 0) return null;
  while (cursor < data.length && data[cursor] === 0) cursor++;
  let lastArg = "";
  for (let arg = 0; arg < argc; arg++) {
    const end = data.indexOf(0, cursor);
    if (end < 0) return null;
    lastArg = data.toString("utf8", cursor, end);
    cursor = end + 1;
  }
  const env = parseEnvironmentMarker(data, cursor);
  if (env !== null) return env;
  return lastArg.startsWith(MARKER) ? lastArg.slice(MARKER.length) : null;
}

function parseEnvironmentMarker(data: Buffer, cursor: number): string | null {
  let marker: string | null = null;
  while (cursor < data.length && data[cursor] !== 0) {
    const end = data.indexOf(0, cursor);
    if (end < 0) break;
    const entry = data.toString("utf8", cursor, end);
    if (entry.startsWith(MARKER)) marker = entry.slice(MARKER.length);
    cursor = end + 1;
  }
  return marker;
}

/**
 * Every own process carrying one of `jobIds`, the same rule as the Linux /proc scan: a process
 * whose arguments or environment macOS won't show (SIP-protected agents of the same UID; macOS 27
 * redacts most own processes' environment, #3697) or that vanished is skipped, as an unreadable
 * /proc/<pid>/environ is on Linux. Demanding every process be readable
 * let one such agent pin a slot forever (#3631). Only an unreadable process table (empty or
 * malformed `ps` output) is unknown → null.
 */
export function collectDarwinMarkers(
  ps: string,
  uid: number,
  jobIds: ReadonlySet<string>,
  read: (pid: number) => Buffer | null,
): DarwinMarkerScan {
  if (ps.trim().length === 0) return null;
  const procs = new Map<string, ProcStat>();
  for (const line of ps.trim().split("\n")) {
    const proc = parseOwnProcess(line, uid);
    if (proc === "skip") continue;
    if (proc === null) return null;
    const data = read(proc.pid);
    const marker = data ? parseProcArgsMarker(data) : null;
    if (!marker || !jobIds.has(marker)) continue;
    const stat = procs.get(marker) ?? { count: 0, rssBytes: 0 };
    stat.count++;
    stat.rssBytes += proc.rssBytes;
    procs.set(marker, stat);
  }
  return procs;
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
