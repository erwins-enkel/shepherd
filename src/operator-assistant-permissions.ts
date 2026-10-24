/**
 * What the Operator Assistant may do (Settings → Assistant). The pure half: the levels, the
 * defaults, patch validation, and the Claude permission rules each level becomes. The rules land in
 * the assistant's `.claude/settings.local.json` (see `SessionService.syncOperatorAssistantPermissions`),
 * which Claude Code re-reads mid-session, so a change applies to the running conversation. The
 * server enforces `off` on its own at call time (src/operator-assistant-actions.ts), so a reload
 * that lags never lets a turned-off action through.
 *
 * The shell is ONE row with four levels, not separate read/write rows: Claude evaluates deny before
 * ask before allow, and its built-in read-only command set is not addressable by a rule, so "reads
 * free, everything else denied" cannot be expressed. The four levels are every combination that can.
 */

const ASSISTANT_SHELL_LEVELS = ["off", "ask", "read", "all"] as const;
export type AssistantShellLevel = (typeof ASSISTANT_SHELL_LEVELS)[number];

const ASSISTANT_ACTION_LEVELS = ["off", "ask", "allow"] as const;
export type AssistantActionLevel = (typeof ASSISTANT_ACTION_LEVELS)[number];

/** The assistant's read tools (src/operator-assistant-tools.ts), always allowed. Named here rather
 *  than derived from that catalog so the spawn overlay doesn't import the tool module. */
export const OPERATOR_DIAG_TOOL_NAMES = [
  "herd_status",
  "repo_automation",
  "system_health",
  "logs_tail",
] as const;

/** The action groups, each a set of the assistant's action tools. ONE mapping: the server gate, the
 *  Claude rules and the UI all read it. */
export const ASSISTANT_ACTION_GROUPS = {
  steer: ["session_steer", "plan_answer"],
  start: ["session_start"],
  sessions: ["session_interrupt", "session_resume", "session_relaunch", "session_archive"],
  approve: ["plan_release", "queue_approve", "pr_ready", "pr_merge"],
  automation: [
    "repo_automation_set",
    "drain_enqueue",
    "session_automation_set",
    "epic_run_set",
    "held_task",
    "herd_halt",
    "herd_retry",
  ],
} as const;

export type AssistantActionGroup = keyof typeof ASSISTANT_ACTION_GROUPS;
const ASSISTANT_ACTION_GROUP_NAMES = Object.keys(ASSISTANT_ACTION_GROUPS) as AssistantActionGroup[];
export type AssistantActionTool = (typeof ASSISTANT_ACTION_GROUPS)[AssistantActionGroup][number];

export type AssistantPermissions = { shell: AssistantShellLevel } & Record<
  AssistantActionGroup,
  AssistantActionLevel
>;

/** Reads run without a prompt and so does starting a session; every other action asks. Also what an
 *  install with nothing stored gets — a stored set without `start` gets it on too. */
export const DEFAULT_ASSISTANT_PERMISSIONS: AssistantPermissions = {
  shell: "read",
  steer: "ask",
  start: "allow",
  sessions: "ask",
  approve: "ask",
  automation: "ask",
};

/** Diagnostic commands Claude does not count as read-only on its own, allowed at shell `read`.
 *  Prefix rules cannot exclude a flag, so only commands WITHOUT a write flag belong here — which
 *  is why `journalctl` (`--vacuum-*`, `--rotate`) and `ss` (`-K`) are left out. Claude's built-in
 *  read-only set (grep, cat, head, tail, find, wc, read-only git, …) needs no rule. */
const READ_DIAG_PREFIXES = [
  "ps",
  "pgrep",
  "readlink",
  "df",
  "free",
  "uptime",
  "systemctl status",
  "systemctl --user status",
  "systemctl show",
  "systemctl --user show",
];

/** Both forms per prefix: the bare command and the command with arguments. */
export const READ_DIAG_BASH = READ_DIAG_PREFIXES.flatMap((p) => [`Bash(${p})`, `Bash(${p} *)`]);

/** The MCP permission-rule name of one Shepherd tool. */
export const shepherdToolRule = (tool: string) => `mcp__shepherd__${tool}`;

/** The group a tool belongs to, or null for a tool that is not an action. */
export function actionGroupOf(tool: string): AssistantActionGroup | null {
  for (const group of ASSISTANT_ACTION_GROUP_NAMES) {
    if ((ASSISTANT_ACTION_GROUPS[group] as readonly string[]).includes(tool)) return group;
  }
  return null;
}

const KEYS = ["shell", ...ASSISTANT_ACTION_GROUP_NAMES] as const;

function isLevel(key: (typeof KEYS)[number], value: unknown): boolean {
  const levels: readonly string[] =
    key === "shell" ? ASSISTANT_SHELL_LEVELS : ASSISTANT_ACTION_LEVELS;
  return typeof value === "string" && levels.includes(value);
}

/** A partial patch (`{steer: "allow"}`), or the error to hand back. */
export function parseAssistantPermissionsPatch(
  raw: unknown,
): { ok: true; patch: Partial<AssistantPermissions> } | { ok: false; error: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "assistantPermissions must be an object" };
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) return { ok: false, error: "assistantPermissions must not be empty" };
  const patch: Partial<Record<(typeof KEYS)[number], string>> = {};
  for (const [key, value] of entries) {
    if (!(KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: `unknown assistant permission: ${key}` };
    }
    const k = key as (typeof KEYS)[number];
    if (!isLevel(k, value)) {
      const levels = k === "shell" ? ASSISTANT_SHELL_LEVELS : ASSISTANT_ACTION_LEVELS;
      return { ok: false, error: `${key} must be one of ${levels.join(", ")}` };
    }
    patch[k] = value as string;
  }
  return { ok: true, patch: patch as Partial<AssistantPermissions> };
}

/** A stored value (JSON text or null) as a complete permission set: every field that is missing
 *  or invalid falls back to its default, so a corrupt row never widens or blanks the assistant. */
export function normalizeStoredAssistantPermissions(raw: string | null): AssistantPermissions {
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  const stored = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const out = { ...DEFAULT_ASSISTANT_PERMISSIONS };
  for (const key of KEYS) {
    if (isLevel(key, stored[key])) (out as Record<string, unknown>)[key] = stored[key];
  }
  return out;
}

/** The `permissions` block of the assistant's `.claude/settings.local.json`. Only the rules that
 *  vary with the settings live here; the fixed ones (file edits and credential reads denied, the
 *  read tools allowed) ride the spawn's `--settings` overlay (operatorAssistantPermissions). */
export function assistantPermissionRules(p: AssistantPermissions): {
  allow: string[];
  ask: string[];
  deny: string[];
} {
  const rules = { allow: [] as string[], ask: [] as string[], deny: [] as string[] };
  if (p.shell === "off") rules.deny.push("Bash");
  else if (p.shell === "ask") rules.ask.push("Bash");
  else if (p.shell === "read") rules.allow.push(...READ_DIAG_BASH);
  else rules.allow.push("Bash");
  for (const group of ASSISTANT_ACTION_GROUP_NAMES) {
    const level = p[group];
    // `ask` is the server's prompt (an Action Request in the HUD, src/action-request.ts), not
    // Claude's: asking here too would make the operator approve every action twice.
    const bucket = level === "off" ? rules.deny : rules.allow;
    bucket.push(...ASSISTANT_ACTION_GROUPS[group].map(shepherdToolRule));
  }
  return rules;
}

export type AssistantMode = "readonly" | "asks" | "acts";

/** The panel chip's one-word summary: acts = something runs without asking (an allowed group or
 *  the whole shell); readonly = no action group is on; asks = everything else. */
export function assistantMode(p: AssistantPermissions): AssistantMode {
  if (p.shell === "all" || ASSISTANT_ACTION_GROUP_NAMES.some((g) => p[g] === "allow")) {
    return "acts";
  }
  if (ASSISTANT_ACTION_GROUP_NAMES.every((g) => p[g] === "off")) return "readonly";
  return "asks";
}
