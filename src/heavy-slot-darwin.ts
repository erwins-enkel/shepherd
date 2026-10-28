import { execFile } from "node:child_process";
import type { MemorySample } from "./heavy-slot-core";

export function parseDarwinPressure(text: string): MemorySample["darwinPressure"] {
  // NOTE_MEMORYSTATUS_PRESSURE_* (event_private.h), not the internal VM levels.
  switch (text.trim()) {
    case "1":
      return "normal";
    case "2":
      return "warning";
    case "4":
      return "critical";
    default:
      return null;
  }
}

export function parseVmStatAvailable(text: string): number | null {
  const pageSize = Number(text.match(/page size of (\d+) bytes/)?.[1]);
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) return null;
  let pages = 0;
  for (const field of ["free", "inactive", "speculative"]) {
    const match = text.match(new RegExp(`^Pages ${field}:\\s+(\\d+)\\.?\\s*$`, "m"));
    if (!match) return null;
    pages += Number(match[1]);
  }
  const bytes = pages * pageSize;
  return Number.isSafeInteger(bytes) ? bytes : null;
}

type MemoryRunner = (file: string, args: string[]) => Promise<string>;
const run: MemoryRunner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        timeout: 2000,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024,
        env: { ...process.env, LC_ALL: "C" },
      },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });

export async function sampleMemoryDarwin(runner: MemoryRunner = run): Promise<MemorySample> {
  const [pressure, vm] = await Promise.all([
    runner("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]).catch(() => ""),
    runner("/usr/bin/vm_stat", []).catch(() => ""),
  ]);
  return {
    availableBytes: parseVmStatAvailable(vm),
    psiFullAvg10: null,
    darwinPressure: parseDarwinPressure(pressure),
  };
}
