import type { PageMetadata } from "./types";

/**
 * Defuse page-controlled strings (url/title/userAgent/locale) before embedding
 * them in the ```text fence: collapse newlines/tabs so a crafted value can't add
 * its own lines of "instructions", and neutralize backticks so it can't close
 * the fence and break out into the agent prompt. The agent still treats the
 * block as data, but this makes that boundary unforgeable rather than mere
 * convention.
 */
function sanitize(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/`/g, "'")
    .trim();
}

/**
 * Format captured page metadata as a fenced markdown block to append to the
 * task prompt. Fenced as `text` so the agent reads it as data, not instruction.
 * Optional sections (console/network, a11y) are appended by later phases; this
 * Phase-1 version emits metadata only.
 */
export function formatContextBlock(meta: PageMetadata): string {
  const lines = [
    "Shepherd Capture — browser context",
    `URL: ${sanitize(meta.url)}`,
    `Title: ${sanitize(meta.title)}`,
    `Viewport: ${meta.viewportW}×${meta.viewportH} @${meta.devicePixelRatio}x`,
    `User agent: ${sanitize(meta.userAgent)}`,
    `Locale: ${sanitize(meta.locale)}`,
    `Captured: ${sanitize(meta.timestamp)}`,
  ];
  return "```text\n" + lines.join("\n") + "\n```";
}
