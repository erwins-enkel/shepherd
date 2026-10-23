/**
 * This Shepherd's own identity as other Shepherds see it (issue #2759) — what `GET /api/instance`
 * serves and what a coordinator compares when it connects this instance as a machine.
 *
 * The instance ID is generated once and persisted in the `settings` table, so it survives
 * restarts and upgrades; it is what remote rows (and later, mirrored sessions) are keyed by. It is
 * NOT the per-launch `localInstall.instanceID` marker `/api/health` carries for the native app's
 * local supervision — that one changes every launch and proves nothing about identity.
 */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { SessionStore } from "../store";
import { SHEPHERD_VERSION } from "../version";

/**
 * The federation API level this build speaks. A coordinator only treats a machine as compatible
 * when both sides report the SAME integer (strict, deliberately: both run the same codebase, and a
 * later slice can widen this to a range once there is a second level to be compatible with). Bump
 * it whenever a server-to-server route a connected machine relies on changes shape. 2 (#2772): a
 * task sent to a machine carries its `placement` record and names the machine as its `target`.
 */
// 3: load-based placement records include the new `load` basis.
export const FEDERATION_API_VERSION = 3;

/** Upper bound for this instance's name and for a machine's local label. */
export const INSTANCE_NAME_MAX = 64;

const ID_KEY = "instanceId";
const NAME_KEY = "instanceName";

type Store = Pick<SessionStore, "getSetting" | "setSetting" | "deleteSetting">;

export interface InstanceIdentity {
  instanceId: string;
  name: string;
  version: string;
  federationApi: number;
  /** `linux` | `macos` | `windows`; any other host platform passes through raw (open enum). */
  platform: string;
  /** `process.arch` verbatim (`x64`, `arm64`, …). */
  arch: string;
}

export function instancePlatform(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return platform;
}

/** First DNS label of the host name — `Kais-MBP.local` reads as `Kais-MBP`. */
export function defaultInstanceName(host: string = hostname()): string {
  return host.split(".")[0]!.trim().slice(0, INSTANCE_NAME_MAX) || "shepherd";
}

/** The persisted instance ID, created on first read. */
export function instanceId(store: Pick<Store, "getSetting" | "setSetting">): string {
  const existing = store.getSetting(ID_KEY);
  if (existing) return existing;
  const id = randomUUID();
  store.setSetting(ID_KEY, id);
  return id;
}

/** `platform` defaults to this host's; tests stand in for another one. */
export function instanceIdentity(
  store: Store,
  platform: string = instancePlatform(),
): InstanceIdentity {
  return {
    instanceId: instanceId(store),
    name: store.getSetting(NAME_KEY) ?? defaultInstanceName(),
    version: SHEPHERD_VERSION,
    federationApi: FEDERATION_API_VERSION,
    platform,
    arch: process.arch,
  };
}

/** `null` = fall back to the host name. */
export function setInstanceName(store: Store, name: string | null): void {
  if (name === null) store.deleteSetting(NAME_KEY);
  else store.setSetting(NAME_KEY, name);
}

/**
 * An optional display name from an untrusted body: `null` or blank ⇒ `null` (use the default), a
 * string of at most INSTANCE_NAME_MAX characters after trimming ⇒ that string, anything else ⇒
 * `undefined` (invalid). Shared by this instance's name and a machine's local label.
 */
export function parseOptionalName(raw: unknown): string | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "string") return undefined;
  const name = raw.trim();
  if (name.length === 0) return null;
  return name.length <= INSTANCE_NAME_MAX ? name : undefined;
}

/**
 * Who is mirroring (#3056): a Shepherd that mirrors this one sends its own ID and name with its
 * `/events?host=local` socket and its snapshot request, so the mirrored side can show who watches
 * it. Additive, so `FEDERATION_API_VERSION` stays: an older peer simply sends neither. The name is
 * percent-encoded — a header value must be Latin-1, and a name may hold any character.
 */
export const MIRROR_ID_HEADER = "x-shepherd-instance-id";
export const MIRROR_NAME_HEADER = "x-shepherd-instance-name";

/** The headers a mirror sends about itself; the mirrored side reads them in `incoming.ts`. */
export function mirrorIdentityHeaders(self: {
  instanceId: string;
  name: string;
}): Record<string, string> {
  return {
    [MIRROR_ID_HEADER]: self.instanceId,
    [MIRROR_NAME_HEADER]: encodeURIComponent(self.name),
  };
}

/** True for a plain object whose ONLY key is `key` — the house shape for single-field PATCHes. */
export function isSingleKeyBody<K extends string>(
  body: unknown,
  key: K,
): body is Record<K, unknown> {
  return (
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    Object.keys(body).length === 1 &&
    key in body
  );
}

/** Validate a `PATCH /api/instance` body. */
export function parseInstanceNamePatch(body: unknown): { name: string | null } | { error: string } {
  if (!isSingleKeyBody(body, "name")) return { error: "body must be {name: string | null}" };
  const name = parseOptionalName(body.name);
  if (name === undefined) return { error: `name must be at most ${INSTANCE_NAME_MAX} characters` };
  return { name };
}
