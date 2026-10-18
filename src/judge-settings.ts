// The decision model's connection (#3071): the JEV key plus model, base URL and timeout, set up
// from Settings → Decision model instead of only through the environment and a restart.
//
// Storage: one JSON file at mode 0600 beside the db (`judge.json`), written atomically like the
// APNs credentials and the plugin secret store — not a row in the `settings` table, which every
// backup and debug dump carries next to ordinary values. No route ever returns the key; `status()`
// says where it comes from and shows its last four characters.
//
// The environment still wins field by field (JEV_API_KEY, SHEPHERD_JUDGE_MODEL/_BASE_URL/
// _TIMEOUT_MS), and Settings shows those fields as locked.
//
// THE KEY IS BOUND TO ITS BASE URL. A stored key is only ever sent to the base URL it was verified
// against (`keyBaseUrl`). Without that, an operator session that may not READ the key could still
// point the base URL at a foreign host and press Test — and the key would travel there. So
// `key()` refuses a stored key whose binding no longer matches, a save that moves the base URL
// away from an in-force stored key must carry a new key, and an environment key pins the base URL
// to the environment as well.
//
// A save that brings a key verifies it first and writes nothing unless the backend accepted it.
// The client is rebuilt after every change, so a save needs no restart: every consumer reads
// `client()` per use.

import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { JudgeError, type Judge } from "./judge";
import type {
  TypeSafeJudgeOptions,
  TypeSafeProbeOptions,
  TypeSafeProbeResult,
} from "./judge-typesafe";
import { writeSecretsFile } from "./plugins/secrets";

export const DEFAULT_JUDGE_MODEL = "jev-1.13.0";
export const DEFAULT_JUDGE_BASE_URL = "https://api.typesafe.ai";
const DEFAULT_JUDGE_DEADLINE_MS = 8_000;
const JUDGE_TIMEOUT_MIN_MS = 1_000;
const JUDGE_TIMEOUT_MAX_MS = 60_000;

export const JUDGE_FIELDS = ["key", "model", "baseUrl", "timeoutMs"] as const;
export type JudgeField = (typeof JUDGE_FIELDS)[number];

/** The environment's values; null where the variable is unset. */
export interface JudgeEnv {
  key: string | null;
  model: string | null;
  baseUrl: string | null;
  timeoutMs: number | null;
}

interface StoredJudge {
  key?: string;
  /** The base URL the key was verified against — the only one it is ever sent to. */
  keyBaseUrl?: string;
  /** When the stored key was last replaced (epoch ms). */
  keySavedAt?: number;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export type JudgeVerifyResult = "ok" | "rejected" | "unreachable";

export interface JudgeConnectionStatus {
  /** Where the key in force comes from. A stored key bound to another base URL counts as none. */
  keySource: "env" | "stored" | "none";
  /** The last four characters of the key in force, for recognising it; null for keys under 12. */
  keyLast4: string | null;
  /** When the stored key in force was saved; null for an environment key or none. */
  keySavedAt: number | null;
  /** Host of a stored key that is NOT used because the base URL moved away from it. */
  staleKeyHost: string | null;
  /** The last check of the key in force (Save & verify or Test). In memory only. */
  lastVerify: { result: JudgeVerifyResult; at: number; status: number | null } | null;
  /** Model names the account can use, from the last successful check. In memory only. */
  models: string[];
  model: string;
  baseUrl: string;
  timeoutMs: number;
  defaults: { model: string; baseUrl: string; timeoutMs: number };
  /** Fields the environment sets; Settings shows them read-only. */
  env: Record<JudgeField, boolean>;
  /** The last 401/403 a real judge call got, cleared by the next success. In memory only. */
  authFailure: { status: number; at: number } | null;
  /** When a real judge call last succeeded. In memory only. */
  lastOkAt: number | null;
}

export type JudgeSaveErrorCode =
  | "env_locked"
  | "key_invalid"
  | "model_invalid"
  | "base_url_invalid"
  | "timeout_invalid"
  | "key_required"
  | "key_rejected"
  | "unreachable";

export interface JudgeSaveError {
  error: JudgeSaveErrorCode;
  field: JudgeField;
  /** The backend's HTTP status for `key_rejected` / `unreachable`, when it answered at all. */
  status?: number | null;
}

export interface JudgeSaveInput {
  key?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export interface JudgeSettingsDeps {
  /** Checks a key without spending anything (`probeTypeSafeKey`). */
  probe: (options: TypeSafeProbeOptions) => Promise<TypeSafeProbeResult>;
  /** Builds the client (`createTypeSafeJudge`). */
  createJudge: (options: TypeSafeJudgeOptions) => Judge;
  now?: () => number;
}

/** Printable ASCII without spaces. No vendor prefix is assumed: the format is the vendor's. */
const KEY_RE = /^[\x21-\x7e]{8,512}$/;
/** A snapshot name like `jev-1.13.0`. */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;

/** An http(s) API root without credentials, query or fragment, trailing slashes dropped; null
 *  when `raw` is not one. */
export function normalizeJudgeBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return url.href.replace(/\/+$/, "");
}

// The per-field halves of `JudgeSettings.merge`. A value equal to the default is not stored, so a
// later change of the default reaches everyone who never chose otherwise.

function mergeModel(next: StoredJudge, raw: string | undefined): JudgeSaveError | null {
  if (raw === undefined) return null;
  const model = raw.trim();
  if (model !== "" && !MODEL_RE.test(model)) return { error: "model_invalid", field: "model" };
  if (model === "" || model === DEFAULT_JUDGE_MODEL) delete next.model;
  else next.model = model;
  return null;
}

function mergeBaseUrl(next: StoredJudge, raw: string | undefined): JudgeSaveError | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  const url = trimmed === "" ? DEFAULT_JUDGE_BASE_URL : normalizeJudgeBaseUrl(trimmed);
  if (url === null) return { error: "base_url_invalid", field: "baseUrl" };
  if (url === DEFAULT_JUDGE_BASE_URL) delete next.baseUrl;
  else next.baseUrl = url;
  return null;
}

function mergeTimeout(next: StoredJudge, ms: number | undefined): JudgeSaveError | null {
  if (ms === undefined) return null;
  if (!Number.isInteger(ms) || ms < JUDGE_TIMEOUT_MIN_MS || ms > JUDGE_TIMEOUT_MAX_MS) {
    return { error: "timeout_invalid", field: "timeoutMs" };
  }
  if (ms === DEFAULT_JUDGE_DEADLINE_MS) delete next.timeoutMs;
  else next.timeoutMs = ms;
  return null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function isStored(v: unknown): v is StoredJudge {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  const optional = (k: string, type: "string" | "number") =>
    o[k] === undefined || typeof o[k] === type;
  return (
    ["key", "keyBaseUrl", "model", "baseUrl"].every((k) => optional(k, "string")) &&
    ["keySavedAt", "timeoutMs"].every((k) => optional(k, "number")) &&
    // A key without its binding could be sent anywhere — such a file is not ours to trust.
    (o.key === undefined || typeof o.keyBaseUrl === "string")
  );
}

export class JudgeSettings {
  private stored: StoredJudge = {};
  private current: Judge | null = null;
  private lastVerify: JudgeConnectionStatus["lastVerify"] = null;
  private models: string[] = [];
  private authFailure: JudgeConnectionStatus["authFailure"] = null;
  private lastOkAt: number | null = null;
  private readonly now: () => number;

  constructor(
    private readonly path: string,
    private readonly env: JudgeEnv,
    private readonly deps: JudgeSettingsDeps,
  ) {
    this.now = deps.now ?? Date.now;
  }

  /** Read the stored connection once at boot and build the client. A missing file is the normal
   *  unconfigured case; a broken one is reported and then ignored, so the next save replaces it.
   *  The report never carries the parse error: its text can quote the file, key included. */
  load(): void {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (!isStored(parsed)) throw new Error("shape");
      this.stored = parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[judge] ignoring ${this.path}: not a readable decision-model connection`);
      }
      this.stored = {};
    }
    this.rebuild();
  }

  /** The model, base URL and per-call deadline in force. */
  effective(stored: StoredJudge = this.stored): {
    model: string;
    baseUrl: string;
    deadlineMs: number;
  } {
    const envUrl = this.env.baseUrl;
    // An environment key never goes to a stored base URL: that address was set without the key
    // being checked against it — possibly before the key was even there.
    const storedUrl = this.env.key === null ? stored.baseUrl : undefined;
    return {
      model: this.env.model ?? stored.model ?? DEFAULT_JUDGE_MODEL,
      baseUrl:
        (envUrl === null ? null : (normalizeJudgeBaseUrl(envUrl) ?? envUrl)) ??
        storedUrl ??
        DEFAULT_JUDGE_BASE_URL,
      deadlineMs: this.env.timeoutMs ?? stored.timeoutMs ?? DEFAULT_JUDGE_DEADLINE_MS,
    };
  }

  /** The key in force: the environment's, else a stored key still bound to the base URL. */
  private key(): string | null {
    if (this.env.key !== null) return this.env.key;
    const { key, keyBaseUrl } = this.stored;
    return key !== undefined && keyBaseUrl === this.effective().baseUrl ? key : null;
  }

  hasKey(): boolean {
    return this.key() !== null;
  }

  /** The judge client, or null without a usable key. Rebuilt on every change — read it per use. */
  client(): Judge | null {
    return this.current;
  }

  private locked(field: JudgeField): boolean {
    // An environment key pins its base URL to the environment too: a UI-set URL is where the key
    // would go, and the environment's key was never verified against one.
    return this.env[field] !== null || (field === "baseUrl" && this.env.key !== null);
  }

  private rebuild(): void {
    const key = this.key();
    if (key === null) {
      this.current = null;
      return;
    }
    const { model, baseUrl, deadlineMs } = this.effective();
    let inner: Judge;
    try {
      inner = this.deps.createJudge({ apiKey: key, baseUrl, model, deadlineMs });
    } catch (err) {
      // The SDK validates its configuration on construction. Its message is about the config, but
      // it is not ours to vouch for, so only the class is logged.
      console.warn(`[judge] could not build the decision-model client (${(err as Error).name})`);
      this.current = null;
      return;
    }
    // Every real call reports back, so Settings can say "key rejected" when the vendor starts
    // refusing a key that verified fine yesterday, and when the judge last answered.
    this.current = {
      ask: async (state, questions) => {
        try {
          const result = await inner.ask(state, questions);
          this.lastOkAt = this.now();
          this.authFailure = null;
          return result;
        } catch (err) {
          if (err instanceof JudgeError && (err.status === 401 || err.status === 403)) {
            this.authFailure = { status: err.status, at: this.now() };
          }
          throw err;
        }
      },
    };
  }

  status(): JudgeConnectionStatus {
    const key = this.key();
    const eff = this.effective();
    const { key: storedKey, keyBaseUrl } = this.stored;
    const stale =
      this.env.key === null && storedKey !== undefined && keyBaseUrl !== eff.baseUrl
        ? hostOf(keyBaseUrl ?? "")
        : null;
    let keySource: JudgeConnectionStatus["keySource"] = "none";
    if (this.env.key !== null) keySource = "env";
    else if (key !== null) keySource = "stored";
    return {
      keySource,
      keyLast4: key !== null && key.length >= 12 ? key.slice(-4) : null,
      keySavedAt: keySource === "stored" ? (this.stored.keySavedAt ?? null) : null,
      staleKeyHost: stale,
      lastVerify: this.lastVerify,
      models: [...this.models],
      model: eff.model,
      baseUrl: eff.baseUrl,
      timeoutMs: eff.deadlineMs,
      defaults: {
        model: DEFAULT_JUDGE_MODEL,
        baseUrl: DEFAULT_JUDGE_BASE_URL,
        timeoutMs: DEFAULT_JUDGE_DEADLINE_MS,
      },
      env: {
        key: this.env.key !== null,
        model: this.env.model !== null,
        baseUrl: this.env.baseUrl !== null,
        timeoutMs: this.env.timeoutMs !== null,
      },
      authFailure: this.authFailure,
      lastOkAt: this.lastOkAt,
    };
  }

  /** Validate and store the given fields; fields left out keep their stored value, and an empty
   *  model or base URL goes back to the default. A key is verified first and nothing is written
   *  unless the backend accepted it. */
  async save(input: JudgeSaveInput): Promise<JudgeConnectionStatus | JudgeSaveError> {
    const locked = JUDGE_FIELDS.find((f) => input[f] !== undefined && this.locked(f));
    if (locked) return { error: "env_locked", field: locked };
    const next = this.merge(input);
    if ("error" in next) return next;

    const nextEff = this.effective(next);
    const key = input.key?.trim() || null;
    let models: string[] | null = null;
    if (key !== null) {
      const probe = await this.deps.probe({
        apiKey: key,
        baseUrl: nextEff.baseUrl,
        deadlineMs: nextEff.deadlineMs,
      });
      if (!probe.ok) {
        return {
          error: probe.kind === "rejected" ? "key_rejected" : "unreachable",
          field: "key",
          status: probe.status,
        };
      }
      models = probe.models;
      next.key = key;
      next.keyBaseUrl = nextEff.baseUrl;
      next.keySavedAt = this.now();
    } else if (
      this.env.key === null &&
      this.stored.key !== undefined &&
      this.stored.keyBaseUrl === this.effective().baseUrl &&
      nextEff.baseUrl !== this.stored.keyBaseUrl
    ) {
      // The key would stop being used without anyone saying so. Ask for it again instead.
      return { error: "key_required", field: "baseUrl" };
    }

    await writeSecretsFile(this.path, JSON.stringify(next, null, 2) + "\n");
    this.stored = next; // commit to memory only once it is durably on disk
    if (models !== null) {
      this.lastVerify = { result: "ok", at: this.now(), status: null };
      this.models = models;
      this.authFailure = null;
      this.lastOkAt = null;
    }
    this.rebuild();
    return this.status();
  }

  /** The stored connection with `input` applied, or the first field that is not acceptable. */
  private merge(input: JudgeSaveInput): StoredJudge | JudgeSaveError {
    const key = input.key?.trim();
    if (key && !KEY_RE.test(key)) return { error: "key_invalid", field: "key" };
    const next: StoredJudge = { ...this.stored };
    // Each applies its field to `next` or names why it cannot; the first refusal wins.
    return (
      mergeModel(next, input.model) ??
      mergeBaseUrl(next, input.baseUrl) ??
      mergeTimeout(next, input.timeoutMs) ??
      next
    );
  }

  /** Check the key in force against the backend without spending anything. Null without a key. */
  async verify(): Promise<JudgeConnectionStatus | null> {
    const key = this.key();
    if (key === null) return null;
    const { baseUrl, deadlineMs } = this.effective();
    const probe = await this.deps.probe({ apiKey: key, baseUrl, deadlineMs });
    // The key may have been replaced while the check ran; its result says nothing about the new one.
    if (this.key() !== key) return this.status();
    if (probe.ok) {
      this.lastVerify = { result: "ok", at: this.now(), status: null };
      this.models = probe.models;
      this.authFailure = null;
    } else {
      this.lastVerify = { result: probe.kind, at: this.now(), status: probe.status };
    }
    return this.status();
  }

  /** Forget the stored key. Model, base URL and timeout stay, and the environment stays in force. */
  async remove(): Promise<JudgeConnectionStatus> {
    const rest: StoredJudge = { ...this.stored };
    delete rest.key;
    delete rest.keyBaseUrl;
    delete rest.keySavedAt;
    if (Object.keys(rest).length > 0) {
      await writeSecretsFile(this.path, JSON.stringify(rest, null, 2) + "\n");
    } else {
      await rm(this.path, { force: true });
    }
    this.stored = rest;
    if (this.env.key === null) {
      this.lastVerify = null;
      this.models = [];
      this.authFailure = null;
      this.lastOkAt = null;
    }
    this.rebuild();
    return this.status();
  }
}
