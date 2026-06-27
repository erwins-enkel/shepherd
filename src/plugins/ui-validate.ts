// Seam validator for plugin-authored declarative UI descriptors (issue #1185).
// Never throws; returns a normalized PluginUIView (re-parsed JSON) or null (invalid).

import type { PluginUIView } from "./types";

/** Guards against a *buggy* (not malicious) trusted plugin — sizes are generous
 *  enough for a rich panel, small enough to catch runaway generators. */
const MAX_BYTES = 64 * 1024; // 64 KB JSON ceiling
const MAX_ARRAY = 500; // max length of any props array or children array
const MAX_NODES = 256; // max total nodes in the tree
const MAX_DEPTH = 16; // max nesting depth (root = depth 1)

const VALID_SLOTS = new Set<string>(["settings-panel", "session-sidebar", "dashboard-card"]);

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

/** True when no array value in `props` exceeds MAX_ARRAY. */
function propsWithinBounds(props: Record<string, unknown>): boolean {
  for (const val of Object.values(props)) {
    if (Array.isArray(val) && val.length > MAX_ARRAY) return false;
  }
  return true;
}

/** Recursively validate one node (re-parsed JSON) against the structural caps.
 *  `counter` accumulates the total node count across the whole tree. */
function validateNode(node: unknown, depth: number, counter: { n: number }): boolean {
  if (depth > MAX_DEPTH) return false;
  if (!isPlainObject(node)) return false;
  if (++counter.n > MAX_NODES) return false;
  if (typeof node["type"] !== "string" || node["type"].length === 0) return false;

  const props = node["props"];
  if (props !== undefined && (!isPlainObject(props) || !propsWithinBounds(props))) return false;

  const children = node["children"];
  if (children === undefined) return true;
  if (!Array.isArray(children) || children.length > MAX_ARRAY) return false;
  return children.every((child) => validateNode(child, depth + 1, counter));
}

/** Validate and normalize a plugin-authored UI view descriptor.
 *  Returns the re-parsed (normalized) PluginUIView on success, or null if invalid.
 *  NEVER throws — invalid publishUI calls are dropped fail-open. */
export function validatePluginUIView(view: unknown): PluginUIView | null {
  // 1. Serializability via JSON.stringify: catches cycles/BigInt (they throw).
  //    Functions/undefined/symbols are silently stripped; the stored view is the
  //    re-parsed form so those props are dropped, not rejected.
  let s: string;
  try {
    const raw = JSON.stringify(view);
    if (raw === undefined) return null;
    s = raw;
  } catch {
    return null;
  }

  // 2. Byte-size cap: rejects a buggy huge single node.
  if (Buffer.byteLength(s, "utf8") > MAX_BYTES) return null;

  // 3. Re-parse (normalizes away non-JSON props) then validate shape + tree.
  const parsed = JSON.parse(s) as unknown;
  if (!isPlainObject(parsed)) return null;
  if (parsed["schemaVersion"] !== 1) return null;
  if (typeof parsed["slot"] !== "string" || !VALID_SLOTS.has(parsed["slot"])) return null;

  return validateNode(parsed["root"], 1, { n: 0 }) ? (parsed as unknown as PluginUIView) : null;
}
