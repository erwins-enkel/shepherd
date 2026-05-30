import type { SessionStatus } from "./types";

export function elapsed(fromMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export const STATUS_COLOR: Record<SessionStatus, string> = {
  running: "var(--status-running)",
  idle: "var(--status-idle)",
  blocked: "var(--status-blocked)",
  done: "var(--status-done)",
  archived: "var(--status-idle)",
};

export function statusLabel(s: SessionStatus): string {
  return s === "running" ? "WORKING" : s.toUpperCase();
}
