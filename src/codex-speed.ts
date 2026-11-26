import { execFileSync } from "./instrument";

export type CodexSpeed = "codex" | "standard" | "fast";
export type CodexSpeedReason = "version" | "login" | "disabled" | "model" | "sandboxed" | "unknown";
export type CodexFastAvailability = { tier: string } | { reason: CodexSpeedReason };

export interface CodexSpeedTarget {
  cwd: string;
  model?: string | null;
  provider?: string;
}

export interface CodexSpeedLaunch {
  applied: CodexSpeed;
  reason: CodexSpeedReason | null;
  startedAt: number;
}

export interface CodexSpeedObservation {
  tier: string | null;
  at: number;
}

export function isCodexSpeed(value: unknown): value is CodexSpeed {
  return value === "codex" || value === "standard" || value === "fast";
}

/** The tagged 0.172 CLI explicitly applies the Standard sentinel on start and resume. */
export function codexStandardSupported(binary: string, cwd: string): boolean {
  try {
    const version = execFileSync(binary, ["--version"], {
      cwd,
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const minor = /^codex-cli 0\.(\d+)\.\d+\s*$/.exec(version)?.[1];
    return minor !== undefined && Number(minor) >= 172;
  } catch {
    return false;
  }
}

export const CODEX_STANDARD_UNAVAILABLE = "codex-standard-unavailable";
export const CODEX_STANDARD_SANDBOXED = "codex-standard-sandboxed";
