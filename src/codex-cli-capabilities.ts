import { execFileSync } from "./instrument";

const readCodexHelp = (): string =>
  execFileSync("codex", ["--help"], {
    encoding: "utf8",
    timeout: 2_000,
    stdio: ["ignore", "pipe", "ignore"],
  });

/** Probe per launch so CLI updates take effect without restarting Shepherd. */
export function codexNoDaemonArgs(readHelp: () => string = readCodexHelp): string[] {
  try {
    return /^\s*--no-daemon(?:\s|$)/m.test(readHelp()) ? ["--no-daemon"] : [];
  } catch {
    return [];
  }
}
