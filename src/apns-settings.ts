// The APNs credentials behind native iOS push (#2696), set up from Settings → Notifications
// instead of only through SHEPHERD_APNS_* in the environment.
//
// Storage: one JSON file at mode 0600 beside the db (`apns.json`), written atomically like the
// plugin secret store — not a row in the `settings` table, which every backup and debug dump
// carries next to ordinary values. Not encrypted with the cookie secret either: that secret lives
// in the same place as this file, so encryption would add a key-rotation hazard (rotating the
// secret silently bricks push) without keeping the key from anyone who can read the directory.
//
// The environment still wins field by field, the way VAPID and HOST_NAME do: a deployment that
// sets SHEPHERD_APNS_KEY keeps it, and the dialog shows that field as locked. No route ever
// returns the key — `status()` says only whether one is on file.

import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { parseApnsKey, type ApnsFailure, type ApnsKeyError, type ApnsSender } from "./apns";
import { writeSecretsFile } from "./plugins/secrets";

const DEFAULT_APNS_TOPIC = "run.shepherd.ios";

export const APNS_FIELDS = ["key", "keyId", "teamId", "topic"] as const;
export type ApnsField = (typeof APNS_FIELDS)[number];

/** The SHEPHERD_APNS_* values; null where the variable is unset. */
export type ApnsEnv = Record<ApnsField, string | null>;

interface StoredApns {
  key?: string;
  keyId?: string;
  teamId?: string;
  topic?: string;
  /** When the stored key was last replaced (epoch ms). */
  keySavedAt?: number;
}

/** Apple's key and team IDs are both ten upper-case letters or digits. */
const APPLE_ID_RE = /^[A-Z0-9]{10}$/;
/** A bundle identifier, the only thing APNs accepts as a topic for alert pushes. */
const TOPIC_RE = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

export type ApnsSaveErrorCode =
  | "env_locked"
  | "key_required"
  | ApnsKeyError
  | "key_id_invalid"
  | "team_id_invalid"
  | "topic_invalid";

export interface ApnsSaveError {
  error: ApnsSaveErrorCode;
  field: ApnsField;
}

export type ApnsSaveInput = Partial<Record<ApnsField, string>>;

export interface ApnsStatus {
  /** `error`: a key that cannot sign, or APNs refused the last send after the last delivery. */
  state: "unconfigured" | "configured" | "error";
  /** A key is on file (stored or from the environment) — never the key itself. */
  hasKey: boolean;
  keyId: string | null;
  teamId: string | null;
  topic: string;
  /** When the stored key was saved; null when there is none or the environment supplies it. */
  keySavedAt: number | null;
  /** Fields the environment sets; the dialog shows them read-only. */
  env: Record<ApnsField, boolean>;
  keyError: ApnsKeyError | null;
  lastError: ApnsFailure | null;
  lastDeliveredAt: number | null;
}

function isStored(v: unknown): v is StoredApns {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (
    APNS_FIELDS.every((f) => o[f] === undefined || typeof o[f] === "string") &&
    (o.keySavedAt === undefined || typeof o.keySavedAt === "number")
  );
}

export class ApnsSettings {
  private stored: StoredApns = {};

  constructor(
    private readonly path: string,
    private readonly env: ApnsEnv,
    private readonly sender: ApnsSender,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Read the stored credentials once at boot and hand the merged result to the sender. A missing
   *  file is the normal unconfigured case; a broken one is reported and then ignored, so the next
   *  save from the dialog replaces it. */
  load(): void {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (!isStored(parsed)) throw new Error("not an APNs credentials object");
      this.stored = parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[apns] ignoring ${this.path}:`, (err as Error).message);
      }
      this.stored = {};
    }
    this.apply();
  }

  private value(field: ApnsField, stored: StoredApns = this.stored): string | null {
    return this.env[field] ?? stored[field] ?? null;
  }

  private apply(): void {
    this.sender.reload({
      key: this.value("key"),
      keyId: this.value("keyId"),
      teamId: this.value("teamId"),
      topic: this.value("topic") ?? DEFAULT_APNS_TOPIC,
    });
  }

  status(): ApnsStatus {
    const { keyError, lastError, lastDeliveredAt } = this.sender;
    const failing =
      keyError !== null ||
      (lastError !== null && (lastDeliveredAt === null || lastError.at > lastDeliveredAt));
    let state: ApnsStatus["state"] = "unconfigured";
    if (failing) state = "error";
    else if (this.sender.enabled) state = "configured";
    return {
      state,
      hasKey: this.value("key") !== null,
      keyId: this.value("keyId"),
      teamId: this.value("teamId"),
      topic: this.value("topic") ?? DEFAULT_APNS_TOPIC,
      keySavedAt: this.env.key === null ? (this.stored.keySavedAt ?? null) : null,
      env: {
        key: this.env.key !== null,
        keyId: this.env.keyId !== null,
        teamId: this.env.teamId !== null,
        topic: this.env.topic !== null,
      },
      keyError,
      lastError,
      lastDeliveredAt,
    };
  }

  /** Validate and store the given fields; fields left out keep their stored value. Nothing is
   *  written unless the merged result is a complete, usable configuration. */
  async save(input: ApnsSaveInput): Promise<ApnsStatus | ApnsSaveError> {
    const locked = APNS_FIELDS.find((f) => input[f] !== undefined && this.env[f] !== null);
    if (locked) return { error: "env_locked", field: locked };
    const next = this.merge(input);
    if ("error" in next) return next;
    const invalid = this.validate(next);
    if (invalid) return invalid;

    await writeSecretsFile(this.path, JSON.stringify(next, null, 2) + "\n");
    this.stored = next; // commit to memory only once it is durably on disk
    this.apply();
    return this.status();
  }

  /** The stored credentials with `input` applied; an empty key keeps the stored one. */
  private merge(input: ApnsSaveInput): StoredApns | ApnsSaveError {
    const next: StoredApns = { ...this.stored };
    const key = input.key?.trim();
    if (key) {
      // PEM text only: a request never names a file for the server to read.
      const parsed = parseApnsKey(key);
      if (typeof parsed === "string") return { error: parsed, field: "key" };
      next.key = key + "\n";
      next.keySavedAt = this.now();
    }
    if (input.keyId !== undefined) next.keyId = input.keyId.trim().toUpperCase();
    if (input.teamId !== undefined) next.teamId = input.teamId.trim().toUpperCase();
    const topic = input.topic?.trim();
    if (topic === "" || topic === DEFAULT_APNS_TOPIC) delete next.topic;
    else if (topic !== undefined) next.topic = topic;
    return next;
  }

  /** Whether the merged result, under the environment, is a complete and usable configuration. */
  private validate(next: StoredApns): ApnsSaveError | null {
    if (this.value("key", next) === null) return { error: "key_required", field: "key" };
    if (!APPLE_ID_RE.test(this.value("keyId", next) ?? "")) {
      return { error: "key_id_invalid", field: "keyId" };
    }
    if (!APPLE_ID_RE.test(this.value("teamId", next) ?? "")) {
      return { error: "team_id_invalid", field: "teamId" };
    }
    if (!TOPIC_RE.test(this.value("topic", next) ?? DEFAULT_APNS_TOPIC)) {
      return { error: "topic_invalid", field: "topic" };
    }
    return null;
  }

  /** Forget the stored credentials. Values from the environment stay in force. */
  async remove(): Promise<ApnsStatus> {
    await rm(this.path, { force: true });
    this.stored = {};
    this.apply();
    return this.status();
  }
}
