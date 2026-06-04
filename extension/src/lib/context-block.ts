import type { PageMetadata } from "./types";
import type { A11yFinding, CapturedSignals, ConsoleEntry, NetworkEntry } from "./signals";

const CONSOLE_MAX = 30;
const CONSOLE_MSG_MAX = 300;
const NETWORK_MAX = 30;
const NETWORK_URL_MAX = 200;
const A11Y_MAX = 20;

/**
 * Defuse page-controlled strings before embedding them in the ```text fence:
 * collapse newlines/tabs so a crafted value can't add its own "instruction"
 * lines, and neutralize backticks so it can't close the fence and break out.
 * Every page-derived value (metadata AND signal payloads) passes through here.
 */
function sanitize(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/`/g, "'")
    .trim();
}

/** Hard-cap a single field's length so one entry can't blow the prompt budget. */
function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) + "…" : value;
}

/** "… +N more" marker when a section was truncated, else nothing. */
function moreMarker(total: number, shown: number): string[] {
  return total > shown ? [`… +${total - shown} more`] : [];
}

function consoleSection(entries: ConsoleEntry[]): string[] {
  const shown = entries.slice(0, CONSOLE_MAX);
  return [
    `Console (${entries.length}):`,
    ...shown.map((e) => `[${e.level}] ${sanitize(truncate(e.text, CONSOLE_MSG_MAX))}`),
    ...moreMarker(entries.length, shown.length),
  ];
}

function networkSection(entries: NetworkEntry[]): string[] {
  const shown = entries.slice(0, NETWORK_MAX);
  return [
    `Failed requests (${entries.length}):`,
    ...shown.map(
      (e) => `${sanitize(e.method)} ${sanitize(truncate(e.url, NETWORK_URL_MAX))} → ${e.status}`,
    ),
    ...moreMarker(entries.length, shown.length),
  ];
}

function a11ySection(findings: A11yFinding[]): string[] {
  const shown = findings.slice(0, A11Y_MAX);
  return [
    `Accessibility (${findings.length}):`,
    ...shown.map((f) => {
      const sel = f.sampleSelectors.map(sanitize).filter(Boolean).join(", ");
      const tail = sel ? ` · ${sel}` : "";
      return `[${f.impact}] ${sanitize(f.id)} — ${sanitize(f.help)} (${f.nodeCount} nodes)${tail}`;
    }),
    ...moreMarker(findings.length, shown.length),
  ];
}

/**
 * Format captured page metadata (+ optional signals) as one fenced markdown
 * block to append to the task prompt. Fenced as `text` so the agent reads it as
 * data, not instruction. Each present, non-empty signal section is appended
 * inside the same fence. With no `signals`, output is byte-identical to Phase 1.
 */
export function formatContextBlock(meta: PageMetadata, signals?: CapturedSignals): string {
  const lines = [
    "Shepherd Capture — browser context",
    `URL: ${sanitize(meta.url)}`,
    `Title: ${sanitize(meta.title)}`,
    `Viewport: ${meta.viewportW}×${meta.viewportH} @${meta.devicePixelRatio}x`,
    `User agent: ${sanitize(meta.userAgent)}`,
    `Locale: ${sanitize(meta.locale)}`,
    `Captured: ${sanitize(meta.timestamp)}`,
  ];
  if (signals?.console?.length) lines.push("", ...consoleSection(signals.console));
  if (signals?.network?.length) lines.push("", ...networkSection(signals.network));
  if (signals?.a11y?.length) lines.push("", ...a11ySection(signals.a11y));
  return "```text\n" + lines.join("\n") + "\n```";
}
