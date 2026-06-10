import { dirname, join } from "node:path";
import { resolveNodeBin } from "./node-bin";
import { loadForgeMap } from "./forge/load-config";
import { normalizeDefaultModelSetting } from "./default-model";

const dbPath = process.env.SHEPHERD_DB ?? `${process.env.HOME}/.shepherd/shepherd.db`;
// forge map sits next to the db by default; SHEPHERD_FORGES overrides the path.
const forgesPath = process.env.SHEPHERD_FORGES ?? join(dirname(dbPath), "forges.json");
// persistent herdr-update audit log: one delimited block per `herdr update`,
// written by the transient update unit itself (NOT shepherd) so the record
// survives the shepherd restart the update triggers. Lives next to the db so a
// post-mortem is `cat ~/.shepherd/herdr-update.log`; SHEPHERD_HERDR_UPDATE_LOG overrides.
const herdrUpdateLogPath =
  process.env.SHEPHERD_HERDR_UPDATE_LOG ?? join(dirname(dbPath), "herdr-update.log");

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

// ── preview-port range ─────────────────────────────────────────────────────
// Single source of truth for the preview-port range; consumed by both the slot
// allocator (future PreviewService) and checkOrigin (origin hardening). The range
// is [previewPortBase, previewPortBase + previewPortCount).
//
// previewPortCount is BOTH the range size and the max concurrent previews — a
// single number, no secondary "max" constant anywhere else.

/**
 * Pure parser: given the text of `tailscale serve status` and the HUD's local
 * listen port, return the public-facing HTTPS port that Tailscale fronts that
 * local port on. Returns null when no matching mapping is found.
 *
 * Example input lines:
 *   https://host.ts.net:5191 (tailnet only)
 *   |-- / proxy http://127.0.0.1:5190
 *
 * The HUD's default mapping has no port (=> 443):
 *   https://host.ts.net (tailnet only)
 *   |-- / proxy http://127.0.0.1:7330
 */
export function parseServedPort(serveStatusText: string, localPort: number): number | null {
  const lines = serveStatusText.split("\n");
  let currentServedPort: number | null = null;
  for (const line of lines) {
    const t = line.trim();
    const served = extractServedPort(t);
    if (served !== null) {
      currentServedPort = served;
    } else if (currentServedPort !== null && isProxyTarget(t, localPort)) {
      return currentServedPort;
    }
  }
  return null;
}

/** Extract the public HTTPS port from a `https://...` serve-status header line.
 *  Returns 443 when no explicit port is present, null when the line isn't an
 *  https header.
 *  Note: IPv6 bracket hosts (`[::1]:…`) are intentionally not matched because
 *  Tailscale `serve` always emits `127.0.0.1` + ts.net hostnames. */
function extractServedPort(line: string): number | null {
  const m = line.match(/^https:\/\/[^:/]+(?::(\d+))?(?:\s|$)/);
  if (!m) return null;
  return m[1] ? Number(m[1]) : 443;
}

/** True when a `|-- / proxy ...` line targets 127.0.0.1:<localPort>.
 *  Note: `localhost` and IPv6 bracket targets (`[::1]:…`) are intentionally
 *  not matched because Tailscale `serve` always emits `127.0.0.1`. */
function isProxyTarget(line: string, localPort: number): boolean {
  if (!line.startsWith("|--")) return false;
  const m = line.match(/proxy\s+(?:https?:\/\/)?127\.0\.0\.1:(\d+)/);
  return m !== null && Number(m[1]) === localPort;
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

export const config = {
  port: Number(process.env.SHEPHERD_PORT ?? 7330),
  // bind to loopback only; the Tailscale-serve proxy reaches it via 127.0.0.1.
  // set SHEPHERD_HOST=0.0.0.0 to expose on all interfaces (not recommended).
  host: process.env.SHEPHERD_HOST ?? "127.0.0.1",
  dbPath,
  herdrBin: process.env.HERDR_BIN ?? "herdr",
  herdrUpdateLogPath,
  // node binary for the PTY attach helper (pty-attach.mjs). Resolved so a node
  // managed by mise/nvm/fnm still works when the launcher's PATH excludes it —
  // otherwise the helper can't spawn and every session pane stays black.
  nodeBin: resolveNodeBin({ override: process.env.SHEPHERD_NODE_BIN }),
  herdrSession: process.env.HERDR_SESSION ?? "default",
  // usage tracking: where Claude Code writes its session JSONL
  claudeProjectsDir:
    process.env.CLAUDE_PROJECTS_DIR ??
    `${process.env.CLAUDE_CONFIG_DIR ?? `${process.env.HOME}/.claude`}/projects`,
  // security
  // immutable ceiling: the absolute outermost dir the UI may ever reach. captured
  // once from the env (or $HOME) and NEVER mutated by settings. the settable
  // `repoRoot` below and the dir browser must always stay within this. defaults to
  // $HOME so a fresh install can reach any repo without needing SHEPHERD_REPO_ROOT.
  rootCeiling: process.env.SHEPHERD_REPO_ROOT ?? process.env.HOME ?? "/",
  // active repo root: defaults to the ceiling, but is UI-configurable (boot-override
  // from the store + PUT /api/settings) so long as it stays inside `rootCeiling`.
  repoRoot: process.env.SHEPHERD_REPO_ROOT ?? process.env.HOME ?? "/",
  allowedOriginHosts: (process.env.SHEPHERD_ALLOWED_HOSTS ?? "localhost,127.0.0.1,::1,[::1]").split(
    ",",
  ),
  token: process.env.SHEPHERD_TOKEN ?? null, // when set, require Authorization: Bearer <token>
  // Web Push (VAPID). Generated once and persisted in the settings table if these
  // are unset; provide them via env to pin a stable key pair across DB resets.
  vapidPublic: process.env.SHEPHERD_VAPID_PUBLIC ?? null,
  vapidPrivate: process.env.SHEPHERD_VAPID_PRIVATE ?? null,
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
  // Standard command: the prompt seeded behind the backlog quick-launch button.
  // Clicking it spawns a session with this prompt + the issue, skipping the New Task
  // dialog. Empty string disables the shortcut (the button falls back to the dialog).
  // UI-configurable + persisted; the env seeds the initial value on a fresh DB.
  standardCommand:
    process.env.SHEPHERD_STANDARD_COMMAND ??
    "Prüfe, ob dieses Issue noch relevant ist. Gib mir den aktuellen Stand des Issues und untersuche, wie weit wir das bereits in unserer Codebase umgesetzt haben. Fasse zusammen, was noch fehlt, und schlage die nächsten Schritte vor.",
  // Database housekeeping: a daily sweep deletes archived sessions older than the
  // retention window OR beyond the newest cap (see SESSION_RETENTION_* below),
  // cascading their review rows. A safe sweep over already-archived history — default
  // on, with this flag as the kill switch. UI-configurable + persisted; set
  // SHEPHERD_SESSION_HOUSEKEEPING=0 to seed it off on a fresh DB.
  sessionHousekeepingEnabled: process.env.SHEPHERD_SESSION_HOUSEKEEPING !== "0",
  // LLM session naming: after a session is created with the instant heuristic name,
  // a transient haiku agent comprehends the prompt and renames it in the background.
  // Default on; set SHEPHERD_LLM_NAMING=0 to keep the pure-heuristic name.
  llmNaming: process.env.SHEPHERD_LLM_NAMING !== "0",
  // model for the background namer (cheap + fast is plenty for a 2-4 word slug).
  namerModel: process.env.SHEPHERD_NAMER_MODEL ?? "haiku",
  // Char budget for the Shepherd house-rules block prepended to every agent prompt. Active+
  // promoted rules fill greedily by most-recently-effective priority until this cap; the rest
  // stay visible-but-uninjected in the Learnings drawer for the operator to prune. Default 4000
  // (~25 max-length rules); only an unusually large curated set is capped.
  houseRulesBudgetChars: Number(process.env.SHEPHERD_HOUSE_RULES_BUDGET_CHARS ?? 4000),
  // Max auto-steers autopilot spends per session before it pauses for the operator (runaway guard).
  autopilotStepCap: Number(process.env.SHEPHERD_AUTOPILOT_STEP_CAP ?? 10),
  // Model alias for the transient autopilot stop-classifier spawn (cheap + fast is plenty).
  autopilotModel: process.env.SHEPHERD_AUTOPILOT_MODEL ?? "haiku",
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
  // Default model for spawned agents. Persisted + UI-configurable. "auto" = unset seed
  // (picker uses client promo fallback, drain falls back to no --model); an explicit
  // value applies to both the New Task picker and drain/autopilot auto-spawns. Env seeds
  // a fresh DB; absent/invalid → "auto".
  defaultModel: normalizeDefaultModelSetting(process.env.SHEPHERD_DEFAULT_MODEL) ?? "auto",
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
};

// Session housekeeping retention thresholds (the daily sweep's policy). The single
// tuning point: archived sessions older than SESSION_RETENTION_MS OR ranked past the
// newest SESSION_RETENTION_KEEP are pruned (union, global). The kill switch is
// config.sessionHousekeepingEnabled. The day/count values are surfaced in the settings
// payload so the UI shows the real numbers rather than a hardcoded mirror.
export const SESSION_RETENTION_DAYS = 30;
export const SESSION_RETENTION_MS = SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000;
export const SESSION_RETENTION_KEEP = 250;
