import { m } from "#lib/paraglide/messages.js";
import type { FileTarget } from "#lib/types.js";

/**
 * Host-path links in agent Markdown (#3997). Agents link files they wrote on the Shepherd host
 * (`[report](/home/u/.local/state/x/report.md)`); followed from the HUD, that is an origin-relative
 * URL that leads nowhere. The sanitizer turns such a link into a non-navigating `.md-hostpath`
 * span; MarkdownBody adds a copy button and, in the session chat, an "open in Files" upgrade.
 */

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s; // malformed escape — keep it raw
  }
}

/** Drop a `?query` / `#fragment` (line anchors like `#L10`), then percent-decode. */
const bare = (s: string): string => decode(s.replace(/[?#].*$/s, ""));

/** The host filesystem path an href names, or null when it is a real URL / fragment / relative. */
export function localPathOf(href: string): string | null {
  const h = href.trim();
  if (/^file:/i.test(h)) {
    try {
      const u = new URL(h);
      if (u.host !== "" && u.host !== "localhost") return null;
      return decode(u.pathname) || null;
    } catch {
      return null;
    }
  }
  if (h.startsWith("~/")) return bare(h);
  if (h.startsWith("/") && !h.startsWith("//")) return bare(h) || null;
  return null;
}

/** Swap every sanitizer-marked `a[data-local-path]` for a non-navigating span with a host hint.
 *  Built here from the anchor's own (already sanitized) children plus textContent/setAttribute. */
export function defuseLocalPathLinks(root: DocumentFragment | Element): void {
  for (const a of root.querySelectorAll("a[data-local-path]")) {
    const path = a.getAttribute("data-local-path")!;
    const span = document.createElement("span");
    span.className = "md-hostpath";
    span.setAttribute("data-local-path", path);
    span.title = m.markdown_host_path_hint({ path });
    span.append(...a.childNodes);
    a.replaceWith(span);
  }
}

const COPY_ICON =
  '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>';
const CHECK_ICON = '<path d="M20 6 9 17l-5-5"/>';

function icon(paths: string, cls: string): SVGSVGElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [k, v] of Object.entries({
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    class: cls,
  }))
    el.setAttribute(k, v);
  el.innerHTML = paths; // constants only
  return el;
}

/** Give each `.md-hostpath` a trailing copy button (built from constants; the path rides a data
 *  attribute read back on click). Idempotent per element. */
export function decorateHostPaths(root: Element): void {
  for (const span of root.querySelectorAll(".md-hostpath")) {
    if (span.nextElementSibling?.matches("button[data-copy-path]")) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "icon-btn md-copy-path";
    btn.setAttribute("data-copy-path", span.getAttribute("data-local-path") ?? "");
    btn.title = m.markdown_copy_host_path();
    btn.setAttribute("aria-label", m.markdown_copy_host_path());
    btn.append(icon(COPY_ICON, "md-copy-icon"), icon(CHECK_ICON, "md-check-icon"));
    span.after(btn);
  }
}

/** Unique host paths marked in `root`. */
export function hostPathsIn(root: Element): string[] {
  const out = new Set<string>();
  for (const el of root.querySelectorAll(".md-hostpath[data-local-path]"))
    out.add(el.getAttribute("data-local-path")!);
  return [...out];
}

/** Upgrade each `.md-hostpath` whose path resolved into a Files-tab target to an "open in Files"
 *  button (a `host` target: "open read-only view", #4017). Returns whether anything changed. */
export function upgradeHostPaths(
  root: Element,
  resolved: ReadonlyMap<string, FileTarget | null>,
): boolean {
  let changed = false;
  for (const span of root.querySelectorAll(".md-hostpath[data-local-path]")) {
    const t = resolved.get(span.getAttribute("data-local-path")!);
    if (!t) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "md-filelink";
    btn.setAttribute("data-local-path", span.getAttribute("data-local-path")!);
    btn.setAttribute("data-open-file", "");
    btn.setAttribute("data-source", t.source);
    btn.setAttribute("data-rel", t.path);
    btn.setAttribute("data-type", t.type);
    btn.title = t.source === "host" ? m.markdown_open_host_file() : m.markdown_open_in_files();
    btn.append(...span.childNodes);
    span.replaceWith(btn);
    changed = true;
  }
  return changed;
}

/** Read a FileTarget back off an upgraded button. */
export function fileTargetOf(btn: Element): FileTarget {
  const source = btn.getAttribute("data-source");
  return {
    source: source === "worktree" || source === "host" ? source : "scratchpad",
    path: btn.getAttribute("data-rel") ?? "",
    type: btn.getAttribute("data-type") === "dir" ? "dir" : "file",
  };
}

/** Memoize a per-session host-path lookup: one request per (session, path); a failure counts as
 *  "not in the Files tab". */
export function memoLocate(
  locate: (sessionId: string, path: string) => Promise<FileTarget | null>,
): (sessionId: string, path: string) => Promise<FileTarget | null> {
  const cache = new Map<string, Promise<FileTarget | null>>();
  return (sessionId, path) => {
    const key = `${sessionId}\0${path}`;
    let hit = cache.get(key);
    if (!hit) {
      hit = locate(sessionId, path).catch(() => null);
      cache.set(key, hit);
    }
    return hit;
  };
}
