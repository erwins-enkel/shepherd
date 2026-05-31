import { readFileSync } from "node:fs";
import type { ForgeMap } from "./types";

/**
 * Load the per-host forge config from a JSON file. Missing or malformed files
 * yield an empty map (with a warning) so Shepherd never crashes on startup.
 */
export function loadForgeMap(path: string): ForgeMap {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {}; // absent file is normal
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ForgeMap;
    }
    console.warn(`[forge] ${path}: expected a JSON object of host→config; ignoring`);
    return {};
  } catch {
    console.warn(`[forge] ${path}: invalid JSON; ignoring`);
    return {};
  }
}
