// Seam validator for plugin-authored declarative UI descriptors (issue #1185).
// Never throws; returns a normalized PluginUIView (re-parsed JSON) or null (invalid).

import type { PluginGearAction, PluginGearItem, PluginUIView } from "./types";

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

/** Per-type validation for the interactive `action-button` node (issue #1209). The host POSTs
 *  the plugin-authored `body` verbatim to `/api/plugins/<thisPluginId>/<route.path>`, so the
 *  route is hard-validated: method MUST be POST (a GET fetch with a body throws), and the path
 *  is namespace-relative (no leading `/`, no `..`) via the same `validRoutePath` the gear route
 *  action uses. Invalid → the whole view is dropped fail-open, consistent with the tree's
 *  all-or-nothing semantics. `body`/`confirm`/`tone`/`label` carry no extra structural checks
 *  here (the renderer coerces them defensively); `body` is bounded by the overall byte cap. */
function validActionButtonProps(props: Record<string, unknown>): boolean {
  const label = props["label"];
  if (typeof label !== "string" || label.trim().length === 0) return false;
  const route = props["route"];
  if (!isPlainObject(route)) return false;
  if (route["method"] !== "POST") return false;
  const path = route["path"];
  if (typeof path !== "string" || !validRoutePath(path)) return false;
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

  // Interactive node: validate its route up front (security-relevant — see helper).
  if (
    node["type"] === "action-button" &&
    !validActionButtonProps(isPlainObject(props) ? props : {})
  )
    return false;

  const children = node["children"];
  if (children === undefined) return true;
  if (!Array.isArray(children) || children.length > MAX_ARRAY) return false;
  return children.every((child) => validateNode(child, depth + 1, counter));
}

/** Guards against a large gear item payload — a gear item is tiny in practice. */
const MAX_GEAR_BYTES = 8 * 1024; // 8 KB

/** Validate a `kind:"route"` action path: non-empty, safe charset, no leading `/`, no `..`. */
function validRoutePath(path: string): boolean {
  if (path.length === 0 || path.length > 256) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(path)) return false;
  if (path.startsWith("/")) return false;
  return !path.split("/").some((seg) => seg === "..");
}

/** Validate a `kind:"url"` action: absolute http/https only; returns the normalized href. */
function validateUrlAction(raw: Record<string, unknown>): PluginGearAction | null {
  const href = raw["href"];
  if (typeof href !== "string") return null;
  try {
    const u = new URL(href);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return { kind: "url", href: u.href };
  } catch {
    return null;
  }
}

/** Validate a `kind:"route"` action: method GET/POST + a safe relative path. */
function validateRouteAction(raw: Record<string, unknown>): PluginGearAction | null {
  const method = raw["method"];
  const path = raw["path"];
  if (method !== "GET" && method !== "POST") return null;
  if (typeof path !== "string" || !validRoutePath(path)) return null;
  return { kind: "route", method, path };
}

/** Validate and normalize the action sub-object of a gear item. */
function validateGearAction(raw: unknown): PluginGearAction | null {
  if (!isPlainObject(raw)) return null;
  switch (raw["kind"]) {
    case "panel":
      return { kind: "panel" };
    case "url":
      return validateUrlAction(raw);
    case "route":
      return validateRouteAction(raw);
    default:
      return null;
  }
}

/** Validate and normalize a plugin-authored gear-menu item.
 *  Returns the re-parsed (normalized) PluginGearItem on success, or null if invalid.
 *  NEVER throws — invalid publishGearItem calls are dropped fail-open. */
export function validatePluginGearItem(item: unknown): PluginGearItem | null {
  // 1. Serializability: catches cycles / BigInt.
  let s: string;
  try {
    const raw = JSON.stringify(item);
    if (raw === undefined) return null;
    s = raw;
  } catch {
    return null;
  }

  // 2. Byte-size cap.
  if (Buffer.byteLength(s, "utf8") > MAX_GEAR_BYTES) return null;

  // 3. Re-parse then validate shape.
  const parsed = JSON.parse(s) as unknown;
  if (!isPlainObject(parsed)) return null;

  // label: non-empty after trim, length ≤ 80 (store original, reject if trimmed empty).
  const label = parsed["label"];
  if (typeof label !== "string" || label.trim().length === 0 || label.length > 80) return null;

  // icon: optional; if present must be string ≤ 8 chars.
  const icon = parsed["icon"];
  if (icon !== undefined) {
    if (typeof icon !== "string" || icon.length > 8) return null;
  }

  // action: required.
  const action = validateGearAction(parsed["action"]);
  if (action === null) return null;

  const result: PluginGearItem = { label, action };
  if (icon !== undefined) result.icon = icon;
  return result;
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
