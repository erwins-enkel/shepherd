import type { ChatEntry } from "./assistant-chat";
import type { SessionStatus } from "./types";

/** The categorical data hues a repo assistant's mark is drawn in: they identify a series, never a
 *  status (app.css), so a repo keeps its hue whatever its assistant is doing. */
const REPO_HUES = [1, 2, 3, 4, 5, 6] as const;

/** A repo's mark hue, stable per path: `var(--color-data-<n>)`. */
export function repoHue(repo: string): string {
  let h = 0;
  for (let i = 0; i < repo.length; i++) h = (h * 31 + repo.charCodeAt(i)) >>> 0;
  return `var(--color-data-${REPO_HUES[h % REPO_HUES.length]})`;
}

/** The letter a repo's mark shows when it has no project icon. */
export function repoMonogram(name: string): string {
  const letter = [...name].find((c) => /[\p{L}\p{N}]/u.test(c));
  return (letter ?? "?").toUpperCase();
}

const MAX_PREVIEW = 160;

/** A collapsed assistant's preview: its newest reply as one plain line (Markdown marks dropped). */
export function previewLine(entries: ChatEntry[]): string | null {
  const last = entries.findLast((e) => e.kind === "assistant");
  if (!last) return null;
  const line = last.text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`*_#>]|\[([^\]]*)\]\([^)]*\)/g, (m, link: string | undefined) => link ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return line ? line.slice(0, MAX_PREVIEW) : null;
}

/** Replies that came in after `baseline` (the newest reply stamp the operator had seen). */
export function unreadCount(entries: ChatEntry[], baseline: number): number {
  return entries.filter((e) => e.kind === "assistant" && e.ts > baseline).length;
}

/** The newest reply stamp, or 0 with none. */
export function newestReply(entries: ChatEntry[]): number {
  return entries.reduce((max, e) => (e.kind === "assistant" && e.ts > max ? e.ts : max), 0);
}

/** The top-bar pip across every assistant: waiting on the operator beats working; none at rest. */
export function urgentPip(statuses: (SessionStatus | null)[]): "working" | "blocked" | null {
  if (statuses.includes("blocked")) return "blocked";
  if (statuses.includes("running")) return "working";
  return null;
}
