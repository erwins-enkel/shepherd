import { dirname, join } from "node:path";
import { resolveNodeBin } from "./node-bin";
import { loadForgeMap } from "./forge/load-config";

const dbPath = process.env.SHEPHERD_DB ?? `${process.env.HOME}/.shepherd/shepherd.db`;
// forge map sits next to the db by default; SHEPHERD_FORGES overrides the path.
const forgesPath = process.env.SHEPHERD_FORGES ?? join(dirname(dbPath), "forges.json");
// persistent herdr-update audit log: one delimited block per `herdr update`,
// written by the transient update unit itself (NOT shepherd) so the record
// survives the shepherd restart the update triggers. Lives next to the db so a
// post-mortem is `cat ~/.shepherd/herdr-update.log`; SHEPHERD_HERDR_UPDATE_LOG overrides.
const herdrUpdateLogPath =
  process.env.SHEPHERD_HERDR_UPDATE_LOG ?? join(dirname(dbPath), "herdr-update.log");

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
  // git host (forge) integration: per-host {type,baseUrl,token,deployWorkflow,mergeMethod}
  forgesPath,
  forges: loadForgeMap(forgesPath),
};

// Session housekeeping retention thresholds (the daily sweep's policy). The single
// tuning point: archived sessions older than SESSION_RETENTION_MS OR ranked past the
// newest SESSION_RETENTION_KEEP are pruned (union, global). The kill switch is
// config.sessionHousekeepingEnabled. The day/count values are surfaced in the settings
// payload so the UI shows the real numbers rather than a hardcoded mirror.
export const SESSION_RETENTION_DAYS = 30;
export const SESSION_RETENTION_MS = SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000;
export const SESSION_RETENTION_KEEP = 250;
