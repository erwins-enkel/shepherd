import { dirname, join } from "node:path";
import { resolveNodeBin } from "./node-bin";
import { loadForgeMap } from "./forge/load-config";
import {
  normalizeDefaultCodexModelSetting,
  normalizeDefaultModelSetting,
  normalizeFableAvailable,
  normalizeRoleCli,
  normalizeRoleModelToken,
} from "./default-model";
import { normalizeDefaultEffortSetting, effortBelowHigh } from "./default-effort";
import { normalizeAuthModeSetting } from "./auth-mode";
import { normalizeAgentProvider } from "./agent-provider";
import { normalizeTelemetryConsent } from "./telemetry-consent";
import { normalizeOperatorLanguage } from "./operator-language";
import { type SandboxProfile, isSandboxProfile } from "./sandbox";
import { applyHerdrSocket } from "./herdr-session";

const dbPath = process.env.SHEPHERD_DB ?? `${process.env.HOME}/.shepherd/shepherd.db`;
// forge map sits next to the db by default; SHEPHERD_FORGES overrides the path.
const forgesPath = process.env.SHEPHERD_FORGES ?? join(dirname(dbPath), "forges.json");
// persistent herdr-update audit log: one delimited block per `herdr update`,
// written by the transient update unit itself (NOT shepherd) so the record
// survives the shepherd restart the update triggers. Lives next to the db so a
// post-mortem is `cat ~/.shepherd/herdr-update.log`; SHEPHERD_HERDR_UPDATE_LOG overrides.
const herdrUpdateLogPath =
  process.env.SHEPHERD_HERDR_UPDATE_LOG ?? join(dirname(dbPath), "herdr-update.log");
// persistent codex-update audit log, mirroring herdrUpdateLogPath: one delimited
// block per `codex update` (with npm fallback), written by the update child itself
// so `cat ~/.shepherd/codex-update.log` is a durable post-mortem. SHEPHERD_CODEX_UPDATE_LOG overrides.
const codexUpdateLogPath =
  process.env.SHEPHERD_CODEX_UPDATE_LOG ?? join(dirname(dbPath), "codex-update.log");
// Server-side plugin dir (issue #1124): private/out-of-repo extensions live here,
// alongside the db, so they survive `bun run update` and can never leak into the public
// repo. Default ~/.shepherd/plugins; SHEPHERD_PLUGINS_DIR overrides. A missing/empty dir
// loads nothing (the clean zero-plugin invariant).
const pluginsDir = process.env.SHEPHERD_PLUGINS_DIR ?? join(dirname(dbPath), "plugins");

// herdr session id ("default" for a single-session install; a named daemon otherwise) and
// the Unix-socket path for herdr's native JSON-RPC API (issue #1529). Resolved via the shared
// helper so it also guards the in-pane footgun (issue #1596): when Shepherd runs INSIDE a herdr
// pane (HERDR_ENV=1) and a non-`default` HERDR_SESSION disagrees with the pane-inherited
// HERDR_SOCKET_PATH, the explicit session wins and applyHerdrSocket rewrites
// process.env.HERDR_SOCKET_PATH so every spawned `herdr` CLI (which inherits process.env)
// agrees with the socket driver — otherwise a dev/test instance silently attaches to the
// parent pane's herd. Warns loudly on override; SHEPHERD_HERDR_IGNORE_SESSION=1 opts out.
const { session: herdrSession, socketPath: herdrSocketPath } = applyHerdrSocket(
  process.env,
  process.env.HOME ?? "",
);

// Two independent review caps, each how many reviewer→agent steer rounds a findings
// streak may spend before escalating to a human. Global, UI-configurable + persisted;
// the env seeds a fresh DB. The bounds are the single source of truth for the env seed,
// the boot-override clamp, and the PUT validators.
//
// PR review cap drives ReviewService (the PR critic auto-address rounds + the
// consecutive-error ceiling). Range [1,8]: MIN 1 guarantees at least one round; MAX 8
// gives headroom for noisier repos while still capping a runaway from ping-ponging.
// Plan review cap drives PlanGateService (the adversarial plan-gate rounds). Range
// [1,12]: planning tends to need a couple more passes, so it gets a higher ceiling.
export const PR_REVIEW_CYCLES_MIN = 1;
export const PR_REVIEW_CYCLES_MAX = 8;
export const PLAN_REVIEW_CYCLES_MIN = 1;
export const PLAN_REVIEW_CYCLES_MAX = 12;

// ── dependency-diagnostics advisory floors + cache/timeout knobs ────────────
// Single source of truth for the readiness-probe version floors (issue #623).
// Floors are ADVISORY: a below-floor toolchain is a `warning`, never an `error`
// — presence is the only hard gate. Seeded conservatively below the versions
// installed today (node 24.x, bun 1.3.x, herdr 0.7.x) so a typical install isn't
// warned on day one while a genuinely stale toolchain still flags.
export const NODE_MIN_VERSION = "20.0.0";
export const BUN_MIN_VERSION = "1.1.0";
export const HERDR_MIN_VERSION = "0.7.0";
// herdr's native Unix-socket JSON-RPC protocol is versioned and still preview-unstable
// (issue #1529) — admit only protocol numbers we've actually validated against a live
// herdr, never an open `>=` floor. Extend this set explicitly as new protocols are verified.
export const HERDR_SOCKET_SUPPORTED_PROTOCOLS = new Set([16]);
// TTL backing DiagnosticsService.current() — a request without ?refresh=1 reads
// this cache. Matches the existing CountsService/backlog 60s TTL.
export const DIAGNOSTICS_TTL_MS = 60_000;
// Background diagnostics re-check cadence (src/index.ts). ADAPTIVE: the steady-state
// interval is used while the last snapshot's `overall` is ok/warning; on an `error`
// snapshot the scheduler switches to the much shorter recheck interval so a transient
// hard error (canonically herdr `offline`) self-corrects within ~one recheck instead of
// staying pinned on the client — which seeds diagnostics once and thereafter only takes
// the `diagnostics:status` push (never re-GETs). Only `error` accelerates: a `warning`
// is steady-state by design (advisory version floors, gh-not-required on lightweight
// hosts) and must NOT drive a permanent fast poll. A `host_capacity` pressure error is
// likewise steady-state-ish and is EXEMPT from the acceleration (see nextDiagnosticsDelay):
// re-running the full probe fan-out every 60s would pile fork/exec load onto a host already
// under memory/IO pressure — the manual Diagnose "Re-run" is the on-demand live path instead.
export const DIAGNOSTICS_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const DIAGNOSTICS_RECHECK_INTERVAL_MS = 60_000;
// Per-probe exec timeout: a timed-out probe RESOLVES to its defined non-OK state
// (never rejects the Promise.all), so one hung binary can't stall the batch.
export const DIAGNOSTICS_PROBE_TIMEOUT_MS = 5_000;
// host_capacity probe thresholds (#1732). Kernel PSI avg10 is the % of the last 10s in
// which tasks were stalled on the resource — it is the AUTHORITATIVE live-pressure signal.
// swap-used alone is NOT dangerous (zram / proactive eviction sit at 90%+ swap with ~0 PSI),
// so a saturated swap only *corroborates* memory pressure by lowering the memory-PSI bar;
// it never triggers on its own. Seeded conservatively to avoid false `error`s.
export const HOST_SWAP_SATURATION_RATIO = 0.9; // swap saturated when used/total ≥ this
export const HOST_PSI_MEMORY_AVG10 = 10; // memory stalled ≥10% of last 10s ⇒ dangerous
export const HOST_PSI_MEMORY_AVG10_CORROBORATED = 5; // lower bar, only when swap is also saturated
export const HOST_PSI_IO_AVG10 = 20; // IO stall bar (higher; transient IO PSI is normal)
// gh auth probe hardening (#623 follow-up): `gh auth status` reads the token from the OS
// keyring, so a locked keyring / D-Bus stall / cold `gh` under load can transiently blow
// the probe budget and — pre-fix — masquerade as "not logged in". The probe now RETRIES a
// timed-out attempt and only reports a hard-auth error when gh actually exits with a
// verdict. A dedicated, SHORTER per-attempt timeout keeps the bounded retry loop from
// stalling the batch: GH_PROBE_ATTEMPTS × GH_PROBE_TIMEOUT_MS (+ delays) ≈ 6.25s worst case,
// vs. 3×5s if it reused DIAGNOSTICS_PROBE_TIMEOUT_MS. Healthy gh answers in ~0.25s.
export const GH_PROBE_ATTEMPTS = 2;
export const GH_PROBE_TIMEOUT_MS = 3_000;
export const GH_PROBE_RETRY_DELAY_MS = 250;
// Time budget for an in-app remediation command (POST /api/diagnostics/fix). Far
// larger than a probe — these are real `curl | bash` installs. On timeout the whole
// process GROUP is SIGKILLed (see diagnostics.ts runRemediation) so no reparented
// grandchild survives to flip a later probe green behind a reported failure.
export const REMEDIATION_TIMEOUT_MS = 120_000;
export const DISTILLER_INTERVAL_DAYS_MIN = 1;
export const DISTILLER_INTERVAL_DAYS_MAX = 14;
// module-local seed defaults, used by the config seeds + boot-override fallbacks only.
const PR_REVIEW_CYCLES_DEFAULT = 3;
const PLAN_REVIEW_CYCLES_DEFAULT = 5;
// Coerce any input (env/DB/request) to a valid integer cap, snapping out-of-range
// values into [min,max] rather than rejecting (callers stay forgiving); a non-finite
// input falls back to the supplied default.
export function clampCap(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// As clampCap, but WITHOUT the integer rounding — for ratio knobs (e.g. a CPU fraction, where
// clampCap would round 0.8 to 1). Same forgiving contract: non-finite falls back, else snap.
export function clampFraction(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// ── preview-port range ─────────────────────────────────────────────────────
// Single source of truth for the preview-port range; consumed by both the slot
// allocator (future PreviewService) and checkOrigin (origin hardening). The range
// is [previewPortBase, previewPortBase + previewPortCount).
//
// previewPortCount is BOTH the range size and the max concurrent previews — a
// single number, no secondary "max" constant anywhere else.

const LOOPBACK_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/;

/** Plain (non-array) object guard — arrays are typeof "object" but malformed here. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Public port from a "host:PORT" web-map key; 443 when absent/non-numeric. */
function publicPortFromKey(key: string): number {
  const i = key.lastIndexOf(":");
  if (i === -1) return 443;
  const p = Number(key.slice(i + 1));
  return Number.isFinite(p) ? p : 443;
}

/** Public host from a "host:PORT" web-map key (bare-host keys have no ":PORT" —
 *  the whole key IS the host); a trailing dot is stripped for parity with
 *  resolveNodeHost's own hostname normalization. */
function hostFromKey(key: string): string {
  const i = key.lastIndexOf(":");
  return (i === -1 ? key : key.slice(0, i)).replace(/\.$/, "");
}

/** Candidate web maps: top-level Web + each Services[svc].Web (arrays rejected, fail-closed). */
function collectWebMaps(root: Record<string, unknown>): Array<Record<string, unknown>> {
  const webMaps: Array<Record<string, unknown>> = [];
  if (isPlainObject(root["Web"])) webMaps.push(root["Web"]);
  const services = root["Services"];
  if (isPlainObject(services)) {
    for (const svc of Object.values(services)) {
      if (isPlainObject(svc) && isPlainObject(svc["Web"])) {
        webMaps.push(svc["Web"]);
      }
    }
  }
  return webMaps;
}

/** True when a handler's Proxy targets loopback:localPort. */
function handlerTargetsPort(handler: unknown, localPort: number): boolean {
  if (!isPlainObject(handler)) return false;
  const proxy = handler["Proxy"];
  if (typeof proxy !== "string") return false;
  const m = LOOPBACK_RE.exec(proxy);
  return m !== null && Number(m[1]) === localPort;
}

/** Public port if any handler in this web map targets localPort, else null. */
function servedPortInWebMap(webMap: Record<string, unknown>, localPort: number): number | null {
  for (const [key, entry] of Object.entries(webMap)) {
    if (!isPlainObject(entry)) continue;
    const handlers = entry["Handlers"];
    if (!isPlainObject(handlers)) continue;
    for (const handler of Object.values(handlers)) {
      if (handlerTargetsPort(handler, localPort)) return publicPortFromKey(key);
    }
  }
  return null;
}

/** Hosts of every web-map entry whose handler targets loopback:localPort. */
function servedHostsInWebMap(webMap: Record<string, unknown>, localPort: number): string[] {
  const hosts: string[] = [];
  for (const [key, entry] of Object.entries(webMap)) {
    if (!isPlainObject(entry)) continue;
    const handlers = entry["Handlers"];
    if (!isPlainObject(handlers)) continue;
    if (Object.values(handlers).some((handler) => handlerTargetsPort(handler, localPort))) {
      hosts.push(hostFromKey(key));
    }
  }
  return hosts;
}

/**
 * JSON-based parser for `tailscale serve status --json` output. Given the raw
 * JSON string and the HUD's local listen port, returns the public-facing HTTPS
 * port that Tailscale fronts that local port on, or null when no match is found.
 *
 * Detection covers two serve topologies:
 * - **Direct serve**: a mapping in the top-level `Web` object.
 * - **Tailscale Service**: a mapping nested under `Services[svc].Web`.
 *
 * For each web-map entry whose key is `"host:PORT"`, every handler whose
 * `.Proxy` URL targets a loopback address (`localhost` OR `127.0.0.1`) on
 * `localPort` is considered a match; the public port is the integer after the
 * LAST `:` in the entry's key (defaulting to 443 when no explicit port is
 * present). First match wins.
 *
 * Parsing is fully defensive — any malformed, empty, or non-JSON input returns
 * null without throwing.
 *
 * **Accepted trade-offs:**
 * - On a Tailscale too old to support `--json`, the `serve status --json` call
 *   typically exits non-zero; that rejection surfaces via the probe's *error*
 *   fallback (`diagnostics_hint_tailscale_missing`), not as a Warning. Only a
 *   zero-exit-but-unparseable payload reaches this parser and returns null →
 *   Warning. Either way a served HUD is mis-reported there — accepted, since
 *   Shepherd already requires a Service-capable Tailscale version.
 * - Loopback coverage is `localhost` + `127.0.0.1` only; `[::1]` is
 *   intentionally not matched (Tailscale always emits one of the two above).
 * - A pending/unapproved Service still shows its mapping in the JSON and so
 *   reads OK. The check is advisory, not a hard gate.
 */
export function findServedPort(serveStatusJson: string, localPort: number): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serveStatusJson);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  for (const webMap of collectWebMaps(parsed)) {
    const served = servedPortInWebMap(webMap, localPort);
    if (served !== null) return served;
  }
  return null;
}

/**
 * Companion to `findServedPort`: given the same `tailscale serve status --json`
 * output and the HUD's local listen port, returns every public host name that
 * fronts that local port — across the top-level `Web` map AND every
 * `Services[svc].Web` map (a Tailscale Service front, e.g. `svc:shepherd` →
 * `shepherd.ts.net:443` → `http://localhost:7330`). Reuses the same
 * `collectWebMaps`/`handlerTargetsPort` matching as `findServedPort` — only a
 * handler whose `.Proxy` targets loopback:localPort counts, so unrelated
 * services are excluded.
 *
 * Deduped; parsing is fully defensive — any malformed, empty, or non-JSON
 * input returns `[]` without throwing.
 */
export function findServedHosts(serveStatusJson: string, localPort: number): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serveStatusJson);
  } catch {
    return [];
  }
  if (!isPlainObject(parsed)) return [];
  const hosts: string[] = [];
  for (const webMap of collectWebMaps(parsed)) {
    for (const host of servedHostsInWebMap(webMap, localPort)) {
      if (!hosts.includes(host)) hosts.push(host);
    }
  }
  return hosts;
}

export interface PreviewPortRangeParams {
  previewPortBase: number;
  previewPortCount: number;
  /** The HUD's local listen port (config.port). */
  localPort: number;
  /** The HUD's public served origin port (443 if unknown). */
  servedPort: number;
}

/**
 * Hard-fail at startup if the configured preview port range overlaps either:
 * - the HUD's local listen port (a bind conflict), or
 * - the HUD's public served origin port (would lock out the HUD's own requests
 *   once origin hardening is active, since its origin would look like a preview).
 *
 * The range is [previewPortBase, previewPortBase + previewPortCount).
 *
 * Throws an Error with a clear message on any overlap; returns void on success.
 */
export function validatePreviewPortRange({
  previewPortBase,
  previewPortCount,
  localPort,
  servedPort,
}: PreviewPortRangeParams): void {
  if (!Number.isFinite(previewPortBase) || !Number.isFinite(previewPortCount)) {
    throw new Error(
      `Preview port config is invalid: SHEPHERD_PREVIEW_PORT_BASE and SHEPHERD_PREVIEW_PORT_COUNT must be finite numbers (got base=${previewPortBase}, count=${previewPortCount}).`,
    );
  }

  const rangeEnd = previewPortBase + previewPortCount; // exclusive

  const inRange = (port: number) => port >= previewPortBase && port < rangeEnd;

  if (inRange(localPort)) {
    throw new Error(
      `Preview port range [${previewPortBase}, ${rangeEnd}) overlaps the HUD local port ${localPort}. ` +
        `Set SHEPHERD_PREVIEW_PORT_BASE / SHEPHERD_PREVIEW_PORT_COUNT to a non-overlapping range.`,
    );
  }

  if (inRange(servedPort)) {
    throw new Error(
      `Preview port range [${previewPortBase}, ${rangeEnd}) overlaps the HUD served (public) port ${servedPort}. ` +
        `Set SHEPHERD_PREVIEW_PORT_BASE / SHEPHERD_PREVIEW_PORT_COUNT to a non-overlapping range.`,
    );
  }
}

export interface AgentIngressPortParams {
  /** The configured agent-ingress port (config.agentIngressPort). `0` = ephemeral. */
  agentIngressPort: number;
  /** The HUD's main listen port (config.port). */
  mainPort: number;
  previewPortBase: number;
  previewPortCount: number;
  /** The HUD's public served origin port (443 if unknown). */
  servedPort: number;
}

/**
 * Hard-fail at startup if the configured agent-ingress port (issue #1083) collides with another
 * Shepherd-owned port — the main HUD port, the public served port, or the preview port range. A
 * pinned ingress port that overlaps would either fail to bind or steal a preview slot, silently
 * breaking the very hook channel pinning exists to keep alive. Fail-fast (throw), consistent with
 * validatePreviewPortRange — never a silent fallback. `0` means "ephemeral" (no fixed port) and is
 * exempt. The served-port check mirrors validatePreviewPortRange for consistency (low practical
 * risk for a loopback-only ingress, but cheap to keep symmetric).
 *
 * Throws an Error with a clear, fixable message on any overlap or invalid value; returns void on success.
 */
export function validateAgentIngressPort({
  agentIngressPort,
  mainPort,
  previewPortBase,
  previewPortCount,
  servedPort,
}: AgentIngressPortParams): void {
  if (agentIngressPort === 0) return; // explicit ephemeral opt-out: nothing fixed to clash

  if (!Number.isInteger(agentIngressPort) || agentIngressPort < 0 || agentIngressPort > 65535) {
    throw new Error(
      `Agent-ingress port is invalid: SHEPHERD_AGENT_INGRESS_PORT must be an integer in [0, 65535] ` +
        `(got ${agentIngressPort}). Use 0 for an ephemeral port.`,
    );
  }

  if (agentIngressPort === mainPort) {
    throw new Error(
      `Agent-ingress port ${agentIngressPort} collides with the HUD main port ${mainPort}. ` +
        `Set SHEPHERD_AGENT_INGRESS_PORT to a free port (or 0 for ephemeral).`,
    );
  }

  if (agentIngressPort === servedPort) {
    throw new Error(
      `Agent-ingress port ${agentIngressPort} collides with the HUD served (public) port ${servedPort}. ` +
        `Set SHEPHERD_AGENT_INGRESS_PORT to a free port (or 0 for ephemeral).`,
    );
  }

  const rangeEnd = previewPortBase + previewPortCount; // exclusive
  if (agentIngressPort >= previewPortBase && agentIngressPort < rangeEnd) {
    throw new Error(
      `Agent-ingress port ${agentIngressPort} falls in the preview port range [${previewPortBase}, ${rangeEnd}). ` +
        `Set SHEPHERD_AGENT_INGRESS_PORT (or shift SHEPHERD_PREVIEW_PORT_BASE / SHEPHERD_PREVIEW_PORT_COUNT) so they don't overlap.`,
    );
  }
}

/**
 * Parse SHEPHERD_TRIM_AUTO_CONTEXT: default ON when unset; only an explicit
 * `false`/`0`/`off` (case-insensitive) turns it off. Exported for tests.
 */
export function parseTrimAutoContext(raw: string | undefined): boolean {
  return !["false", "0", "off"].includes((raw ?? "").toLowerCase());
}

/** Parse SHEPHERD_SANDBOX_DEFAULT_PROFILE: a valid profile wins, else "trusted". Exported for tests. */
export function parseSandboxProfile(v: string | undefined): SandboxProfile {
  return isSandboxProfile(v) ? v : "trusted";
}

/**
 * Parse a kill-switch env var (issue #740): default ON when unset; only an explicit `"0"` turns it
 * off. The inverse of the `=== "1"` opt-in form — for a capability that has soaked and now ships on
 * by default, keeping `<VAR>=0` as the operator's code-free revert. Exported for tests.
 */
export function parseKillSwitch(raw: string | undefined): boolean {
  return raw !== "0";
}

/** Parse an hour-of-day env (0–23 integer); empty/missing/out-of-range falls back to `def`. Exported
 *  for tests. Guards the empty string explicitly — `Number("")` is `0`, which would otherwise pass as
 *  a valid midnight hour. */
export function parseHour(raw: string | undefined, def: number): number {
  if (raw == null || raw.trim() === "") return def;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : def;
}

/** Mode for the runaway-orphan reaper (issue #1144). Mirrors `ReapMarkedOptions["mode"]`. */
type ReapRunawayMode = "armed" | "observe" | "off";

/**
 * `SHEPHERD_REAP_RUNAWAY`: `0`/`off` disables the sweep entirely; `observe` runs every gate but
 * never signals (log-only). Anything else — including unset — is `armed`, the default: the sweep
 * is safe to arm because a candidate must carry an agent-spawned env marker AND belong to an
 * archived session before it can be touched.
 */
function normalizeReapRunaway(raw: string | undefined): ReapRunawayMode {
  const v = raw?.trim().toLowerCase();
  if (v === "0" || v === "off") return "off";
  if (v === "observe") return "observe";
  return "armed";
}

// The HUD's main listen port. Extracted so the agent-ingress port can default
// relative to it (mainPort + 1) — a custom SHEPHERD_PORT shifts both in lockstep.
const mainPort = Number(process.env.SHEPHERD_PORT ?? 7330);

// Shepherd Capture (the MV3 Chrome extension in `extension/`) sends its captures with
// `Origin: chrome-extension://<id>`; the origin guard allowlists by hostname, and for that
// origin the hostname IS the extension ID (see originAllowed in validate.ts). Baking the fixed
// IDs into the default allowlist removes the manual `SHEPHERD_ALLOWED_HOSTS` pairing step: a
// stock install accepts captures with no env tweak. This is CSRF origin hygiene, not auth — a
// web page can't forge a `chrome-extension://` origin, and `SHEPHERD_TOKEN` remains the real
// auth boundary — so shipping public, fixed IDs as allowed-by-default grants nothing exploitable.
//
// TWO IDs are allowed because a Chrome extension's ID is a one-way hash of the manifest's public
// `key`, and the Web Store signs published items with ITS OWN key — so the published ID differs
// from the one the repo's manifest `key` (extension/manifest.config.ts) derives for unpacked dev
// builds. Both origins are real and must work with no pairing:
//   - SHEPHERD_CAPTURE_EXTENSION_ID       — the PUBLISHED Web Store item (what real users install).
//   - SHEPHERD_CAPTURE_UNPACKED_DEV_ID    — the pinned load-unpacked dev build.
// TODO(#1360 Task 5): to UNIFY them, set the manifest `key` to the store item's PUBLIC key (from
// the CWS dashboard — it is NOT derivable from the ID); unpacked builds then share the published
// ID and the dev-only entry below can be dropped.
export const SHEPHERD_CAPTURE_EXTENSION_ID = "liknmighjkhplpbocaefaljokofaifgi";
export const SHEPHERD_CAPTURE_UNPACKED_DEV_ID = "bflahkibnmcbijbhelmpjbohpfhlbaig";

/**
 * Resolve the origin allowlist from `SHEPHERD_ALLOWED_HOSTS` (comma-separated), always appending
 * the built-in Capture extension IDs. The env value overrides the built-in localhost defaults, but
 * the Capture IDs are appended UNCONDITIONALLY (deduped) — they're origin hygiene the operator
 * would not want to drop, so they survive even a custom `SHEPHERD_ALLOWED_HOSTS`. Consequence: the
 * env var is no longer fully authoritative over the allowlist. Entries are trimmed and empties
 * dropped (a hostname with stray whitespace would never match `URL.hostname`); real entries —
 * including `::1` and bracketed `[::1]` — are preserved verbatim. Exported for tests.
 */
export function resolveAllowedOriginHosts(envValue: string | undefined): string[] {
  const hosts = (envValue ?? "localhost,127.0.0.1,::1,[::1]")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  for (const id of [SHEPHERD_CAPTURE_EXTENSION_ID, SHEPHERD_CAPTURE_UNPACKED_DEV_ID]) {
    if (!hosts.includes(id)) hosts.push(id);
  }
  return hosts;
}

/**
 * Fold the node's own resolved host into an origin allowlist in place (deduped;
 * null/blank ignored). Called at boot once `config.previewHost` resolves so a
 * same-node HUD — direct `tailscale serve`, where the served front host IS the
 * node's own DNSName — is trusted without a manual SHEPHERD_ALLOWED_HOSTS. Only
 * the hostname is trusted: preview-port origins are still rejected by the origin
 * guard's preview-range check (it runs before the hostname check), so this does
 * not open preview-forged CSRF. A Service-fronted HUD is served under a DIFFERENT
 * DNS name; that topology is covered separately by `addServedHostsToAllowlist`.
 * Issue #1645 Fix 2. Exported for tests.
 */
export function addOwnHostToAllowlist(hosts: string[], host: string | null): void {
  const h = host?.trim();
  if (h && !hosts.includes(h)) hosts.push(h);
}

/**
 * Fold every Tailscale-served host front (direct serve AND Service fronts) for
 * the HUD's local port into an origin allowlist in place — the companion to
 * `addOwnHostToAllowlist` for the topology that helper doesn't cover (a
 * Service-fronted HUD served under a different DNS name than the node's own,
 * e.g. `svc:shepherd` → `shepherd.ts.net`). Delegates host discovery to
 * `findServedHosts` and dedup to `addOwnHostToAllowlist`. Issue #1645 Fix 2/3.
 * Exported for tests.
 */
export function addServedHostsToAllowlist(
  hosts: string[],
  serveStatusJson: string,
  localPort: number,
): void {
  for (const h of findServedHosts(serveStatusJson, localPort)) {
    addOwnHostToAllowlist(hosts, h);
  }
}

export const config = {
  port: mainPort,
  // bind to loopback only; the Tailscale-serve proxy reaches it via 127.0.0.1.
  // set SHEPHERD_HOST=0.0.0.0 to expose on all interfaces (not recommended).
  host: process.env.SHEPHERD_HOST ?? "127.0.0.1",
  // Stable port for the restricted agent-ingress listener (issue #1083). The hook URL
  // is baked into a spawned agent's --settings argv and can't be rewritten in a running
  // process; an ephemeral port (the old default) rotated every restart, so any in-flight
  // session lost its hook channel across a deploy. Pinning it (default mainPort + 1) makes
  // the baked URL survive restarts. Set SHEPHERD_AGENT_INGRESS_PORT=0 to restore the old
  // ephemeral behavior. Validated at startup by validateAgentIngressPort (must not collide
  // with the main port, served port, or preview range).
  agentIngressPort: Number(process.env.SHEPHERD_AGENT_INGRESS_PORT ?? mainPort + 1),
  dbPath,
  pluginsDir,
  herdrBin: process.env.HERDR_BIN ?? "herdr",
  herdrUpdateLogPath,
  codexBin: process.env.CODEX_BIN ?? "codex",
  codexUpdateLogPath,
  // node binary for the PTY attach helper (pty-attach.mjs). Resolved so a node
  // managed by mise/nvm/fnm still works when the launcher's PATH excludes it —
  // otherwise the helper can't spawn and every session pane stays black.
  nodeBin: resolveNodeBin({ override: process.env.SHEPHERD_NODE_BIN }),
  herdrSession,
  herdrSocketPath,
  // usage tracking: where Claude Code writes its session JSONL
  claudeProjectsDir:
    process.env.CLAUDE_PROJECTS_DIR ??
    `${process.env.CLAUDE_CONFIG_DIR ?? `${process.env.HOME}/.claude`}/projects`,
  // base claude config dir (sandbox membrane binds resolve from it).
  claudeDir: process.env.CLAUDE_CONFIG_DIR ?? `${process.env.HOME}/.claude`,
  // Default sandbox profile for spawned task agents. "trusted" = unconfined (opt-in
  // sandboxing); set SHEPHERD_SANDBOX_DEFAULT_PROFILE=standard|autonomous to sandbox by default.
  sandboxDefaultProfile: parseSandboxProfile(process.env.SHEPHERD_SANDBOX_DEFAULT_PROFILE),
  // Operator escape-hatch: extra hosts always allowlisted in the autonomous egress firewall
  // (e.g. private package registries). Comma-separated; e.g. "registry.corp.com,pypi.corp.io".
  sandboxEgressExtraHosts: (process.env.SHEPHERD_SANDBOX_EXTRA_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean),
  // Opt-in escape hatch: treat issue authors as trusted on forges that can't supply a GitHub-style
  // authorAssociation (non-GitHub — Gitea/local), so autonomous drain isn't silently disabled there.
  // Does NOT relax the gate on GitHub, where author trust is verifiable. Default off (fail closed).
  trustIssueAuthors: process.env.SHEPHERD_TRUST_ISSUE_AUTHORS === "1",
  // security
  // immutable ceiling: the absolute outermost dir the UI may ever reach. captured
  // once from the env (or $HOME) and NEVER mutated by settings. the settable
  // `repoRoot` below and the dir browser must always stay within this. defaults to
  // $HOME so a fresh install can reach any repo without needing SHEPHERD_REPO_ROOT.
  rootCeiling: process.env.SHEPHERD_REPO_ROOT ?? process.env.HOME ?? "/",
  // active repo root: defaults to the ceiling, but is UI-configurable (boot-override
  // from the store + PUT /api/settings) so long as it stays inside `rootCeiling`.
  repoRoot: process.env.SHEPHERD_REPO_ROOT ?? process.env.HOME ?? "/",
  allowedOriginHosts: resolveAllowedOriginHosts(process.env.SHEPHERD_ALLOWED_HOSTS),
  token: process.env.SHEPHERD_TOKEN ?? null, // optional operator bearer (CLI/curl); agents use the loopback ingress, not this
  // Single-operator auth (issue #1079). `password` (env) is authoritative when set: it re-seeds
  // the persisted argon2id `passwordHash` every boot. Unset ⇒ the persisted hash is used as-is
  // (an auto-generated one survives restarts). `cookieSecret` (env) pins the HMAC session-cookie
  // signing secret across DB resets; unset ⇒ generated + persisted once. Both `passwordHash` and
  // `cookieSecret` are resolved to non-null at boot by bootstrapAuth (see src/index.ts).
  password: process.env.SHEPHERD_PASSWORD ?? null,
  passwordHash: null as string | null,
  cookieSecret: process.env.SHEPHERD_COOKIE_SECRET ?? null,
  // Web Push (VAPID). Generated once and persisted in the settings table if these
  // are unset; provide them via env to pin a stable key pair across DB resets.
  vapidPublic: process.env.SHEPHERD_VAPID_PUBLIC ?? null,
  vapidPrivate: process.env.SHEPHERD_VAPID_PRIVATE ?? null,
  // ── anonymous usage telemetry (Aptabase) ────────────────────────────────
  // The App-Key is the master enable. It defaults to Shepherd's public Aptabase
  // Cloud (EU) ingestion key — an Aptabase App-Key is write-only and safe to ship
  // in the client (like a GA measurement ID), so it's embedded here so ordinary
  // installs can report once the operator opts in. Nothing sends without consent
  // (telemetryConsent defaults "unset" → the first-run prompt) and DO_NOT_TRACK.
  // Forks/self-hosters override via SHEPHERD_APTABASE_APP_KEY (set it to their own
  // key, or blank to disable). SHEPHERD_APTABASE_HOST overrides the ingestion host
  // for self-hosted instances; when unset the host is derived from the App-Key
  // region (see resolveAptabaseHost). DO_NOT_TRACK (consoledonottrack.com)
  // hard-disables telemetry and suppresses the first-run consent prompt.
  aptabaseAppKey: process.env.SHEPHERD_APTABASE_APP_KEY ?? "A-EU-2837516646",
  aptabaseHostOverride: process.env.SHEPHERD_APTABASE_HOST ?? null,
  doNotTrack: ((v) => v === "1" || v?.toLowerCase() === "true")(process.env.DO_NOT_TRACK),
  // Persisted consent (DB row overrides this env seed at boot; see index.ts).
  telemetryConsent: normalizeTelemetryConsent(process.env.SHEPHERD_TELEMETRY_CONSENT) ?? "unset",
  // Apple/iOS rejects pushes whose VAPID subject is a non-routable URL (e.g.
  // `mailto:shepherd@localhost`) with HTTP 403 BadJwtToken. Default to a valid
  // https URL; override with SHEPHERD_VAPID_SUBJECT (any valid https:/mailto: URL).
  vapidSubject: process.env.SHEPHERD_VAPID_SUBJECT ?? "https://github.com/erwins-enkel/shepherd",
  // collapse repeat per-session pushes within this window (ms); 0 disables.
  pushCooldownMs: Number(process.env.SHEPHERD_PUSH_COOLDOWN_MS ?? 120000),
  // Claude Code Remote Control auto-start for Shepherd-spawned sessions. Injected
  // at spawn via `--settings '{"remoteControlAtStartup":<bool>}'`, which overrides
  // the user's global ~/.claude/settings.json. Default false: suppress the auto-start
  // (and its notification noise) for agent sessions; `/remote-control` (`/rc`) still
  // works in the terminal to turn it on per-session. UI-configurable + persisted.
  remoteControlAtStartup: process.env.SHEPHERD_REMOTE_CONTROL_AT_STARTUP === "1",
  // Reduced push mode: global; UI-configurable + persisted; when on, the push
  // layer sends only `ready` notifications plus cost alerts (quieter devices).
  reducedPushMode: process.env.SHEPHERD_REDUCED_PUSH_MODE === "1",
  // Adopt herdr's native Unix-socket JSON-RPC API (issue #1529) instead of shelling out to
  // the `herdr` CLI for every call. Default-off feature flag: the socket protocol is still
  // preview-unstable (see HERDR_SOCKET_SUPPORTED_PROTOCOLS above), so this stays reversible
  // until the socket driver has soaked.
  herdrSocket: process.env.SHEPHERD_HERDR_SOCKET === "1",
  // Sub-flag gating ONLY the interactive terminal onto herdr's socket `terminal session control`
  // stream. Default-OFF interim gate: that stream is a screen-diff/redraw protocol, so xterm builds
  // no scrollback and never sees the app's mouse mode — which kills mobile swipe + desktop wheel
  // scrolling (the socket terminal renders, but can't be scrolled). In socket mode scroll can only
  // work if the *app* repaints on a keyboard lever over `terminal.input`.
  //
  // Phase B (#1639) probed exactly that on live agents (herdr 0.7.3 — see the reproduced matrix in
  // test/fixtures/terminal-control/scroll-binding-notes.md, re-run via
  // `bun scripts/verify-herdr-terminal.ts --scroll`): Claude Code honors PageUp, but **Codex honors
  // no lever at all** — its off-screen transcript is unreachable in socket mode. So flipping this on
  // would REGRESS Codex scroll, and node-pty removal (#1622) can't complete while Codex needs it.
  // The frame-stream transport is therefore not yet good enough to replace node-pty for the terminal.
  //
  // So this stays default-OFF: the terminal remains on node-pty (scrollable for BOTH providers) even
  // when `herdrSocket` is on; the socket driver still drives send/steer/browser/usage. Revisiting the
  // flip is blocked on a scrollback-preserving / raw-passthrough herdr terminal transport (#1642).
  herdrSocketTerminal: process.env.SHEPHERD_HERDR_SOCKET_TERMINAL === "1",
  // Push-based agent-info ingestion via Claude Code hooks (issue #704), additive on top of polling.
  // Phase 0: inject PostToolUse/PostToolUseFailure/Notification HTTP hooks into spawned agents +
  // ingest + observe (no signal wiring) — reachability, latency, and session correlation (incl.
  // under the sandboxed/egress profile). DEFAULT ON as of #740 (post-soak): fresh installs inherit
  // observe-only ingestion; it's additive + fail-open (an unreachable/hung endpoint times out per
  // the hook's 5s budget → polling). SHEPHERD_HOOKS_INGEST=0 is the kill switch.
  hooksIngest: parseKillSwitch(process.env.SHEPHERD_HOOKS_INGEST),
  // Phase 1: feed received hook events into the poller (the single owner of signal state).
  // Meaningful only when `hooksIngest` is also on — with ingest off no events arrive to feed.
  // Still OPT-IN (=== "1"): #740 flipped only ingest on. Promoting signals to default awaits
  // confirmed soak of the #711 netns transport (autonomous/egress) it would consume events over.
  hooksSignals: process.env.SHEPHERD_HOOKS_SIGNALS === "1",
  // PR-gated AI doc agent (issue #882, epic #875 Phase 3). Opt-in soak flag, mirroring
  // SHEPHERD_HOOKS_INGEST→HOOKS_SIGNALS: default-off and reversible. This is now Phase-0
  // OBSERVE — when on, the trigger spawns a scoped, dontAsk doc agent that edits stale prose
  // docs in a disposable worktree, but finalize() is LOG-ONLY (no commit/push/openPr). Set
  // `docAgentAct` (Phase 1) to escalate to actually opening PRs. When off, the manual trigger
  // (POST /api/doc-agent) 404s and the boot orphan-sweep is inert.
  docAgentEnabled: process.env.SHEPHERD_DOC_AGENT === "1",
  // Phase-1 escalation; meaningful only with `docAgentEnabled` (Phase-0 observe). When off,
  // finalize() is log-only (it warns what PR it *would* open, then skips commit/push/openPr).
  docAgentAct: process.env.SHEPHERD_DOC_AGENT_ACT === "1",
  // Per-role ENVIRONMENT (CLI + model + effort) for the doc-agent spawn. cli ∈ "inherit"|"claude"|"codex"
  // ("inherit" follows the global defaultAgentProvider+defaultModel); model ∈ "default"|<alias>.
  // Resolved via resolveRoleEnvironment at wiring time. Persisted + UI-configurable; env seeds a fresh DB.
  docAgentCli: normalizeRoleCli(process.env.SHEPHERD_DOC_AGENT_CLI) ?? "inherit",
  docAgentModel: normalizeRoleModelToken(process.env.SHEPHERD_DOC_AGENT_MODEL) ?? "default",
  docAgentEffort: normalizeDefaultEffortSetting(process.env.SHEPHERD_DOC_AGENT_EFFORT) ?? "low",
  // Per-role environment for the Learnings Distiller. Inherit is intentionally the default so
  // it follows the operator's global provider/model/effort selection.
  distillerCli: normalizeRoleCli(process.env.SHEPHERD_DISTILLER_CLI) ?? "inherit",
  distillerModel: normalizeRoleModelToken(process.env.SHEPHERD_DISTILLER_MODEL) ?? "default",
  distillerEffort:
    normalizeDefaultEffortSetting(process.env.SHEPHERD_DISTILLER_EFFORT) ?? "default",
  // Per-role environment for the Learnings Optimizer. Inherit follows the operator's global
  // provider/model/effort selection; explicit providers keep "default" effort provider-native.
  optimizerCli: normalizeRoleCli(process.env.SHEPHERD_OPTIMIZER_CLI) ?? "inherit",
  optimizerModel: normalizeRoleModelToken(process.env.SHEPHERD_OPTIMIZER_MODEL) ?? "default",
  optimizerEffort:
    normalizeDefaultEffortSetting(process.env.SHEPHERD_OPTIMIZER_EFFORT) ?? "default",
  // Per-role environment for the Learnings Merge Suggester. Inherit follows the live global
  // provider/model/effort selection while explicit providers keep their natural defaults.
  mergeSuggestCli: normalizeRoleCli(process.env.SHEPHERD_MERGE_SUGGEST_CLI) ?? "inherit",
  mergeSuggestModel: normalizeRoleModelToken(process.env.SHEPHERD_MERGE_SUGGEST_MODEL) ?? "default",
  mergeSuggestEffort:
    normalizeDefaultEffortSetting(process.env.SHEPHERD_MERGE_SUGGEST_EFFORT) ?? "default",
  // Automatic runs are throttled per repository; 1 preserves the historic daily behavior.
  distillerIntervalDays: clampCap(
    Number(process.env.SHEPHERD_DISTILLER_INTERVAL_DAYS ?? 1),
    DISTILLER_INTERVAL_DAYS_MIN,
    DISTILLER_INTERVAL_DAYS_MAX,
    1,
  ),
  // Local hour (0–23) at/after which the doc agent's nightly cadence sweep evaluates each doc-tree
  // repo (issue #904). Once/day/repo, and only spawns when the default branch advanced since the last
  // run; default 3 (≈03:00 local). Invalid values fall back to 3.
  docAgentNightlyHour: parseHour(process.env.SHEPHERD_DOC_AGENT_NIGHTLY_HOUR, 3),
  // Context trim for auto-spawned (drain) agents (issue #499): spawn them with
  // `--disable-slash-commands` (drops the skill catalog) plus a per-spawn settings
  // overlay disabling every operator-enabled plugin (drops plugin hook injections,
  // skills, and MCP) — overhead unattended agents never use. Default on; set
  // SHEPHERD_TRIM_AUTO_CONTEXT=false/0/off as the escape hatch if drain quality regresses.
  trimAutoContext: parseTrimAutoContext(process.env.SHEPHERD_TRIM_AUTO_CONTEXT),
  // Standard command: legacy seed for the backlog quick-launch prompt. Quick-launch
  // actions now live in the steers list (issue-scoped entries, edited in the UI); this
  // value only seeds/migrates the default "Standard" issue action on first steers read.
  // A previously customized prompt (stored "standardCommand" setting) takes precedence.
  standardCommand:
    process.env.SHEPHERD_STANDARD_COMMAND ??
    "Prüfe, ob dieses Issue noch relevant ist. Gib mir den aktuellen Stand des Issues und untersuche, wie weit wir das bereits in unserer Codebase umgesetzt haben. Fasse zusammen, was noch fehlt, und schlage die nächsten Schritte vor.",
  // Database housekeeping: a daily sweep deletes archived sessions older than the
  // retention window OR beyond the newest cap (see SESSION_RETENTION_* below),
  // cascading their review rows. A safe sweep over already-archived history — default
  // on, with this flag as the kill switch. UI-configurable + persisted; set
  // SHEPHERD_SESSION_HOUSEKEEPING=0 to seed it off on a fresh DB.
  sessionHousekeepingEnabled: process.env.SHEPHERD_SESSION_HOUSEKEEPING !== "0",
  // Auto-revive stranded default-account sessions after a herdr daemon restart (#1630). Opt-in,
  // default OFF: only the default-account complement is auto-revived (account panes already recover
  // via reDriveAccount). UI-configurable + persisted; set SHEPHERD_AUTO_REVIVE=1 to seed it on.
  autoReviveEnabled: process.env.SHEPHERD_AUTO_REVIVE === "1",
  // Runaway-orphan reaper (issue #1144). SIGKILLs a process that (a) carries this session's
  // SHEPHERD_SESSION_ID in its /proc/<pid>/environ (provenance — an agent spawned it) AND (b) whose
  // session row is present and `archived` (terminality — the agent is definitively done), once it has
  // burned `reapRunawayMinCpu` of a core over `reapRunawayMinAgeS`. Safety comes from provenance ∧
  // terminality; the CPU/age pair is a PERFORMANCE prefilter that keeps the sweep's /proc/<pid>/environ
  // reads (which take the target's mmap lock) near zero — NOT a safety floor.
  //   armed (default) → SIGKILL · observe → log-only · off → the sweep never runs.
  reapRunaway: normalizeReapRunaway(process.env.SHEPHERD_REAP_RUNAWAY),
  // Fraction of ONE core, averaged over the process's whole lifetime (incl. reaped children).
  // CLAMPED, not just defaulted: `Number("")` is 0, so an env var that is merely SET-BUT-EMPTY
  // would otherwise silently drop the gate to "any marked process of an archived session".
  reapRunawayMinCpu: clampFraction(
    Number(process.env.SHEPHERD_REAP_RUNAWAY_MIN_CPU ?? 0.8),
    0.05,
    1,
    0.8,
  ),
  // Minimum process age before it can be reaped. This floor is what makes the benign `restore()`
  // race unreachable — restore SPAWNS the agent before `store.unarchive` flips the row off
  // `archived`, so a live agent's row briefly reads archived. Clamped to a hard >= 60s minimum:
  // `Number("")` is 0, and a 0 floor would open exactly that window (and reap the freshly
  // respawned agent's own children). A comment cannot enforce this; the clamp does.
  reapRunawayMinAgeS: clampCap(
    Number(process.env.SHEPHERD_REAP_RUNAWAY_MIN_AGE_S ?? 300),
    60,
    24 * 60 * 60,
    300,
  ),
  // LLM session naming: after a session is created with the instant heuristic name,
  // a transient haiku agent comprehends the prompt and renames it in the background.
  // Default on; set SHEPHERD_LLM_NAMING=0 to keep the pure-heuristic name.
  llmNaming: process.env.SHEPHERD_LLM_NAMING !== "0",
  // Per-role ENVIRONMENT (CLI + model + effort) for the background namer (cheap + fast is plenty for a 2-4
  // word slug). Seeded to Claude+haiku — a deliberate fixed default for this constant-cadence
  // classifier (following a heavy global default would needlessly inflate naming cost). Resolved
  // via resolveRoleEnvironment at the call site. Persisted + UI-configurable.
  namerCli: normalizeRoleCli(process.env.SHEPHERD_NAMER_CLI) ?? "claude",
  namerModel: normalizeRoleModelToken(process.env.SHEPHERD_NAMER_MODEL) ?? "haiku",
  namerEffort: normalizeDefaultEffortSetting(process.env.SHEPHERD_NAMER_EFFORT) ?? "low",
  // Char budget for the Shepherd house-rules block prepended to every agent prompt. Active+
  // promoted rules fill greedily by most-recently-effective priority until this cap; the rest
  // stay visible-but-uninjected in the Learnings drawer for the operator to prune. Default 4000
  // (~25 max-length rules); only an unusually large curated set is capped.
  houseRulesBudgetChars: Number(process.env.SHEPHERD_HOUSE_RULES_BUDGET_CHARS ?? 4000),
  // Max auto-steers autopilot spends per session before it pauses for the operator (runaway guard).
  autopilotStepCap: Number(process.env.SHEPHERD_AUTOPILOT_STEP_CAP ?? 10),
  // Per-role ENVIRONMENT (CLI + model + effort) for the transient autopilot stop-classifier spawn (cheap +
  // fast is plenty). Seeded to Claude+haiku — like the namer, a deliberate fixed default for a
  // constant-cadence classifier. Resolved via resolveRoleEnvironment at the call site.
  // Persisted + UI-configurable.
  autopilotCli: normalizeRoleCli(process.env.SHEPHERD_AUTOPILOT_CLI) ?? "claude",
  autopilotModel: normalizeRoleModelToken(process.env.SHEPHERD_AUTOPILOT_MODEL) ?? "haiku",
  autopilotEffort: normalizeDefaultEffortSetting(process.env.SHEPHERD_AUTOPILOT_EFFORT) ?? "low",
  // Max PR-critic auto-address rounds before escalating to a human (drives ReviewService).
  // UI-configurable + persisted; the env seeds the initial value on a fresh DB.
  prReviewCyclesCap: clampCap(
    Number(process.env.SHEPHERD_REVIEW_CYCLES_CAP ?? PR_REVIEW_CYCLES_DEFAULT),
    PR_REVIEW_CYCLES_MIN,
    PR_REVIEW_CYCLES_MAX,
    PR_REVIEW_CYCLES_DEFAULT,
  ),
  // Max plan-gate adversarial-review rounds before escalating to a human (drives
  // PlanGateService). UI-configurable + persisted; the env seeds the value on a fresh DB.
  planReviewCyclesCap: clampCap(
    Number(process.env.SHEPHERD_PLAN_REVIEW_CYCLES_CAP ?? PLAN_REVIEW_CYCLES_DEFAULT),
    PLAN_REVIEW_CYCLES_MIN,
    PLAN_REVIEW_CYCLES_MAX,
    PLAN_REVIEW_CYCLES_DEFAULT,
  ),
  // Per-role ENVIRONMENTs (CLI + model + effort) for the PR critic (ReviewService + StandalonePrCriticService)
  // and the pre-execution plan-gate reviewer. cli ∈ "inherit"|"claude"|"codex"; model ∈
  // "default"|<alias>. Seeded to cli "inherit" → both follow the global defaultAgentProvider +
  // defaultModel (today's behavior). Resolved via resolveRoleEnvironment at wiring time. Persisted +
  // UI-configurable; env seeds a fresh DB.
  criticCli: normalizeRoleCli(process.env.SHEPHERD_CRITIC_CLI) ?? "inherit",
  criticModel: normalizeRoleModelToken(process.env.SHEPHERD_CRITIC_MODEL) ?? "default",
  criticEffort: normalizeDefaultEffortSetting(process.env.SHEPHERD_CRITIC_EFFORT) ?? "high",
  plannerCli: normalizeRoleCli(process.env.SHEPHERD_PLANNER_CLI) ?? "inherit",
  plannerModel: normalizeRoleModelToken(process.env.SHEPHERD_PLANNER_MODEL) ?? "default",
  // NOTE: seeded "default", NOT "high" like criticEffort — deliberate, not an oversight. The planner
  // has no independent spawn: it IS the plan-gate reviewer, which (per #1417) inherits `session.effort`
  // — the tier the session itself runs at. plan-gate resolves `env.effort ?? session.effort`, so
  // "default" (→ null) preserves that inheritance (a `max` session reviews its plan at `max`), while
  // an explicit tier here still overrides. Seeding "high" would force every plan review to high
  // regardless of the session, downgrading high-effort sessions and surprising low-effort ones.
  plannerEffort: normalizeDefaultEffortSetting(process.env.SHEPHERD_PLANNER_EFFORT) ?? "default",
  // Per-role ENVIRONMENT for the recap (session-summary) agent. Seeded to Claude+sonnet to preserve
  // the prior hardcoded default; resolved via resolveRoleEnvironment. Persisted + UI-configurable.
  recapCli: normalizeRoleCli(process.env.SHEPHERD_RECAP_CLI) ?? "claude",
  recapModel: normalizeRoleModelToken(process.env.SHEPHERD_RECAP_MODEL) ?? "sonnet",
  recapEffort: normalizeDefaultEffortSetting(process.env.SHEPHERD_RECAP_EFFORT) ?? "low",
  // Per-role ENVIRONMENT for the daily Herd Rundown. Inherit follows the global provider/model;
  // explicit Claude preserves the prior Sonnet path. Persisted + UI-configurable.
  rundownCli: normalizeRoleCli(process.env.SHEPHERD_RUNDOWN_CLI) ?? "inherit",
  rundownModel: normalizeRoleModelToken(process.env.SHEPHERD_RUNDOWN_MODEL) ?? "sonnet",
  rundownEffort: normalizeDefaultEffortSetting(process.env.SHEPHERD_RUNDOWN_EFFORT) ?? "low",
  // Default model for spawned agents. Persisted + UI-configurable. "auto" = unset seed
  // (picker uses client promo fallback, drain falls back to no --model); an explicit
  // value applies to both the New Task picker and drain/autopilot auto-spawns. Env seeds
  // a fresh DB; absent/invalid → "auto".
  defaultModel: normalizeDefaultModelSetting(process.env.SHEPHERD_DEFAULT_MODEL) ?? "auto",
  // Provider-specific Codex default. Existing installs seed to the picker's historical first
  // choice; "default" means no --model flag and lets Codex choose.
  defaultCodexModel:
    normalizeDefaultCodexModelSetting(process.env.SHEPHERD_DEFAULT_CODEX_MODEL) ?? "gpt-5.5",
  // Global default reasoning-effort setting ("default" | <tier>). "default" = emit no effort flag.
  // Applies to the New Task picker and drain/autopilot auto-spawns. Env seeds a fresh DB;
  // absent/invalid → "default". Persisted + UI-configurable. No "auto" tier (effort has no promo).
  defaultEffort: normalizeDefaultEffortSetting(process.env.SHEPHERD_DEFAULT_EFFORT) ?? "default",
  // Default interactive agent provider for newly spawned task sessions. Persisted +
  // UI-configurable; env seeds a fresh DB.
  defaultAgentProvider:
    normalizeAgentProvider(process.env.SHEPHERD_DEFAULT_AGENT_PROVIDER) ?? "claude",
  // Global fable availability flag. When false, any spawn requesting --model fable is
  // transparently rerouted to opus[1m] at argv-assembly time without rewriting the
  // stored session model (so cost accounting + fable intent survive for later replay).
  // Persisted + UI-configurable; SHEPHERD_FABLE_AVAILABLE=0/false seeds it off.
  fableAvailable: normalizeFableAvailable(process.env.SHEPHERD_FABLE_AVAILABLE) ?? true,
  // Opt the main agent session into Claude Code's fullscreen renderer (research preview;
  // applies to newly spawned/resumed sessions only). Persisted + UI-configurable; default off.
  tuiFullscreen: process.env.SHEPHERD_TUI_FULLSCREEN === "1",
  // Disable Claude Code mouse capture for the main agent session. Persisted + UI-configurable;
  // default off. (tuiFullscreen also implies this — coupling lives in the spawn wiring, not here.)
  tuiDisableMouse: process.env.SHEPHERD_TUI_DISABLE_MOUSE === "1",
  // When true, Up Next quick-start launches with the operator's default coding CLI instead of
  // opening the "Choose coding CLI" picker, even when more than one CLI is ready. Persisted +
  // UI-configurable; default off (preserves today's picker behavior).
  upnextSkipCliPicker: process.env.SHEPHERD_UPNEXT_SKIP_CLI_PICKER === "1",
  // Operator auth footing for spawned agents. 'subscription' (default) = subscription OAuth;
  // 'api-key' = bill against an Anthropic API key. Persisted + UI-configurable; env seeds a fresh DB.
  authMode: normalizeAuthModeSetting(process.env.SHEPHERD_AUTH_MODE) ?? "subscription",
  // Language agents address the operator in. 'en' (default) = no change; 'de' = agents address
  // the operator in German while keeping code/commands/identifiers/logs/commits/GitHub text in
  // their original language. Persisted + UI-configurable; env seeds a fresh DB.
  operatorLanguage: normalizeOperatorLanguage(process.env.SHEPHERD_OPERATOR_LANGUAGE) ?? "en",
  // Path to the apiKeyHelper script (written by Shepherd when the operator supplies a key).
  // null = no key configured. The raw key is NEVER stored — only this script path.
  authApiKeyHelperPath: (process.env.SHEPHERD_API_KEY_HELPER_PATH ?? null) as string | null,
  // Account-wide extra-credit (paid pay-as-you-go overage) spend ceiling, in account
  // currency units. Auto-drain/autopilot pauses when measured spend strictly exceeds it.
  // Persisted + UI-configurable; env seeds a fresh DB. Default 0 = pause on ANY spend.
  extraCreditsDrainCeiling: Math.max(
    0,
    Number(process.env.SHEPHERD_EXTRA_CREDITS_DRAIN_CEILING ?? 0) || 0,
  ),
  // Max consecutive auto-rebase attempts the merge train spends on a PR before pausing for the operator.
  autoMergeRebaseCap: Number(process.env.SHEPHERD_AUTOMERGE_REBASE_CAP ?? 5),
  // git host (forge) integration: per-host {type,baseUrl,token,deployWorkflow,mergeMethod}
  forgesPath,
  forges: loadForgeMap(forgesPath),
  // ── live preview port range ──────────────────────────────────────────────
  // Each active session's preview listener is assigned a slot from this range.
  // previewPortCount is BOTH the range size AND the max concurrent previews
  // (single source; the allocator derives the count from here — no magic numbers).
  // Range: [previewPortBase, previewPortBase + previewPortCount).
  previewPortBase: Number(process.env.SHEPHERD_PREVIEW_PORT_BASE ?? 8001),
  previewPortCount: Number(process.env.SHEPHERD_PREVIEW_PORT_COUNT ?? 16),
  // Throttle cadence for the preview sweep (ms); mitigates /proc scan cost.
  previewSweepMs: Number(process.env.SHEPHERD_PREVIEW_SWEEP_MS ?? 4000),
  // The agent node's own tailnet hostname (e.g. "mynode.ts.net"), resolved ONCE
  // at startup and stored here. When the HUD is fronted on a different host/identity
  // than the agent node (e.g. a Tailscale Service), the preview URL must target THIS
  // node's host — not the operator's connection host — to remain reachable from the
  // tailnet. Null when tailscale is absent or the hostname cannot be resolved.
  previewHost: null as string | null,
  // Dynamic per-slot tailscale serve registration (default ON): when true AND
  // tailscale is present (previewHost resolved), shepherd registers
  // `tailscale serve --bg --https=<port>` as each preview listener binds and
  // removes it on teardown — only in-use ports are exposed.
  // No-ops when tailscale/previewHost is absent. Set SHEPHERD_PREVIEW_AUTO_SERVE=0
  // to map the range manually (e.g. via `tailscale serve --bg --https=<port>`).
  // Requires tailnet HTTPS certificates to be enabled for the node.
  previewAutoServe: process.env.SHEPHERD_PREVIEW_AUTO_SERVE !== "0",
  // Opt-in idle-stop (default OFF): when > 0, a previewed dev server with no proxy
  // traffic for this many ms — AND whose agent is idle — is killed to reclaim RAM.
  // 0/unset = disabled. Suggested when enabled: 1800000 (30 min). No auto-wake; the
  // operator/agent restarts the dev server manually afterward.
  previewIdleStopMs: Math.max(0, Number(process.env.SHEPHERD_PREVIEW_IDLE_STOP_MS ?? 0) || 0),
  // Usage-aware task holding: when usage is at or above holdPct, newly submitted tasks
  // are queued in held_tasks rather than spawned immediately. Released by the 30s sweeper
  // once usage drops back below the threshold. Default ON; set SHEPHERD_USAGE_HOLD_ENABLED=0
  // to disable. holdPct: [0,100], default 80.
  usageHoldEnabled: !["0", "false"].includes(
    (process.env.SHEPHERD_USAGE_HOLD_ENABLED ?? "").toLowerCase(),
  ),
  usageHoldPct: clampCap(Number(process.env.SHEPHERD_USAGE_HOLD_PCT ?? 80), 0, 100, 80),
  // When true (default), the 30s sweeper auto-starts held tasks once usage drops below the
  // threshold. When false, held tasks stay queued indefinitely — the operator starts each one
  // manually (or discards it) from the held-tasks popover. Set SHEPHERD_USAGE_HOLD_AUTO_RELEASE=0
  // to default to manual-only. Only gates the threshold path; turning the gate off entirely
  // (usageHoldEnabled=false) still flushes everything.
  usageHoldAutoRelease: !["0", "false"].includes(
    (process.env.SHEPHERD_USAGE_HOLD_AUTO_RELEASE ?? "").toLowerCase(),
  ),
  // Usage-aware model downgrade (companion to the hold above): when usage is at or above
  // downgradePct, every newly spawned agent (main task agents AND the role agents) runs on
  // usageDowngradeModel instead of its configured model — work keeps flowing, just cheaper.
  // Intended two-tier escalation: downgrade at a LOWER pct, hold at a higher one. Default OFF
  // (opt-in, no behavior change); set SHEPHERD_USAGE_DOWNGRADE_ENABLED=1 to enable. downgradePct:
  // [0,100], default 70 — deliberately BELOW the usageHoldPct default (80) so enabling downgrade
  // with defaults actually downgrades first (at 70) before the hold pauses (at 80); an equal default
  // would make the hold fire first and the downgrade a silent no-op. Model: a default-model SETTING
  // ("auto"|"default"|<alias>), default haiku.
  usageDowngradeEnabled: ["1", "true"].includes(
    (process.env.SHEPHERD_USAGE_DOWNGRADE_ENABLED ?? "").toLowerCase(),
  ),
  usageDowngradePct: clampCap(Number(process.env.SHEPHERD_USAGE_DOWNGRADE_PCT ?? 70), 0, 100, 70),
  usageDowngradeModel:
    normalizeDefaultModelSetting(process.env.SHEPHERD_USAGE_DOWNGRADE_MODEL) ?? "haiku",
};

// #1430 guardrail: the critic is a rigor role seeded to "high". Warn at startup when
// SHEPHERD_CRITIC_EFFORT lowered it below high (low/medium/default) — the UI/PATCH paths warn at
// set-time (see server.ts). Because the seed default is "high", this is silent in normal runs and
// only fires when the env var was explicitly set below high.
if (effortBelowHigh(config.criticEffort)) {
  console.warn(
    `[critic-effort] SHEPHERD_CRITIC_EFFORT='${config.criticEffort}' resolves below 'high'; the critic is a rigor role — a reduced effort weakens PR review`,
  );
}

// Session housekeeping retention thresholds (the daily sweep's policy). The single
// tuning point: archived sessions older than SESSION_RETENTION_MS OR ranked past the
// newest SESSION_RETENTION_KEEP are pruned (union, global). The kill switch is
// config.sessionHousekeepingEnabled. The day/count values are surfaced in the settings
// payload so the UI shows the real numbers rather than a hardcoded mirror.
export const SESSION_RETENTION_DAYS = 30;
export const SESSION_RETENTION_MS = SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000;
export const SESSION_RETENTION_KEEP = 250;

// "Done" lens window: sessions archived within this window are surfaced in the
// in-app Done lens (read-only recap review). Independent of SESSION_RETENTION_*.
export const DONE_LENS_WINDOW_MS = 48 * 60 * 60 * 1000; // 48h

// reviewer_spawns rows (critic/plan-gate cost-attribution records, issue #502) are
// deliberately decoupled from session lifecycle so they outlive archive/prune — but they
// still need a ceiling. 90 days > SESSION_RETENTION_DAYS so a cost report can still attribute
// burn for a recently-archived task whose session row is already gone.
const REVIEWER_SPAWN_RETENTION_DAYS = 90; // module-local; only the _MS form is consumed
export const REVIEWER_SPAWN_RETENTION_MS = REVIEWER_SPAWN_RETENTION_DAYS * 24 * 60 * 60 * 1000;

// usage_caps_history / usage_credit_history: append-only per-scrape timeline for the Limits
// trend (issue #973). 90 days matches reviewer_spawns — long enough for meaningful monthly credit
// cycles and weekly cap patterns, bounded enough to stay cheap.
const USAGE_HISTORY_RETENTION_DAYS = 90; // module-local; only the _MS form is consumed
export const USAGE_HISTORY_RETENTION_MS = USAGE_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
