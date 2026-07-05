// Parse OSC 52 clipboard-write payloads. Claude Code's `c to copy` (and other TUIs) emit
// OSC 52 (`ESC ] 52 ; <Pc> ; <Pd> BEL`) to ask the terminal to write to the system clipboard.
// xterm's `registerOscHandler(52, cb)` hands the callback everything after the `52;`
// identifier — i.e. the `<Pc>;<Pd>` part — which is exactly what this function consumes.
// Pure + co-located tests so the parser is render-agnostic and reusable, mirroring
// slashLinks.ts. No xterm/Svelte/DOM/clipboard here — a later task wires the xterm OSC
// handler + clipboard write around this.

export interface Osc52Write {
  /** Decoded UTF-8 clipboard text to write. */
  text: string;
}

/** Max decoded payload we will accept (bytes of the base64-decoded UTF-8). */
export const OSC52_MAX_BYTES = 32_768;

// Cheap pre-check bound on the base64 *string* length, applied before decoding so we never
// base64-decode a huge blob just to reject it. 4 output chars encode 3 input bytes (with
// padding rounding up), plus slack for padding chars.
const MAX_B64_LENGTH = Math.ceil(OSC52_MAX_BYTES / 3) * 4 + 4;

/**
 * Parse an OSC 52 payload (`<Pc>;<Pd>`, the data xterm hands an OSC-52 handler).
 * Returns the decoded clipboard-write text, or null when the payload must be ignored:
 *  - a READ/query request (`Pd === "?"`) — we NEVER return clipboard contents to the
 *    remote program (exfiltration guard);
 *  - malformed / non-base64 `Pd`;
 *  - decoded payload exceeding OSC52_MAX_BYTES.
 * `Pc` (the selection target) is ignored — we always target the clipboard.
 */
export function parseOsc52(data: string): Osc52Write | null {
  const sep = data.indexOf(";");
  if (sep === -1) return null;

  const pd = data.slice(sep + 1);

  // Read/query request: the remote program is asking for the current clipboard contents.
  // Refuse — never disclose clipboard contents back to the terminal program.
  if (pd === "?") return null;

  if (pd.length === 0 || pd.length > MAX_B64_LENGTH) return null;

  let bytes: Uint8Array;
  try {
    const binary = atob(pd);
    bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }

  if (bytes.byteLength > OSC52_MAX_BYTES) return null;

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }

  return { text };
}
