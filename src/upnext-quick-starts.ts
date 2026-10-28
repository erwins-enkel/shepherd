/**
 * Up Next quick-start presets (#3507): per coding CLI a fixed model + effort that one click next to
 * "Start…" launches with, no picker. Stored server-side so web, Mac and iOS read the same preset.
 * NO I/O.
 *
 *   - A missing CLI key = never set up; `enabled: false` = set up but hidden.
 *   - `model` / `effort` null = the CLI's own default.
 *   - A patch replaces each CLI it names as a whole entry and leaves the others alone.
 */
import { effortsForProvider } from "./default-effort";
import { AGENT_PROVIDERS, MODELS_BY_PROVIDER, type AgentProvider } from "./types";

export const UPNEXT_QUICK_STARTS_SETTING = "upnextQuickStarts";

export interface UpNextQuickStart {
  enabled: boolean;
  model: string | null;
  effort: string | null;
}

export type UpNextQuickStarts = Partial<Record<AgentProvider, UpNextQuickStart>>;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** Validate one CLI's entry. `model` / `effort` may be absent or null (= CLI default). */
function parseEntry(provider: AgentProvider, raw: unknown): Parsed<UpNextQuickStart> {
  const at = `${UPNEXT_QUICK_STARTS_SETTING}.${provider}`;
  if (!isRecord(raw)) return { ok: false, error: `${at} must be an object` };
  for (const key of Object.keys(raw)) {
    if (key !== "enabled" && key !== "model" && key !== "effort") {
      return { ok: false, error: `${at}.${key} is not a known field` };
    }
  }
  if (typeof raw.enabled !== "boolean") {
    return { ok: false, error: `${at}.enabled must be a boolean` };
  }
  const model = raw.model ?? null;
  if (
    model !== null &&
    (typeof model !== "string" || !MODELS_BY_PROVIDER[provider].includes(model))
  ) {
    return { ok: false, error: `${at}.model must be null or a known ${provider} model` };
  }
  const effort = raw.effort ?? null;
  if (
    effort !== null &&
    (typeof effort !== "string" || !effortsForProvider(provider).includes(effort))
  ) {
    return { ok: false, error: `${at}.effort must be null or a ${provider} effort tier` };
  }
  return { ok: true, value: { enabled: raw.enabled, model, effort } };
}

/** Validate a patch and merge it onto `current`; keys come out in AGENT_PROVIDERS order. */
export function parseUpNextQuickStartsPatch(
  raw: unknown,
  current: UpNextQuickStarts,
): Parsed<UpNextQuickStarts> {
  if (!isRecord(raw) || Object.keys(raw).length === 0) {
    return { ok: false, error: `${UPNEXT_QUICK_STARTS_SETTING} must be a non-empty object` };
  }
  for (const key of Object.keys(raw)) {
    if (!(AGENT_PROVIDERS as readonly string[]).includes(key)) {
      return { ok: false, error: `${UPNEXT_QUICK_STARTS_SETTING}.${key} is not a known CLI` };
    }
  }
  const next: UpNextQuickStarts = {};
  for (const provider of AGENT_PROVIDERS) {
    if (Object.hasOwn(raw, provider)) {
      const entry = parseEntry(provider, raw[provider]);
      if (!entry.ok) return entry;
      next[provider] = entry.value;
    } else if (current[provider]) {
      next[provider] = current[provider];
    }
  }
  return { ok: true, value: next };
}

/** The persisted presets; an entry that no longer validates is dropped, a corrupt row reads `{}`. */
export function storedUpNextQuickStarts(stored: string | null | undefined): UpNextQuickStarts {
  if (!stored) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(stored);
  } catch {
    return {};
  }
  if (!isRecord(raw)) return {};
  const out: UpNextQuickStarts = {};
  for (const provider of AGENT_PROVIDERS) {
    if (!Object.hasOwn(raw, provider)) continue;
    const entry = parseEntry(provider, raw[provider]);
    if (entry.ok) out[provider] = entry.value;
  }
  return out;
}
