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

  // 3. Re-parse (normalizes away non-JSON props) then walk the tree once.
  const parsed = JSON.parse(s) as unknown;

  // Top-level shape.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const v = parsed as Record<string, unknown>;
  if (v["schemaVersion"] !== 1) return null;
  if (typeof v["slot"] !== "string" || !VALID_SLOTS.has(v["slot"])) return null;
  if (!v["root"] || typeof v["root"] !== "object" || Array.isArray(v["root"])) return null;

  // Walk the tree collecting violations; short-circuit on first.
  const violations: string[] = [];
  let nodeCount = 0;

  function walkNode(node: unknown, depth: number): void {
    if (violations.length > 0) return;

    if (!node || typeof node !== "object" || Array.isArray(node)) {
      violations.push("node must be a plain object");
      return;
    }

    nodeCount++;
    if (nodeCount > MAX_NODES) {
      violations.push(`node count exceeds ${MAX_NODES}`);
      return;
    }
    if (depth > MAX_DEPTH) {
      violations.push(`depth exceeds ${MAX_DEPTH}`);
      return;
    }

    const n = node as Record<string, unknown>;

    if (typeof n["type"] !== "string" || n["type"].length === 0) {
      violations.push("node.type must be a non-empty string");
      return;
    }

    if (n["props"] !== undefined) {
      const props = n["props"];
      if (!props || typeof props !== "object" || Array.isArray(props)) {
        violations.push("node.props must be a plain object");
        return;
      }
      for (const val of Object.values(props as Record<string, unknown>)) {
        if (Array.isArray(val) && val.length > MAX_ARRAY) {
          violations.push(`props array length exceeds ${MAX_ARRAY}`);
          return;
        }
      }
    }

    if (n["children"] !== undefined) {
      const children = n["children"];
      if (!Array.isArray(children)) {
        violations.push("node.children must be an array");
        return;
      }
      if (children.length > MAX_ARRAY) {
        violations.push(`children array length exceeds ${MAX_ARRAY}`);
        return;
      }
      for (const child of children) {
        if (violations.length > 0) return;
        walkNode(child, depth + 1);
      }
    }
  }

  walkNode(v["root"], 1);
  if (violations.length > 0) return null;

  return parsed as PluginUIView;
}
