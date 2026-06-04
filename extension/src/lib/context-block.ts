import type { PageMetadata } from "./types";

/**
 * Format captured page metadata as a fenced markdown block to append to the
 * task prompt. Fenced as `text` so the agent reads it as data, not instruction.
 * Optional sections (console/network, a11y) are appended by later phases; this
 * Phase-1 version emits metadata only.
 */
export function formatContextBlock(meta: PageMetadata): string {
  const lines = [
    "Shepherd Capture — browser context",
    `URL: ${meta.url}`,
    `Title: ${meta.title}`,
    `Viewport: ${meta.viewportW}×${meta.viewportH} @${meta.devicePixelRatio}x`,
    `User agent: ${meta.userAgent}`,
    `Locale: ${meta.locale}`,
    `Captured: ${meta.timestamp}`,
  ];
  return "```text\n" + lines.join("\n") + "\n```";
}
