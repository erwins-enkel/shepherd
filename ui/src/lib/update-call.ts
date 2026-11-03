import { m } from "#lib/paraglide/messages.js";
import type { UpdateCallRecord } from "#lib/types.js";

/** Short, ordered: Edge and Opera carry "Chrome", Chrome carries "Safari". */
const BROWSERS: [RegExp, string][] = [
  [/\bEdg(e|A|iOS)?\//, "Edge"],
  [/\bOPR\//, "Opera"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\bChrome\/|\bCriOS\//, "Chrome"],
  [/\bSafari\//, "Safari"],
];

/** Ordered: Android carries "Linux", iOS carries "like Mac OS X". */
const SYSTEMS: [RegExp, string][] = [
  [/\bAndroid\b/, "Android"],
  [/\b(iPhone|iPad|iOS)\b/, "iOS"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bWindows\b/, "Windows"],
  [/\bLinux\b/, "Linux"],
];

const firstMatch = (table: [RegExp, string][], text: string) =>
  table.find(([re]) => re.test(text))?.[1];

/** "Firefox · Linux" from a User-Agent, so the raw string never reaches the UI. Product names stay
 *  untranslated; null when neither part is known. */
export function describeUserAgent(ua: string | null): string | null {
  if (!ua) return null;
  const parts = [firstMatch(BROWSERS, ua), firstMatch(SYSTEMS, ua)].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

function callerLabel(caller: UpdateCallRecord["caller"]): string {
  switch (caller.kind) {
    case "surface": {
      const device = describeUserAgent(caller.ua);
      return device ? m.update_origin_surface_device({ device }) : m.update_origin_surface();
    }
    case "token":
      if (caller.client === "cli") return m.update_origin_token_cli({ name: caller.name });
      if (caller.client === "relay") return m.update_origin_token_relay({ name: caller.name });
      return m.update_origin_token({ name: caller.name });
    case "env_token":
      if (caller.client === "cli") return m.update_origin_env_token_cli();
      if (caller.client === "relay") return m.update_origin_env_token_relay();
      return m.update_origin_env_token();
    case "script":
      return caller.tty ? m.update_origin_terminal() : m.update_origin_script();
    case "app":
      return m.update_origin_app();
    case "unknown":
      return m.update_origin_unknown();
  }
}

/** Who a record names. A session outranks its credential: an agent using the operator's token is
 *  still the agent, and the token stays visible behind it. */
export function updateCallOrigin(record: UpdateCallRecord): string {
  const caller = callerLabel(record.caller);
  if (!record.session) return caller;
  const session = record.session.desig ?? record.session.id.slice(0, 8);
  return m.update_origin_session({ session, caller });
}
