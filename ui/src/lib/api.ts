import type {
  Session,
  CreateInput,
  HeldTask,
  HeldResult,
  RepoEntry,
  Issue,
  PullRequest,
  ActivityEntry,
  SessionUsage,
  UsageLimits,
  UsageLimitsResponse,
  UsageBreakdown,
  UsageTimeline,
  UsageRange,
  GithubRateLimit,
  GitState,
  PrStatus,
  MergeMethod,
  Settings,
  DirListing,
  ScratchListing,
  UpdateStatus,
  DeployState,
  DirtyStatus,
  HerdrUpdateStatus,
  CodexUpdateStatus,
  DiagnosticsSnapshot,
  PluginInfo,
  InstalledPlugin,
  PluginUpdatesStatus,
  StarPromptStatus,
  Steer,
  DiffResult,
  DiffAnnotationsResult,
  ProjectIcons,
  ReviewVerdict,
  PlanGate,
  ReviewerEnv,
  RepoConfig,
  PostMergeSteps,
  RepoRoles,
  ReadinessReport,
  DrainStatus,
  AutoMergeStatus,
  QueuedItem,
  BacklogPayload,
  SlashCommand,
  Leftover,
  Learning,
  RepoInjectable,
  MergeSuggestion,
  ForgeKind,
  WorkflowRun,
  WorkflowJob,
  SessionActivity,
  BlockReason,
  SubagentEntry,
  BuildQueue,
  BuildStepStatus,
  EpicDraft,
  PullResult,
  RelaunchOverrides,
  Epic,
  EpicRun,
  EpicSummary,
  EpicDiagnosis,
  Recap,
  CompletedEpic,
  HerdDigest,
  DistillerHealth,
  RawAnswer,
  DocAgentRun,
  HoldReason,
  AgentProvider,
  UpNextSnapshot,
  UpNextItem,
} from "./types";
import { m } from "$lib/paraglide/messages";
import { auth } from "$lib/auth.svelte";

const JSON_HEADERS = { "content-type": "application/json" };

/** 401 interceptor (issue #1079): any gated call rejected with 401 flips the shared auth flag so
 *  the root layout swaps to the login view. Mirrors the 403 → PreviewBlockedError pattern below.
 *  Returns `status === 401` so callers can short-circuit. */
function flagIfUnauthorized(status: number): boolean {
  if (status === 401) {
    auth.unauthenticated = true;
    return true;
  }
  return false;
}

/** Server's CSRF preview-origin rejection string. The HUD origin guard
 *  (`src/validate.ts` `classifyOrigin` → `checkOrigin`) returns
 *  `403 {error:"forbidden: origin not allowed"}` for any mutation from the live-preview
 *  port range — kept in sync here so the matched string stays discoverable. */
const ORIGIN_BLOCK = "forbidden: origin not allowed";

/** Server's CSRF host-not-allowlisted rejection string. `checkOrigin` returns
 *  `403 {error:"forbidden: origin host not allowed"}` when the HUD is reached on a host
 *  absent from `SHEPHERD_ALLOWED_HOSTS` (NOT a preview port). Distinct from {@link ORIGIN_BLOCK}
 *  so the copy can point the operator at the allowlist instead of blaming the preview (#1645). */
const ORIGIN_HOST_BLOCK = "forbidden: origin host not allowed";

/** Thrown when a mutation is rejected because it originated from the read-only live
 *  preview (CSRF origin guard). Detect via `isPreviewBlocked`/`instanceof`. */
class PreviewBlockedError extends Error {}

/** True when `e` is a preview-origin rejection (see {@link PreviewBlockedError}). */
export function isPreviewBlocked(e: unknown): boolean {
  return e instanceof PreviewBlockedError;
}

/** Build an Error from a failed response body. A `403` carrying the server's
 *  preview-origin rejection becomes a translated {@link PreviewBlockedError}; every
 *  other failure becomes an {@link ApiError} preferring the server `{error}` over `fallback`.
 *
 *  `serverAuthored` records the PROVENANCE of the message: true when it came from the response
 *  body (or is one of the translated 403s), false when `fallback` — the bare
 *  `"<label> failed: <status>"` plumbing string — was used because the response carried no body.
 *  A caller that surfaces `e.message` to a human MUST gate on it: a proxy 502/504 (or any severed
 *  upstream) yields a bodyless response, and rendering that fallback verbatim shows the operator
 *  "epic-draft approve failed: 502" instead of a real cause. Status alone can't stand in for this —
 *  a 500 from a handler that catches and reports (`{error: e.message}`) is genuinely informative.
 *
 *  An EMPTY `{error: ""}` counts as no message, not as an empty server-authored one: a handler that
 *  forwards `e.message` verbatim (e.g. approve's 500, src/server.ts) can emit one, and honouring it
 *  would render a BLANK toast instead of the generic failure. Hence the truthiness check. */
function apiError(
  status: number,
  body: { error?: string } | null | undefined,
  fallback: string,
): Error {
  flagIfUnauthorized(status);
  if (status === 403 && body?.error === ORIGIN_BLOCK) {
    return new PreviewBlockedError(m.error_preview_readonly());
  }
  if (status === 403 && body?.error === ORIGIN_HOST_BLOCK) {
    return new ApiError(status, m.error_origin_host_not_allowed(), undefined, true);
  }
  return new ApiError(status, body?.error || fallback, undefined, !!body?.error);
}

/** A failed API call that carries the HTTP `status` and the server's stable `code`
 *  discriminator (when present), so callers can branch on the failure mode without
 *  brittle message-matching (e.g. relaunch's `in_progress` / `issue_unresolved`). */
export class ApiError extends Error {
  status: number;
  code?: string;
  /** Whether `message` came from the server (a `{error}` body) rather than the bare
   *  `"<label> failed: <status>"` fallback. Gate on this before showing `message` to a human —
   *  see {@link apiError}. */
  serverAuthored: boolean;
  constructor(status: number, message: string, code?: string, serverAuthored = false) {
    super(message);
    this.status = status;
    this.code = code;
    this.serverAuthored = serverAuthored;
  }
}

/** Provenance of an error built by {@link apiError}, for the re-wrap sites that rebuild an
 *  {@link ApiError} to attach a `code`. Read it off the built error rather than re-deriving it from
 *  the body, so "server authored" has exactly one definition and cannot drift between call sites. */
const serverAuthored = (e: Error): boolean => e instanceof ApiError && e.serverAuthored;

/** Build an Error from a failed response, preferring the server's `{error}` body
 *  (e.g. "no active workspace") over the bare status code so the UI shows the real
 *  cause. Falls back to "<label> failed: <status>" when the body carries no message;
 *  a preview-origin 403 is remapped to a {@link PreviewBlockedError} via `apiError`. */
async function failed(r: Response, label: string): Promise<Error> {
  return apiError(r.status, await r.json().catch(() => null), `${label} failed: ${r.status}`);
}

/** GET a JSON resource, throwing `<label> failed: <status>` on a non-2xx response. */
async function getJson<T>(url: string, label: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) {
    flagIfUnauthorized(r.status);
    throw new Error(`${label} failed: ${r.status}`);
  }
  return r.json() as Promise<T>;
}

// ── single-operator auth (issue #1079) ──────────────────────────────────────

/** Boot probe: true when the current session cookie authenticates, false on 401. Never throws —
 *  a network error is treated as "unknown / not authenticated" so the layout shows the login view. */
export async function getMe(): Promise<boolean> {
  try {
    const r = await fetch("/api/me");
    return r.ok;
  } catch {
    return false;
  }
}

/** POST the operator password; on success the server sets the session cookie (HttpOnly, so JS never
 *  sees it). Returns true on 200; false on a 401 (wrong password). Throws on other failures. */
export async function login(password: string): Promise<boolean> {
  const r = await fetch("/api/login", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ password }),
  });
  if (r.ok) {
    auth.unauthenticated = false;
    return true;
  }
  if (r.status === 401) return false;
  throw await failed(r, "login");
}

/** Clear the session cookie server-side and flip the UI to the login view. */
export async function logout(): Promise<void> {
  try {
    await fetch("/api/logout", { method: "POST", headers: JSON_HEADERS });
  } finally {
    auth.unauthenticated = true;
  }
}

export async function listSessions(): Promise<Session[]> {
  const r = await fetch("/api/sessions");
  if (!r.ok) throw await failed(r, "list");
  return r.json();
}

export async function createSession(
  input: CreateInput & { force?: boolean },
): Promise<Session | HeldResult> {
  const r = await fetch("/api/sessions", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  if (!r.ok) throw await failed(r, "create");
  return r.json();
}

/** List tasks that are currently held (waiting for usage to reset). */
export async function listHeld(): Promise<HeldTask[]> {
  const r = await fetch("/api/held");
  if (!r.ok) throw await failed(r, "list held");
  return r.json();
}

/** Spawn a held task now (bypasses the usage hold). */
export async function spawnHeld(id: string, agentProvider?: AgentProvider): Promise<Session> {
  const r = await fetch(`/api/held/${id}/spawn`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(agentProvider ? { agentProvider } : {}),
  });
  if (!r.ok) throw await failed(r, "spawn held");
  return r.json();
}

/** Discard a held task without spawning it. */
export async function discardHeld(id: string): Promise<void> {
  const r = await fetch(`/api/held/${id}`, { method: "DELETE" });
  if (!r.ok) throw await failed(r, "discard held");
}

/** Replace a held task's input (operator edited it while it stays held). */
export async function updateHeld(id: string, input: CreateInput): Promise<HeldTask> {
  const r = await fetch(`/api/held/${id}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  if (!r.ok) throw await failed(r, "update held");
  return r.json();
}

// Toggle usage-aware task holding (pause new tasks when usage is high and a session is running).
export const putUsageHoldEnabled = (enabled: boolean): Promise<{ usageHoldEnabled: boolean }> =>
  patchSettings({ usageHoldEnabled: enabled });

// Persist the usage-hold threshold percentage (0–100). New tasks are held when
// the primary usage window is at or above this percentage.
export const putUsageHoldPct = (pct: number): Promise<{ usageHoldPct: number }> =>
  patchSettings({ usageHoldPct: pct });

// Toggle whether held tasks auto-start when usage drops below the threshold. When false,
// held tasks stay queued until the operator starts or discards each one manually.
export const putUsageHoldAutoRelease = (
  enabled: boolean,
): Promise<{ usageHoldAutoRelease: boolean }> => patchSettings({ usageHoldAutoRelease: enabled });

// Toggle usage-aware model downgrade (spawn every agent on the cheap model once usage is high).
export const putUsageDowngradeEnabled = (
  enabled: boolean,
): Promise<{ usageDowngradeEnabled: boolean }> => patchSettings({ usageDowngradeEnabled: enabled });

// Persist the downgrade threshold percentage (0–100). At/above it, spawns use the downgrade model.
export const putUsageDowngradePct = (pct: number): Promise<{ usageDowngradePct: number }> =>
  patchSettings({ usageDowngradePct: pct });

// Persist the model spawns downgrade to when usage is high (a default-model setting alias).
export const putUsageDowngradeModel = (model: string): Promise<{ usageDowngradeModel: string }> =>
  patchSettings({ usageDowngradeModel: model });

// Toggle whether Fable is globally available; when false, Fable-targeted tasks run on Opus (1M).
export const putFableAvailable = (value: boolean): Promise<{ fableAvailable: boolean }> =>
  patchSettings<{ fableAvailable: boolean }>({ fableAvailable: value });

// Toggle the global reduced-notifications mode (only ready-after-5s + cost alerts when on).
export const putReducedPushMode = (enabled: boolean): Promise<{ reducedPushMode: boolean }> =>
  patchSettings({ reducedPushMode: enabled });

// Opt the main session into Claude Code's fullscreen renderer (applies to new/resumed sessions).
export const putTuiFullscreen = (value: boolean): Promise<{ tuiFullscreen: boolean }> =>
  patchSettings<{ tuiFullscreen: boolean }>({ tuiFullscreen: value });

// Disable Claude Code mouse capture for the main session.
export const putTuiDisableMouse = (value: boolean): Promise<{ tuiDisableMouse: boolean }> =>
  patchSettings<{ tuiDisableMouse: boolean }>({ tuiDisableMouse: value });

// Toggle whether Up Next quick-start skips the "Choose coding CLI" picker and launches
// directly with the operator's default coding CLI.
export const putUpnextSkipCliPicker = (value: boolean): Promise<{ upnextSkipCliPicker: boolean }> =>
  patchSettings<{ upnextSkipCliPicker: boolean }>({ upnextSkipCliPicker: value });

/** Upload one file; returns its absolute server path. Pass sessionId to store it
 *  inside that session's worktree (live terminal); omit for New Task staging. */
export async function uploadFile(file: File, sessionId?: string): Promise<string> {
  const fd = new FormData();
  fd.append("file", file);
  const q = sessionId ? `?session=${encodeURIComponent(sessionId)}` : "";
  // no content-type header: the browser sets the multipart boundary
  const r = await fetch(`/api/uploads${q}`, { method: "POST", body: fd });
  if (!r.ok) throw await failed(r, "upload");
  return (await r.json()).path as string;
}

/** Backward-compatible image-attach helper. Callers must keep their own image filter. */
export const uploadImage = uploadFile;

/** Detection status of the optional `voice-whisper` plugin (local Whisper transcription). */
export interface VoiceStatus {
  available: boolean;
  engine: string | null;
  model: string | null;
  ffmpeg: boolean;
  language: string;
  /** When true, the mic should prefer local whisper even where Web Speech is supported. */
  preferLocal: boolean;
  hint: string;
}

const VOICE_ABSENT: VoiceStatus = {
  available: false,
  engine: null,
  model: null,
  ffmpeg: false,
  language: "auto",
  preferLocal: false,
  hint: "",
};

let voiceStatusPromise: Promise<VoiceStatus> | null = null;

/** Detection status of the voice-whisper plugin, memoized once per page load. A 404 (plugin
 *  not installed) or any error resolves to an "unavailable" status and is cached — so the
 *  compose-bar mic keeps the browser's Web Speech engine (or stays hidden) exactly as today,
 *  with just this one cached probe as the difference. */
export function getVoiceStatus(): Promise<VoiceStatus> {
  if (!voiceStatusPromise) {
    voiceStatusPromise = fetch("/api/plugins/voice-whisper/status")
      .then((r) => (r.ok ? (r.json() as Promise<VoiceStatus>) : VOICE_ABSENT))
      .catch(() => VOICE_ABSENT);
  }
  return voiceStatusPromise;
}

/** Transcribe a recorded audio clip via the voice-whisper plugin; returns the text. `lang`
 *  (`"de"`/`"en"`) pins the transcription language when the plugin isn't configured to force one.
 *  `opts.mode: "partial"` marks a disposable live-preview request — the plugin reserves a
 *  concurrency slot for non-partial (final) clips so previews can never 429-starve the one
 *  transcription the user actually keeps. The final clip must send no `mode` at all. */
export async function transcribeAudio(
  blob: Blob,
  lang?: string,
  opts?: { mode?: "partial" },
): Promise<string> {
  const fd = new FormData();
  fd.append("file", blob, "clip.webm");
  if (lang) fd.append("lang", lang);
  if (opts?.mode) fd.append("mode", opts.mode);
  // no content-type header: the browser sets the multipart boundary
  const r = await fetch("/api/plugins/voice-whisper/transcribe", { method: "POST", body: fd });
  if (!r.ok) throw await failed(r, "transcribe");
  return (await r.json()).text as string;
}

/** Leftover subprocesses/proxies that would survive this session's close; [] when none. */
export async function getLeftovers(id: string): Promise<Leftover[]> {
  const r = await fetch(`/api/sessions/${id}/leftovers`);
  if (!r.ok) throw await failed(r, "leftovers");
  return r.json();
}

/** Archive a session; pass leftover keys to also terminate those subprocesses. */
export async function archiveSession(id: string, reap?: string[]): Promise<void> {
  const init: RequestInit = { method: "DELETE" };
  if (reap?.length) {
    init.headers = JSON_HEADERS;
    init.body = JSON.stringify({ reap });
  }
  const r = await fetch(`/api/sessions/${id}`, init);
  if (!r.ok) throw await failed(r, "archive");
}

/** Merged-branch session ids + aggregate leftover count, for the clear-all confirm modal. */
export async function getMergedClearable(): Promise<{ ids: string[]; leftovers: number }> {
  const r = await fetch("/api/sessions/clear-merged");
  if (!r.ok) throw await failed(r, "merged clearable");
  return r.json();
}

/** Archive every merged-branch session (the given ids), terminating their leftover
 *  subprocesses. The server re-validates each id is merged before archiving. */
export async function clearMerged(
  ids: string[],
): Promise<{ cleared: string[]; leftovers: number }> {
  const r = await fetch("/api/sessions/clear-merged", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ ids }),
  });
  if (!r.ok) throw await failed(r, "clear merged");
  return r.json();
}

export async function listRepos(): Promise<{ repos: RepoEntry[]; recentWindowDays: number }> {
  const r = await fetch("/api/repos");
  if (!r.ok) throw await failed(r, "repos");
  return r.json();
}

/** POST JSON to `url`, throw a `failed` error on non-2xx, return the parsed response. */
async function postJson<T>(url: string, body: unknown, label: string): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  if (!r.ok) throw await failed(r, label);
  return r.json() as Promise<T>;
}

export async function cloneRepo(url: string): Promise<RepoEntry> {
  return postJson<RepoEntry>("/api/repos", { url }, "clone");
}

/** Fork a GitHub repo under the user's account and clone it locally.
 *  `target` is `owner/repo` or a GitHub URL. On a hard failure throws with
 *  `err.message` set to the server's `error` field (a `forkrepo_failed_*` code),
 *  so the modal can strip the prefix and map to its `msg(code)` switch — same
 *  contract as `cloneRepo`. */
export async function forkRepo(target: string): Promise<RepoEntry> {
  return postJson<RepoEntry>("/api/repos/fork", { target }, "fork");
}

/** Sync a fork's default branch with its upstream (`gh repo sync`) and fast-forward
 *  the local clone. Fork repos only. Resolves to the synced default branch name on
 *  success; on failure throws with `err.message` set to the server's `error` field
 *  (a `syncfork_failed_*` code) so the caller can map it to a toast message. */
export async function syncFork(repoPath: string): Promise<{ branch?: string }> {
  const r = await fetch("/api/repos/sync-fork", JSON_POST({ repo: repoPath }));
  if (!r.ok) {
    const msg = await r.json().catch(() => ({ error: `${r.status}` }));
    throw apiError(r.status, msg as { error?: string }, `error ${r.status}`);
  }
  return (await r.json().catch(() => ({}))) as { branch?: string };
}

/** Create a new local git project (optionally with a GitHub remote).
 *  On success returns a `RepoEntry` plus an optional `warning` when the local repo
 *  was created but the GitHub step failed (partial success — the modal treats this as
 *  success with a non-blocking hint, not a blocking error).
 *  On any hard failure throws with `err.message` set to the server's `error` field
 *  (a `newproject_failed_*` code) so the modal can strip the `newproject_failed_`
 *  prefix and map to its `msg(code)` switch — exactly the same contract as `cloneRepo`. */
export async function createProject(input: {
  name: string;
  idea: string;
  createRemote: boolean;
  visibility: "private" | "public";
  owner?: string;
}): Promise<RepoEntry & { warning?: string }> {
  return postJson<RepoEntry & { warning?: string }>("/api/projects", input, "newproject");
}

/** GitHub owners a new repo can be created under: the authenticated login plus the
 *  user's orgs. `login` is null when gh is unavailable/unauthed — callers then offer
 *  the personal account only (no owner picker). Never throws (degrades to no owners). */
export async function getGithubOwners(): Promise<{ login: string | null; orgs: string[] }> {
  try {
    return await getJson<{ login: string | null; orgs: string[] }>(
      "/api/github/owners",
      "github_owners",
    );
  } catch {
    return { login: null, orgs: [] };
  }
}

/** A GitHub repo the user can clone, as returned by GET /api/github/repos. */
export interface GithubRepo {
  nameWithOwner: string;
  owner: string;
  name: string;
  url: string;
  isPrivate: boolean;
  isFork: boolean;
  isArchived: boolean;
  pushedAt: string | null;
  /** True when a local repo already tracks this one (hidden from the clone picker). */
  cloned: boolean;
}

/** List the GitHub repos the user can clone — their own account plus any team/org
 *  repos they reach. `available` is false when gh is unavailable/unauthed, in which
 *  case the clone dialog falls back to the URL field. Never throws (degrades). */
export async function getGithubRepos(): Promise<{
  repos: GithubRepo[];
  login: string | null;
  available: boolean;
}> {
  try {
    return await getJson<{ repos: GithubRepo[]; login: string | null; available: boolean }>(
      "/api/github/repos",
      "github_repos",
    );
  } catch {
    return { repos: [], login: null, available: false };
  }
}

export async function getSettings(): Promise<Settings> {
  const r = await fetch("/api/settings");
  if (!r.ok) throw await failed(r, "settings");
  return r.json();
}

// Standalone settings patch: PUT exactly the given fields to /api/settings, throw the
// server's error message on failure, and return the parsed response. The server routes
// by which field is present — a bare {repoRoot} is the repo-root change; any other single
// field is its own validating patch.
async function patchSettings<T>(patch: Record<string, unknown>): Promise<T> {
  const r = await fetch("/api/settings", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  });
  if (!r.ok) {
    const msg = await r.json().catch(() => ({ error: `${r.status}` }));
    throw apiError(r.status, msg as { error?: string }, `error ${r.status}`);
  }
  return r.json();
}

export const putSettings = (repoRoot: string): Promise<Settings> =>
  patchSettings<Settings>({ repoRoot });

// Toggle Claude Code Remote Control auto-start for Shepherd-spawned sessions.
export const putRemoteControl = (enabled: boolean): Promise<{ remoteControlAtStartup: boolean }> =>
  patchSettings({ remoteControlAtStartup: enabled });

// Toggle the daily session-housekeeping sweep (prune of old archived sessions).
export const putSessionHousekeeping = (
  enabled: boolean,
): Promise<{ sessionHousekeepingEnabled: boolean }> =>
  patchSettings({ sessionHousekeepingEnabled: enabled });

// Toggle auto-revive of stranded default-account sessions after a herdr daemon restart (#1630).
export const putAutoRevive = (enabled: boolean): Promise<{ autoReviveEnabled: boolean }> =>
  patchSettings({ autoReviveEnabled: enabled });

// Force-resume every currently-stranded session ("revive all"). Returns per-batch counts.
export async function reviveStranded(): Promise<{ revived: number; failed: number }> {
  const r = await fetch("/api/revive-stranded", { method: "POST" });
  if (!r.ok) throw await failed(r, "revive stranded");
  return r.json();
}

// Set anonymous-telemetry consent ("granted" | "denied"). Server persists + live-applies.
export const putTelemetryConsent = (
  consent: "granted" | "denied",
): Promise<{ telemetryConsent: string }> => patchSettings({ telemetryConsent: consent });

// Persist the global PR review-cycles cap (max PR-critic auto-address rounds). The
// server clamps the value into its valid range and returns the stored value.
export const putPrReviewCyclesCap = (cap: number): Promise<{ prReviewCyclesCap: number }> =>
  patchSettings({ prReviewCyclesCap: cap });

// Persist the global plan review-cycles cap (max plan-gate revise rounds). The
// server clamps the value into its valid range and returns the stored value.
export const putPlanReviewCyclesCap = (cap: number): Promise<{ planReviewCyclesCap: number }> =>
  patchSettings({ planReviewCyclesCap: cap });

// Persist the operator's configured default model (drives the New Task picker
// preselect and autonomous drain/autopilot auto-spawns).
export const putDefaultModel = (model: string): Promise<{ defaultModel: string }> =>
  patchSettings<{ defaultModel: string }>({ defaultModel: model });

export const putDefaultCodexModel = (model: string): Promise<{ defaultCodexModel: string }> =>
  patchSettings<{ defaultCodexModel: string }>({ defaultCodexModel: model });

export const putDefaultEffort = (effort: string): Promise<{ defaultEffort: string }> =>
  patchSettings<{ defaultEffort: string }>({ defaultEffort: effort });

// Persist the language spawned agents use to talk to the operator ("en" | "de").
export const putOperatorLanguage = (lang: string): Promise<{ operatorLanguage: string }> =>
  patchSettings<{ operatorLanguage: string }>({ operatorLanguage: lang });

export const putDefaultAgentProvider = (
  provider: AgentProvider,
): Promise<{ defaultAgentProvider: AgentProvider }> =>
  patchSettings<{ defaultAgentProvider: AgentProvider }>({ defaultAgentProvider: provider });

// The per-role ENVIRONMENT settings the Settings UI can override: `<role>Cli`
// ("inherit" | "claude" | "codex"), `<role>Model` ("default" | <alias>), and `<role>Effort`.
// The server validates + persists each independently and echoes the stored value under the same key.
export type RoleBase =
  | "critic"
  | "planner"
  | "recap"
  | "rundown"
  | "docAgent"
  | "namer"
  | "autopilot"
  | "distiller"
  | "optimizer"
  | "mergeSuggest";
export type RoleCliKey = `${RoleBase}Cli`;
export type RoleModelKey = `${RoleBase}Model`;
export type RoleEffortKey = `${RoleBase}Effort`;

// Persist a single per-role CLI setting. The server echoes the stored value under the same key.
export const putRoleCli = (
  key: RoleCliKey,
  cli: string,
): Promise<Partial<Record<RoleCliKey, string>>> => patchSettings({ [key]: cli });

// Persist a single per-role model setting. The server echoes the stored value under the same key.
export const putRoleModel = (
  key: RoleModelKey,
  model: string,
): Promise<Partial<Record<RoleModelKey, string>>> => patchSettings({ [key]: model });

// Persist a single per-role effort setting. The server echoes the stored value under the same key.
export const putRoleEffort = (
  key: RoleEffortKey,
  effort: string,
): Promise<Partial<Record<RoleEffortKey, string>>> => patchSettings({ [key]: effort });

export const putDistillerIntervalDays = (
  days: number,
): Promise<{ distillerIntervalDays: number }> => patchSettings({ distillerIntervalDays: days });

// Switch how spawned agents authenticate (subscription OAuth vs. metered API key).
export const putAuthMode = (mode: string): Promise<{ authMode: string; hasApiKey: boolean }> =>
  patchSettings({ authMode: mode });

// Set (or clear, with null) the Anthropic API key. The server stores only the path
// to a helper it writes; the raw key never round-trips back to the client.
export const putAnthropicApiKey = (key: string | null): Promise<{ hasApiKey: boolean }> =>
  patchSettings({ anthropicApiKey: key });

// Probe whether the stored API key actually authenticates a spawned agent. The server
// runs a short, throwaway claude auth check and returns only the verdict — never the key.
// `reason` codes a known failure (not-authenticated/timeout/not-configured/…); `detail`
// (present on not-authenticated) is a verbatim claude auth-error string surfaced as data.
export const verifyApiKey = (): Promise<{ ok: boolean; reason?: string; detail?: string }> =>
  postJson("/api/settings/verify-key", {}, "verify-key");

// Persist the account-wide extra-credit (paid overage) spend ceiling. Auto-drain/autopilot
// pauses when measured spend strictly exceeds it; 0 = pause on any spend. The server
// validates a non-negative number and returns the stored value.
export const putExtraCreditsDrainCeiling = (
  ceiling: number,
): Promise<{ extraCreditsDrainCeiling: number }> =>
  patchSettings({ extraCreditsDrainCeiling: ceiling });

export async function listDirs(path?: string): Promise<DirListing> {
  const q = path ? `?path=${encodeURIComponent(path)}` : "";
  const r = await fetch(`/api/fs/dirs${q}`);
  if (!r.ok) throw await failed(r, "dirs");
  return r.json();
}

/** List one directory of a session's read-only scratchpad subtree (#1164). `path` is relative
 *  to the scratchpad root ("" / undefined = root). */
export async function getScratchpadListing(id: string, path?: string): Promise<ScratchListing> {
  const q = path ? `?path=${encodeURIComponent(path)}` : "";
  const r = await fetch(`/api/sessions/${id}/scratchpad${q}`);
  if (!r.ok) throw await failed(r, "scratchpad");
  return r.json();
}

/** Same-origin download URL for one scratchpad file (#1164). Used as a plain `<a href download>`
 *  target — the operator's HttpOnly auth cookie rides the GET automatically. */
export function scratchpadDownloadUrl(id: string, path: string): string {
  return `/api/sessions/${id}/scratchpad/download?path=${encodeURIComponent(path)}`;
}

/** List one directory of a session's read-only worktree subtree. `path` is relative to the
 *  worktree root ("" / undefined = root). `.git` is hidden server-side. */
export async function getWorktreeListing(id: string, path?: string): Promise<ScratchListing> {
  const q = path ? `?path=${encodeURIComponent(path)}` : "";
  const r = await fetch(`/api/sessions/${id}/worktree${q}`);
  if (!r.ok) throw await failed(r, "worktree");
  return r.json();
}

/** Same-origin download URL for one worktree file. Used as a plain `<a href download>` target. */
export function worktreeDownloadUrl(id: string, path: string): string {
  return `/api/sessions/${id}/worktree/download?path=${encodeURIComponent(path)}`;
}

/** Upload one arbitrary file into a session's scratchpad dir (#1258). Returns the root-relative path.
 *  Throws an ApiError so callers can branch on status (e.g. 413 = too large, max 10 MB). */
export async function uploadScratchpadFile(
  id: string,
  file: File,
  dirPath?: string,
): Promise<string> {
  const fd = new FormData();
  fd.append("file", file);
  const q = dirPath ? `?path=${encodeURIComponent(dirPath)}` : "";
  const r = await fetch(`/api/sessions/${id}/scratchpad/upload${q}`, { method: "POST", body: fd });
  if (!r.ok) {
    const body = (await r.json().catch(() => null)) as { error?: string } | null;
    // No `code` to attach here, so `base` (already an ApiError, or a PreviewBlockedError) is exactly
    // what a re-wrap would produce.
    throw apiError(r.status, body, `upload failed: ${r.status}`);
  }
  return (await r.json()).path as string;
}

export interface BranchList {
  branches: string[];
  current: string | null;
  /** Repo default branch (`origin/HEAD`); null when unset. */
  default: string | null;
}

export async function listBranches(repoPath: string): Promise<BranchList> {
  const r = await fetch(`/api/branches?repo=${encodeURIComponent(repoPath)}`);
  if (!r.ok) throw await failed(r, "branches");
  return r.json();
}

/**
 * The base branch a new task should default to: the repo default branch (origin/HEAD),
 * falling back to the current checkout, then the most-recent branch, then "main".
 * Single source for every New Task / quick-launch / merge-train spawn site.
 */
export function pickBaseBranch(b: BranchList | null | undefined): string {
  return b?.default ?? b?.current ?? b?.branches?.[0] ?? "main";
}

export async function branchStatus(
  repoPath: string,
  branch: string,
): Promise<{
  behind: number;
  ahead: number;
  diverged: boolean;
  hasUpstream: boolean;
  localExists: boolean;
}> {
  const r = await fetch(
    `/api/branch-status?repo=${encodeURIComponent(repoPath)}&branch=${encodeURIComponent(branch)}`,
  );
  if (!r.ok) throw await failed(r, "branch status");
  return r.json();
}

export async function initEmptyCommit(
  repoPath: string,
  branch: string,
): Promise<{ branch: string }> {
  const r = await fetch("/api/repos/init-empty-commit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo: repoPath, branch }),
  });
  if (!r.ok) throw await failed(r, "init empty commit");
  return r.json();
}

export async function getTodo(repoPath: string): Promise<{ exists: boolean; content: string }> {
  const r = await fetch(`/api/todo?repo=${encodeURIComponent(repoPath)}`);
  if (!r.ok) throw await failed(r, "todo get");
  return r.json();
}

export async function putTodo(repoPath: string, content: string): Promise<void> {
  const r = await fetch(`/api/todo?repo=${encodeURIComponent(repoPath)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!r.ok) throw await failed(r, "todo put");
}

export async function getSessionUsage(id: string): Promise<SessionUsage> {
  const r = await fetch(`/api/sessions/${id}/usage`);
  if (!r.ok) throw await failed(r, "usage");
  return r.json();
}

export async function getActivity(id: string): Promise<ActivityEntry[]> {
  const r = await fetch(`/api/sessions/${id}/activity`);
  if (!r.ok) throw await failed(r, "activity");
  return r.json();
}

export async function getDiff(id: string): Promise<DiffResult> {
  const r = await fetch(`/api/sessions/${id}/diff`);
  if (!r.ok) throw await failed(r, "diff");
  return r.json();
}

/** Per-line Diff-tab annotations (#1699). Best-effort chrome — the caller fetches it on diff-load
 *  + manual refresh (NOT on the 15s poll) and tolerates failure (renders the diff without notes).
 *  The server already degrades to `{ notes: [] }` on any internal error. */
export async function getDiffAnnotations(id: string): Promise<DiffAnnotationsResult> {
  const r = await fetch(`/api/sessions/${id}/diff/annotations`);
  if (!r.ok) throw await failed(r, "diff annotations");
  return r.json();
}

export async function getUsageLimits(): Promise<UsageLimitsResponse> {
  const r = await fetch("/api/usage/limits");
  if (!r.ok) throw await failed(r, "limits");
  return r.json();
}

export async function getUsageBreakdown(range: UsageRange): Promise<UsageBreakdown> {
  const r = await fetch(`/api/usage/breakdown?range=${range}`);
  if (!r.ok) throw await failed(r, "breakdown");
  return r.json();
}

export async function getUsageTimeline(range: UsageRange): Promise<UsageTimeline> {
  const r = await fetch(`/api/usage/timeline?range=${range}`);
  if (!r.ok) throw await failed(r, "timeline");
  return r.json();
}

export async function refreshUsage(): Promise<UsageLimits> {
  const r = await fetch("/api/usage/refresh", { method: "POST" });
  if (!r.ok) throw await failed(r, "refresh");
  return r.json();
}

export async function getGithubRateLimit(): Promise<GithubRateLimit> {
  const r = await fetch("/api/usage/github");
  if (!r.ok) throw await failed(r, "github");
  return r.json();
}

export async function replySession(id: string, text: string): Promise<void> {
  const r = await fetch(`/api/sessions/${id}/reply`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ text }),
  });
  if (!r.ok) throw await failed(r, "reply");
}

/** A next-prompt recommendation: the suggested prompt, or a stable error code the
 *  RecommendDialog maps to a localized message. Never throws — the dialog needs a
 *  distinct error state, not a crash. */
export type RecommendResult = { prompt: string } | { error: string };

/**
 * Ask the server to analyze a session's recent terminal history via a transient second
 * agent (claude `opus` / codex `gpt-5.5`) and return a recommended next prompt. Long-running
 * (the analysis spawns a real agent), so callers must show a loading state.
 */
export async function recommendPrompt(
  id: string,
  provider: AgentProvider,
  model: string,
): Promise<RecommendResult> {
  const r = await fetch(`/api/sessions/${id}/recommend-prompt`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ provider, model }),
  });
  const data = (await r.json().catch(() => null)) as {
    prompt?: unknown;
    error?: unknown;
  } | null;
  if (r.ok && data && typeof data.prompt === "string") return { prompt: data.prompt };
  return { error: data && typeof data.error === "string" ? data.error : "timeout" };
}

/**
 * Bring a finished session back — re-spawns the provider's resume in its worktree.
 * `force` tears down a surviving husk shell first, for the case the provider exited but
 * its herdr tab is still alive (so the session lists as idle, not gone).
 */
export async function resumeSession(id: string, force = false): Promise<Session> {
  const init: RequestInit = { method: "POST" };
  if (force) {
    init.headers = JSON_HEADERS;
    init.body = JSON.stringify({ force: true });
  }
  const r = await fetch(`/api/sessions/${id}/resume`, init);
  if (!r.ok) {
    const msg = await r.json().catch(() => ({ error: `${r.status}` }));
    throw apiError(r.status, msg as { error?: string }, `resume failed: ${r.status}`);
  }
  return r.json();
}

/**
 * Relaunch a task: spawn a fresh replacement carrying the original's prompt and
 * all per-task settings, then decommission the original. Returns the new session
 * plus `archived` (false when the new task spawned but the original's teardown
 * failed — surfaced so it isn't a silent success). On a non-ok response throws an
 * {@link ApiError} carrying the HTTP `status` and the server's stable `code`
 * (`in_progress` / `issue_unresolved`) so the caller can pick the right toast.
 */
export async function relaunchSession(
  id: string,
  overrides?: RelaunchOverrides,
): Promise<{ session: Session; archived: boolean }> {
  const init: RequestInit = { method: "POST" };
  // With overrides, POST a JSON body (server relaunches into the new repo/settings);
  // without, keep the bare POST so the quick-relaunch path is byte-for-byte unchanged.
  if (overrides) {
    init.headers = JSON_HEADERS;
    init.body = JSON.stringify(overrides);
  }
  const r = await fetch(`/api/sessions/${id}/relaunch`, init);
  if (r.ok) return r.json();
  const body = (await r.json().catch(() => null)) as { error?: string; code?: string } | null;
  // Keep the preview-origin 403 remap (and its translated message) consistent with
  // the rest of the API; for every other failure carry status + code to the caller.
  const base = apiError(r.status, body, `relaunch failed: ${r.status}`);
  if (isPreviewBlocked(base)) throw base;
  throw new ApiError(r.status, base.message, body?.code, serverAuthored(base));
}

export type HandoffMode = "resume" | "summarize";

/** Provider/model choice for variant, comparison, or in-place continuation actions. */
export interface VariantChoice {
  agentProvider?: AgentProvider;
  model: string | null;
  effort?: string | null;
  handoffMode?: HandoffMode;
}

/** Continue the session with another agent CLI/model, keeping the same Shepherd session + worktree. */
export async function replaceSessionAgent(id: string, choice: VariantChoice): Promise<Session> {
  const { session } = await postJson<{ session: Session }>(
    `/api/sessions/${id}/replace`,
    choice,
    "replace",
  );
  return session;
}

/**
 * Start a parallel comparison VARIANT of a session: same task, different model/CLI. The original
 * stays alive; both are linked into one comparison experiment. Returns the new variant session.
 */
export async function startVariant(id: string, choice: VariantChoice): Promise<Session> {
  const { session } = await postJson<{ session: Session }>(
    `/api/sessions/${id}/variant`,
    choice,
    "variant",
  );
  return session;
}

/**
 * Start the read-only comparison session for an experiment: a fresh agent that reads every
 * variant's branch/diff/PR and writes a structured comparison. Returns the comparison session.
 */
export async function startComparison(
  experimentId: string,
  choice: VariantChoice,
): Promise<Session> {
  const { session } = await postJson<{ session: Session }>(
    `/api/experiments/${experimentId}/compare`,
    choice,
    "compare",
  );
  return session;
}

/**
 * Restore an archived session from the Done lens: re-creates the worktree on its
 * surviving branch and resumes the conversation. Returns the restored `Session` on
 * success. On a non-ok response throws an {@link ApiError} carrying the HTTP `status`
 * and the server's stable `code` so the caller can branch on the failure mode.
 */
export async function restoreSession(id: string): Promise<Session> {
  const r = await fetch(`/api/sessions/${id}/restore`, { method: "POST" });
  if (r.ok) return r.json();
  const body = (await r.json().catch(() => null)) as { error?: string; code?: string } | null;
  const base = apiError(r.status, body, `restore failed: ${r.status}`);
  if (isPreviewBlocked(base)) throw base; // else the 403 loses its PreviewBlockedError class
  throw new ApiError(r.status, base.message, body?.code, serverAuthored(base));
}

/**
 * Stage the original session's uploads for a relaunch-elsewhere so the composer
 * can seed them as removable chips. Returns the carried attachments (server path +
 * display name); throws a `failed` error on a non-2xx response.
 */
export async function stageRelaunchImages(
  id: string,
): Promise<{ path: string; name: string | null; nameRecorded: boolean }[]> {
  const r = await fetch(`/api/sessions/${id}/relaunch-uploads`, { method: "POST" });
  if (!r.ok) throw await failed(r, "relaunch-uploads");
  const body = (await r.json()) as {
    images?: { path: string; name: string | null; nameRecorded: boolean }[];
  };
  return body.images ?? [];
}

/** Toggle the operator "ready to merge" flag. Live state returns via the
 *  session:ready WS event, so callers fire-and-forget. */
export async function setReadyToMerge(id: string, ready: boolean): Promise<void> {
  const r = await fetch(`/api/sessions/${id}/ready`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ ready }),
  });
  if (!r.ok) throw await failed(r, "ready");
}

export async function listIssues(repoPath: string): Promise<{
  slug: string | null;
  webUrl: string | null;
  issues: Issue[];
  /** The operator's own login on the repo's forge, or null when it can't be
   *  resolved (offline/unauth/local forge). Drives the "mine & unassigned"
   *  filter (#824); null → fail open (show all). */
  viewer: string | null;
  /** Set when the forge listing threw (missing/un-authed CLI, network, or a
   *  rate-limited forge): the empty issues[] is a failure, not a genuine zero.
   *  Lets the UI distinguish "couldn't load" from "no open issues". */
  error?: string | null;
}> {
  const r = await fetch(`/api/issues?repo=${encodeURIComponent(repoPath)}`);
  if (!r.ok) throw await failed(r, "issues");
  return r.json();
}

export async function getRepoWeb(repoPath: string): Promise<{
  slug: string | null;
  webUrl: string | null;
  kind: ForgeKind | null;
}> {
  const r = await fetch(`/api/repo-web?repo=${encodeURIComponent(repoPath)}`);
  if (!r.ok) throw await failed(r, "repo web");
  return r.json();
}

export async function listPullRequests(
  repoPath: string,
): Promise<{ slug: string | null; webUrl: string | null; prs: PullRequest[] }> {
  const r = await fetch(`/api/prs?repo=${encodeURIComponent(repoPath)}`);
  if (!r.ok) throw await failed(r, "prs");
  return r.json();
}

/** Latest Actions run per workflow on a repo's default branch (any forge that
 *  supports Actions — GitHub + Gitea/Forgejo), with per-job breakdown where the
 *  forge exposes one. The caller gates UI on the capability flags:
 *  `supportsActions` (can list runs), `canRerun` / `canCancel` (REST controls). */
export async function listWorkflowRuns(repoPath: string): Promise<{
  slug: string | null;
  webUrl: string | null;
  kind: ForgeKind | null;
  runs: WorkflowRun[];
  supportsActions: boolean;
  canRerun: boolean;
  canCancel: boolean;
}> {
  const r = await fetch(`/api/actions?repo=${encodeURIComponent(repoPath)}`);
  if (!r.ok) throw await failed(r, "actions");
  return r.json();
}

/** Prior runs of one workflow on the default branch (summary rows; `jobs` empty).
 *  GitHub only — other forges return no runs. `limit` caps how many are fetched. */
export async function listWorkflowRunHistory(
  repoPath: string,
  workflowId: number,
  limit: number,
): Promise<{ runs: WorkflowRun[] }> {
  const r = await fetch(
    `/api/actions/history?repo=${encodeURIComponent(repoPath)}&workflowId=${workflowId}&limit=${limit}`,
  );
  if (!r.ok) throw await failed(r, "actions history");
  return r.json();
}

/** Per-job breakdown for a single run, lazy-loaded when a history row expands. */
export async function listRunJobs(
  repoPath: string,
  runId: number,
): Promise<{ jobs: WorkflowJob[] }> {
  const r = await fetch(
    `/api/actions/run-jobs?repo=${encodeURIComponent(repoPath)}&runId=${runId}`,
  );
  if (!r.ok) throw await failed(r, "run jobs");
  return r.json();
}

/** Merge a backlog PR by repo + number (no session). Resolves on success. */
export async function mergeBacklogPr(
  repoPath: string,
  number: number,
  body?: { method?: MergeMethod; deleteBranch?: boolean },
): Promise<void> {
  const r = await fetch("/api/prs/merge", JSON_POST({ repo: repoPath, number, ...body }));
  if (!r.ok) {
    const msg = await r.json().catch(() => ({ error: `${r.status}` }));
    throw apiError(r.status, msg as { error?: string }, `error ${r.status}`);
  }
}

/** Fast-forward a repo's local default-branch checkout after a merge. Returns the
 *  PullResult body regardless of HTTP status (fail-closed states are data, not throws);
 *  only a network/parse failure collapses to { ok:false, reason:"error" }. */
export async function pullRepo(repoPath: string, branch?: string): Promise<PullResult> {
  try {
    const r = await fetch("/api/repos/pull", JSON_POST({ repo: repoPath, branch }));
    return (await r.json()) as PullResult;
  } catch {
    return { ok: false, reason: "error" };
  }
}

/** Post the opt-in "@dependabot rebase" command on a stuck Dependabot backlog PR
 *  by repo + number. Resolves on success. */
export async function requestDependabotRebase(repoPath: string, number: number): Promise<void> {
  const r = await fetch("/api/prs/dependabot-rebase", JSON_POST({ repo: repoPath, number }));
  if (!r.ok) {
    const msg = await r.json().catch(() => ({ error: `${r.status}` }));
    throw apiError(r.status, msg as { error?: string }, `error ${r.status}`);
  }
}

/** Re-run a GitHub Actions run by repo + runId. `failedOnly` retries just the
 *  failed jobs (set when the run failed); else the whole run. Resolves on success. */
export async function rerunWorkflowRun(
  repoPath: string,
  runId: number,
  failedOnly = false,
): Promise<void> {
  const r = await fetch("/api/actions/rerun", JSON_POST({ repo: repoPath, runId, failedOnly }));
  if (!r.ok) {
    const msg = await r.json().catch(() => ({ error: `${r.status}` }));
    throw apiError(r.status, msg as { error?: string }, `error ${r.status}`);
  }
}

/** One-click "Retry CI" for a `ci-red` hold: resolve the PR head's latest failed run server-side
 *  then rerun its failed jobs. `unsupported` (non-GitHub forge) / `no-run` (nothing to retry) are
 *  expected outcomes returned as `{ ok:false, reason }` on HTTP 200; a genuine forge/transport
 *  error throws (non-2xx), so the caller catches it as a generic failure. */
export async function retryCi(
  repoPath: string,
  pr: number,
): Promise<{ ok: boolean; reason?: "unsupported" | "no-run" }> {
  const r = await fetch("/api/actions/retry-ci", JSON_POST({ repo: repoPath, pr }));
  if (!r.ok) {
    const msg = await r.json().catch(() => ({ error: `${r.status}` }));
    throw apiError(r.status, msg as { error?: string }, `error ${r.status}`);
  }
  return (await r.json()) as { ok: boolean; reason?: "unsupported" | "no-run" };
}

/** Cancel an in-progress GitHub Actions run by repo + runId. Resolves on success. */
export async function cancelWorkflowRun(repoPath: string, runId: number): Promise<void> {
  const r = await fetch("/api/actions/cancel", JSON_POST({ repo: repoPath, runId }));
  if (!r.ok) {
    const msg = await r.json().catch(() => ({ error: `${r.status}` }));
    throw apiError(r.status, msg as { error?: string }, `error ${r.status}`);
  }
}

/** Installed slash commands (skills + command files) for the New Task picker. */
export async function getCommands(
  repoPath: string,
  opts: { provider?: AgentProvider } = {},
): Promise<{ commands: SlashCommand[] }> {
  const params = new URLSearchParams();
  if (repoPath) params.set("repo", repoPath);
  if (opts.provider) params.set("provider", opts.provider);
  const qs = params.toString();
  const r = await fetch(`/api/commands${qs ? `?${qs}` : ""}`);
  if (!r.ok) throw await failed(r, "commands");
  return r.json();
}

const JSON_POST = (body?: unknown): RequestInit => ({
  method: "POST",
  headers: JSON_HEADERS,
  body: body === undefined ? undefined : JSON.stringify(body),
});

/** Read PR/CI/deploy state for a session's branch, or null when no forge is configured. */
export async function gitState(id: string): Promise<GitState | null> {
  const r = await fetch(`/api/sessions/${id}/git`);
  if (r.status === 404) return null;
  if (!r.ok) throw await failed(r, "git status");
  return r.json();
}

/** Flip an open session PR between draft and ready-for-review. The server emits
 *  `session:git` after the forge confirms the new state, so callers don't need to
 *  mutate the list snapshot optimistically. */
export async function setPrDraftState(id: string, draft: boolean): Promise<GitState> {
  const r = await fetch(`/api/sessions/${id}/git/${draft ? "draft" : "ready"}`, JSON_POST());
  if (!r.ok) {
    const body = (await r.json().catch(() => null)) as { code?: string; error?: string } | null;
    if (!draft && body?.code === "draft_awaiting_signoff") {
      throw new Error(m.prbadge_ready_needs_signoff());
    }
    throw apiError(
      r.status,
      body,
      `${draft ? "mark PR draft" : "mark PR ready"} failed: ${r.status}`,
    );
  }
  return r.json();
}

/** Snapshot of every active session's PR state, keyed by session id (for the
 *  list overview). Empty object when no forge is configured anywhere. */
export async function gitStates(): Promise<Record<string, GitState>> {
  const r = await fetch("/api/git");
  if (!r.ok) throw await failed(r, "git states");
  return r.json();
}

/** Snapshot of the last-emitted activity signal per running session, keyed by
 *  session id (for client bootstrap). Empty object when nothing is running. */
export async function activityStates(): Promise<Record<string, SessionActivity>> {
  const r = await fetch("/api/activity");
  if (!r.ok) throw await failed(r, "activity states");
  return r.json();
}

/** Snapshot of per-session claude-process liveness, keyed by session id (for
 *  client bootstrap). `true` = a `claude` process still lives in the session's
 *  worktree; `false` = it exited (husk shell — Resume applies). A session absent
 *  from the map hasn't been swept yet. */
export async function claudeAliveStates(): Promise<Record<string, boolean>> {
  const r = await fetch("/api/claude-alive");
  if (!r.ok) throw await failed(r, "claude liveness");
  return r.json();
}

/** Currently-stranded session ids (herdr-restored husks), for client bootstrap. The boolean
 *  claude-alive snapshot folds these to `husk`; these ids let a reloading client reconstruct the
 *  `stranded` 3-state (the banner + "agent died — revive" framing) without waiting for a flip (#1630). */
export async function strandedStates(): Promise<string[]> {
  const r = await fetch("/api/stranded");
  if (!r.ok) throw await failed(r, "stranded sessions");
  return r.json();
}

/** Snapshot of the working-while-blocked display flags, keyed by session id (for
 *  client bootstrap; mirror of /api/claude-alive). `true` = herdr reports the
 *  session "blocked" but the server saw it resume mid-turn (herdr's blocked
 *  latch) — display-only, feeds `displayStatus` and nothing behavioral. */
export async function workingBlockedStates(): Promise<Record<string, boolean>> {
  const r = await fetch("/api/working-blocked");
  if (!r.ok) throw await failed(r, "working-blocked states");
  return r.json();
}

/** Snapshot of the last-emitted block reason per session, keyed by session id (client
 *  bootstrap). Blocks are otherwise edge-emitted via `session:block`, so a fresh page load
 *  / push-then-open needs this to surface a live block (incl. an MCP-auth `authUrl`). */
export async function blockStates(): Promise<Record<string, BlockReason>> {
  const r = await fetch("/api/blocks");
  if (!r.ok) throw await failed(r, "block states");
  return r.json();
}

/** Snapshot of per-session hold reasons keyed by session id (client bootstrap). */
export async function holdStates(): Promise<Record<string, HoldReason>> {
  const r = await fetch("/api/holds");
  if (!r.ok) throw await failed(r, "hold reasons");
  return r.json();
}

/** Snapshot of the per-session sub-agent roster, keyed by session id (for client
 *  bootstrap). Each value is the session's `SubagentEntry[]` (an entry with no
 *  `endedAt` is still live). Empty object when nothing is running. */
export async function subagentStates(): Promise<Record<string, SubagentEntry[]>> {
  const r = await fetch("/api/subagents");
  if (!r.ok) throw await failed(r, "subagent states");
  return r.json();
}

/** Snapshot of the bound preview-listener port per session, keyed by session id
 *  (for client bootstrap). `previewPort` is null when the server knows of no
 *  live dev-server listener. Empty object when nothing is bound. */
export async function previewStates(): Promise<
  Record<string, { previewPort: number | null; serve?: "ok" | "failed" }>
> {
  const r = await fetch("/api/preview");
  if (!r.ok) throw await failed(r, "preview states");
  return r.json();
}

async function gitJson<T = PrStatus>(res: Response): Promise<T> {
  if (!res.ok) {
    const msg = await res.json().catch(() => ({ error: `${res.status}` }));
    throw apiError(res.status, msg as { error?: string }, `error ${res.status}`);
  }
  return res.json();
}

export async function openPr(
  id: string,
  body?: { title?: string; body?: string },
): Promise<PrStatus> {
  return gitJson(await fetch(`/api/sessions/${id}/git/pr`, JSON_POST(body ?? {})));
}

export async function mergePr(
  id: string,
  body?: { method?: MergeMethod; deleteBranch?: boolean },
): Promise<PrStatus> {
  return gitJson(await fetch(`/api/sessions/${id}/git/merge`, JSON_POST(body ?? {})));
}

/** Rename a session. The server slugifies the name, renames the git branch (and a
 *  GitHub PR's remote branch when one is open), and broadcasts `session:renamed`.
 *  `branchRenamed` is false when an open PR on a non-retargetable host (Gitea) forced
 *  a display-only rename. Rejects with `name_taken` when the target branch exists. */
export async function renameSession(
  id: string,
  name: string,
): Promise<{ session: Session; branchRenamed: boolean; prRetargeted: boolean }> {
  return gitJson(await fetch(`/api/sessions/${id}/rename`, JSON_POST({ name })));
}

/** Current self-update status (how far the running checkout is behind main). */
export async function getUpdate(): Promise<UpdateStatus> {
  const r = await fetch("/api/update");
  if (!r.ok) throw await failed(r, "update status");
  return r.json();
}

/** Live state of the detached deploy (running / done / failed + captured log),
 *  so the UI can surface *why* an update failed instead of a bare status code. */
export async function getUpdateLog(): Promise<DeployState> {
  const r = await fetch("/api/update/log");
  if (!r.ok) throw await failed(r, "update log");
  return r.json();
}

/** Fresh dirty snapshot of the running deployment's repo (never cached), so the
 *  update modal can warn before a discard and re-check after a stale failure. */
export async function getUpdateDirty(): Promise<DirtyStatus> {
  const r = await fetch("/api/update/dirty");
  if (!r.ok) throw await failed(r, "update dirty status");
  return r.json();
}

/** Thrown by {@link applyUpdate} when the server rejects a discard because the
 *  tree drifted from what the operator confirmed (HTTP 409 `stale`). Carries the
 *  fresh {@link DirtyStatus} so the modal can re-render and ask for re-confirmation. */
export class StaleDirtyError extends Error {
  constructor(readonly dirty: DirtyStatus) {
    super("stale");
    this.name = "StaleDirtyError";
  }
}

/** Current herdr-version update status (whether a newer herdr exists). */
export async function getHerdrUpdate(): Promise<HerdrUpdateStatus> {
  const r = await fetch("/api/herdr-update");
  if (!r.ok) throw await failed(r, "herdr update status");
  return r.json();
}

/** Current codex-version update status (whether a newer @openai/codex exists). */
export async function getCodexUpdate(): Promise<CodexUpdateStatus> {
  const r = await fetch("/api/codex-update");
  if (!r.ok) throw await failed(r, "codex update status");
  return r.json();
}

/** Current installed-plugin update status (informational; which plugins have a
 *  newer released version and which can be checked at all). */
export async function getPluginUpdates(): Promise<PluginUpdatesStatus> {
  const r = await fetch("/api/plugin-update");
  if (!r.ok) throw await failed(r, "plugin update status");
  return r.json();
}

/** Force a fresh plugin-update scan NOW (each plugin hits its git remote, so this can
 *  take seconds). The server also broadcasts the snapshot on `plugin-update:status`,
 *  which is what re-renders the UI — callers await this mainly for a busy state. */
export async function checkPluginUpdates(): Promise<PluginUpdatesStatus> {
  const r = await fetch("/api/plugin-update/check", { method: "POST" });
  if (!r.ok) throw await failed(r, "plugin update check");
  return r.json();
}

/** Result of a successful in-place plugin update (mirror of the server's apply response).
 *  `restartRequired` is true when the plugin was already running and its new code can only
 *  load on the next restart; `plugin` is the freshly-activated PluginInfo otherwise. `status`
 *  is the recomputed update snapshot so the badge/list refresh without a second round-trip. */
export interface PluginUpdateApplied {
  ok: true;
  restartRequired: boolean;
  updatedTo: string;
  plugin?: PluginInfo;
  status: PluginUpdatesStatus;
}

/** Apply an available update to a plugin in place: the server fetches the new version, swaps
 *  it on disk, and re-activates it. Discriminated result — `error` is a stable server CODE
 *  the caller maps to a message (mirrors {@link installPlugin}); `detail` is the server's
 *  verbatim diagnostic (e.g. the git error) so a failure is diagnosable, not just generic. */
export async function applyPluginUpdate(
  id: string,
): Promise<
  { ok: true; result: PluginUpdateApplied } | { ok: false; error: string; detail?: string }
> {
  const r = await fetch("/api/plugin-update/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  });
  const body = (await r.json().catch(() => ({}))) as Partial<PluginUpdateApplied> & {
    error?: string;
    detail?: string;
  };
  if (r.ok && body.ok) return { ok: true, result: body as PluginUpdateApplied };
  flagIfUnauthorized(r.status);
  return {
    ok: false,
    error: typeof body.error === "string" ? body.error : "update_failed",
    ...(typeof body.detail === "string" && body.detail ? { detail: body.detail } : {}),
  };
}

/** Current environment-readiness diagnostics; `refresh` forces a re-probe. */
export async function getDiagnostics(refresh = false): Promise<DiagnosticsSnapshot> {
  const r = await fetch(`/api/diagnostics${refresh ? "?refresh=1" : ""}`);
  if (!r.ok) throw await failed(r, "diagnostics");
  return r.json();
}

/** Loaded server-side plugins (issue #1124). Empty array when none — the UI hides the
 *  Settings → Plugins tab. 404-safe: a build without the registry returns `{plugins:[]}`. */
export async function getPlugins(): Promise<PluginInfo[]> {
  const r = await fetch("/api/plugins");
  if (!r.ok) throw await failed(r, "plugins");
  const body = (await r.json()) as { plugins: PluginInfo[] };
  return body.plugins ?? [];
}

/** All plugin FOLDERS on disk (the Settings → Plugins manager list), including
 *  pending-restart, soft-disabled, and broken folders — not just loaded plugins. */
export async function getInstalledPlugins(): Promise<InstalledPlugin[]> {
  const r = await fetch("/api/plugins/manage/installed");
  if (!r.ok) throw await failed(r, "installed plugins");
  const body = (await r.json()) as { installed: InstalledPlugin[] };
  return body.installed ?? [];
}

/** Install a plugin by GitHub URL. Returns a discriminated result — `error` is a stable
 *  server-side CODE (e.g. `url_not_github`, `id_collision`) the caller maps to a message,
 *  never raw text — so a bad URL surfaces inline rather than throwing. */
export async function installPlugin(
  url: string,
): Promise<
  | { ok: true; plugin: { id: string; name: string; version: string; folder: string } }
  | { ok: false; error: string }
> {
  const r = await fetch("/api/plugins/manage/install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const body = (await r.json().catch(() => ({}))) as {
    plugin?: { id: string; name: string; version: string; folder: string };
    error?: string;
  };
  if (r.ok && body.plugin) return { ok: true, plugin: body.plugin };
  flagIfUnauthorized(r.status);
  return { ok: false, error: typeof body.error === "string" ? body.error : "install_failed" };
}

/** Uninstall a plugin folder. Returns a discriminated result mirroring {@link installPlugin}. */
export async function uninstallPlugin(
  folder: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await fetch(`/api/plugins/manage/installed/${encodeURIComponent(folder)}`, {
    method: "DELETE",
  });
  if (r.ok) return { ok: true };
  flagIfUnauthorized(r.status);
  const body = (await r.json().catch(() => ({}))) as { error?: string };
  return { ok: false, error: typeof body.error === "string" ? body.error : "uninstall_failed" };
}

/** Activate an installed plugin folder in-process (no restart). On success returns the
 *  resulting {@link PluginInfo} — its `health` may be `errored`, so callers must inspect it
 *  rather than assume the plugin is live. Mirrors {@link installPlugin}'s discriminated result. */
export async function activatePlugin(
  folder: string,
): Promise<{ ok: true; plugin: PluginInfo } | { ok: false; error: string }> {
  const r = await fetch("/api/plugins/manage/activate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ folder }),
  });
  const body = (await r.json().catch(() => ({}))) as { plugin?: PluginInfo; error?: string };
  if (r.ok && body.plugin) return { ok: true, plugin: body.plugin };
  flagIfUnauthorized(r.status);
  return { ok: false, error: typeof body.error === "string" ? body.error : "activate_failed" };
}

/** Invoke a plugin-registered route at `/api/plugins/<id>/<path>` with the given method.
 *  On success, returns the trimmed response text (capped to 200 chars; longer responses are
 *  sliced to 199 chars with a trailing "…"). Strings are verbatim plugin-authored DATA.
 *
 *  `body` (issue #1209, the `action-button` node) is plugin-authored opaque JSON sent
 *  verbatim. It is attached ONLY for a POST — a GET fetch with a body throws TypeError, so
 *  even a mis-paired caller never reaches that footgun. No-body callers (gear routes) are
 *  unchanged: no Content-Type header, no request body. */
export async function invokePluginRoute(
  id: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<string> {
  const init: RequestInit = { method };
  if (method === "POST" && body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const r = await fetch(`/api/plugins/${id}/${path}`, init);
  if (!r.ok) throw await failed(r, "plugin route");
  const text = (await r.text()).trim();
  return text.length > 200 ? text.slice(0, 199) + "…" : text;
}

/** Run the verbatim remediation for a diagnostics check, then return the re-probed
 *  snapshot. Throws (via failed/apiError) on a non-2xx — the caller surfaces it as an
 *  explicit failure, never a silent pass. */
export async function fixDiagnostic(checkId: string): Promise<DiagnosticsSnapshot> {
  const r = await fetch("/api/diagnostics/fix", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ checkId }),
  });
  if (!r.ok) throw await failed(r, "diagnostics fix");
  return r.json();
}

/** Trigger `herdr update` (restarts herdr → ends live sessions → restarts shepherd). */
export async function applyHerdrUpdate(): Promise<void> {
  const r = await fetch("/api/herdr-update", { method: "POST", headers: JSON_HEADERS });
  if (!r.ok) {
    const msg = await r.json().catch(() => ({ error: `${r.status}` }));
    throw apiError(r.status, msg as { error?: string }, `error ${r.status}`);
  }
}

/** Trigger the in-app herdr downgrade to the highest supported version — the rescue
 *  for installs stranded on an unsupported herdr (0.7.5+, #1898). Restarts the herdr
 *  server; Shepherd stays up. */
export async function applyHerdrDowngrade(): Promise<void> {
  const r = await fetch("/api/herdr-update/downgrade", { method: "POST", headers: JSON_HEADERS });
  if (!r.ok) {
    const msg = await r.json().catch(() => ({ error: `${r.status}` }));
    throw apiError(r.status, msg as { error?: string }, `error ${r.status}`);
  }
}

/** Trigger `codex update` (non-destructive: running panes keep their loaded
 *  build; only new codex sessions pick up the new version). */
export async function applyCodexUpdate(): Promise<void> {
  const r = await fetch("/api/codex-update", { method: "POST", headers: JSON_HEADERS });
  if (!r.ok) {
    const msg = await r.json().catch(() => ({ error: `${r.status}` }));
    throw apiError(r.status, msg as { error?: string }, `error ${r.status}`);
  }
}

/** Restart the shepherd service in place (optionally preceded by a graceful
 *  `herdr server live-handoff` — agent panes survive the daemon swap). 202 means
 *  the detached restart launched; the caller detects completion by /api/health
 *  answering again. Discriminated result — `error` is a stable server CODE
 *  (`not_systemd`, `already_restarting`, …) the caller maps to a message. */
export async function triggerRestart(opts: {
  herdr: boolean;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await fetch("/api/restart", JSON_POST({ herdr: opts.herdr }));
  if (r.ok) return { ok: true };
  flagIfUnauthorized(r.status);
  const body = (await r.json().catch(() => ({}))) as { error?: string };
  return { ok: false, error: typeof body.error === "string" ? body.error : "restart_failed" };
}

/** Trigger the deploy script (pull → rebuild → restart). Server restarts on success.
 *  `discard` runs a scoped `git restore` of the confirmed dirty paths first; `sig`
 *  is the signature of the dirty state the operator confirmed. On a 409 `stale`
 *  response (tree drifted since confirmation) throws {@link StaleDirtyError} with
 *  the fresh dirty status so the modal can re-render + re-confirm. */
export async function applyUpdate(discard = false, sig?: string): Promise<void> {
  const r = await fetch("/api/update", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(discard ? { discard, sig } : {}),
  });
  if (!r.ok) {
    const msg = (await r.json().catch(() => ({ error: `${r.status}` }))) as {
      error?: string;
      dirty?: DirtyStatus;
    };
    if (r.status === 409 && msg.error === "stale" && msg.dirty)
      throw new StaleDirtyError(msg.dirty);
    throw apiError(r.status, msg, `error ${r.status}`);
  }
}

export async function redeploy(id: string): Promise<void> {
  const r = await fetch(`/api/sessions/${id}/git/redeploy`, JSON_POST());
  if (!r.ok) {
    const msg = await r.json().catch(() => ({ error: `${r.status}` }));
    throw apiError(r.status, msg as { error?: string }, `error ${r.status}`);
  }
}

export async function getSteers(): Promise<Steer[]> {
  const r = await fetch("/api/steers");
  if (!r.ok) throw await failed(r, "steers");
  return r.json();
}

export async function putSteers(steers: Steer[]): Promise<Steer[]> {
  const r = await fetch("/api/steers", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify(steers),
  });
  if (!r.ok) {
    const msg = await r.json().catch(() => ({ error: `${r.status}` }));
    throw apiError(r.status, msg as { error?: string }, `error ${r.status}`);
  }
  return r.json();
}

export async function broadcast(
  text: string,
  ids: string[],
): Promise<{ delivered: number; queued: number; offline: number; total: number }> {
  const r = await fetch("/api/broadcast", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ text, ids }),
  });
  if (!r.ok) throw await failed(r, "broadcast");
  return r.json();
}

/** Resume usage-halted sessions. Sends `text` as a steer to each selected session
 *  (resume) and steers them to continue. Returns counts of resumed/steered/total. */
export async function retryHalted(
  ids: string[],
  text: string,
): Promise<{ resumed: number; steered: number; total: number }> {
  const r = await fetch("/api/retry", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ ids, text }),
  });
  if (!r.ok) throw await failed(r, "retry");
  return r.json();
}

/** Fleet-wide emergency stop: interrupt every live working agent at once. No body —
 *  the server computes the target set. Returns how many panes were halted. */
export async function halt(): Promise<{ halted: number }> {
  const r = await fetch("/api/halt", { method: "POST" });
  if (!r.ok) throw await failed(r, "halt");
  return r.json();
}

export async function getProjectIcons(): Promise<ProjectIcons> {
  const r = await fetch("/api/project-icons");
  if (!r.ok) throw await failed(r, "project-icons");
  return r.json();
}

export async function putProjectIcon(path: string, emoji: string): Promise<ProjectIcons> {
  const r = await fetch("/api/project-icons", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ path, emoji }),
  });
  if (!r.ok) {
    const msg = await r.json().catch(() => ({ error: `${r.status}` }));
    throw apiError(r.status, msg as { error?: string }, `error ${r.status}`);
  }
  return r.json();
}

export async function getReviews(): Promise<Record<string, ReviewVerdict>> {
  return getJson("/api/reviews", "reviews");
}

/** In-flight critic reviews with the environment used by each reviewer job. */
export async function getReviewingIds(): Promise<Array<{ id: string } & ReviewerEnv>> {
  return getJson("/api/reviews/inflight", "reviewing");
}

/** Snapshot of every session's plan-gate verdict, keyed by session id (bootstrap). */
export async function getPlanGates(): Promise<Record<string, PlanGate>> {
  return getJson("/api/plan-gates", "plan-gates");
}

/** In-flight plan reviews with their reviewer env (bootstrap for the reviewing indicator + the
 *  CLI/model identity shown on the in-flight button). */
export async function getPlanGatesInflight(): Promise<Array<{ id: string } & ReviewerEnv>> {
  return getJson("/api/plan-gates/inflight", "plan-gates inflight");
}

/** Snapshot of every session's recap, keyed by session id (bootstrap; excludes empty rows). */
export async function getRecaps(): Promise<Record<string, Recap>> {
  return getJson("/api/recaps", "recaps");
}

/** Sessions archived within the Done-lens window (last 48h), newest-first. */
export async function getDoneSessions(): Promise<Session[]> {
  return getJson("/api/sessions/done", "done sessions");
}

/** Latest Herd Rundown digest (with route-computed `staleCount`), or `null` if none. */
export async function getHerdDigest(): Promise<HerdDigest | null> {
  return getJson("/api/herd/digest", "herd digest");
}

/** Trigger a fresh Herd Rundown digest. Returns `{ok, status}` from the server. */
export async function regenerateHerdDigest(): Promise<{ ok: boolean; status: string }> {
  return postJson("/api/herd/digest/regenerate", {}, "regenerate herd digest");
}

/** Up Next snapshot. By default (lens-open) the server also kicks a background recompute;
 *  pass `peek` to paint the cached snapshot only (app-load), costing zero cross-repo `gh`. */
export async function getUpNext(opts?: { peek?: boolean }): Promise<UpNextSnapshot | null> {
  return getJson(opts?.peek ? "/api/up-next?peek=1" : "/api/up-next", "up next");
}

/** Force an Up Next recompute (the manual refresh button). */
export async function refreshUpNext(): Promise<{ ok: boolean }> {
  return postJson("/api/up-next/refresh", {}, "refresh up next");
}

/** Start one or many Up Next items. Spawns are serialized server-side. */
export type UpNextStartChoice = {
  agentProvider?: AgentProvider;
  model?: string | null;
  effort?: string | null;
};

export async function startUpNext(
  items: { repoPath: string; issueRef: UpNextItem["issueRef"] }[],
  choice?: UpNextStartChoice,
): Promise<{
  created: Session[];
  held: { id: string; repoPath: string; number: number; reused?: boolean }[];
  errors: { number: number; error: string }[];
}> {
  return postJson("/api/up-next/start", { items, ...(choice ?? {}) }, "start up next");
}

/** Trigger a recap regeneration for a session. Returns `{status}` from the server. */
export async function regenerateRecap(id: string): Promise<{ status: string }> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(id)}/recap/regenerate`, {
    method: "POST",
    headers: JSON_HEADERS,
  });
  if (!r.ok) throw await failed(r, "regenerate recap");
  return r.json();
}

/** Release an approved plan gate so the agent executes. Returns false on 409 (not approved). */
export async function releasePlanGate(id: string): Promise<boolean> {
  const r = await fetch(`/api/sessions/${id}/go`, JSON_POST());
  return r.ok;
}

/** Outcome of an on-demand plan review trigger: a reviewer spawned, the request was a silent
 *  no-op (plan unchanged / already approved), the plan artifact is unavailable, or a spawn attempt
 *  failed with a specific cause. Mirrors the server's PlanReviewTrigger so the UI can distinguish a
 *  dedupe from a genuine error and name that error.
 *
 *  `"started-at-cap"` is a real run whose findings will NOT be re-steered to the planning agent if it
 *  requests changes — the rework streak is already at the cap, so the operator needs Resume (#1759).
 *  Everything that only asks "did a run start?" must go through `planReviewStarted`. */
export type PlanReviewError = "error-spawn" | "error-worktree" | "error-auth";
export type PlanReviewTrigger =
  "started" | "started-at-cap" | "skipped" | "plan-unavailable" | PlanReviewError;

/** True for every outcome in which a reviewer actually spawned. Use this instead of `=== "started"`:
 *  the plan-review consumers all narrow explicitly, so a raw comparison silently drops the at-cap case
 *  (no WS bridge, no note, no toast) and a real run reads as though nothing happened. */
export function planReviewStarted(s: PlanReviewTrigger): boolean {
  return s === "started" || s === "started-at-cap";
}

/** Type guard: true for any failed-spawn outcome. The compact entry points (rail, hold-row, badge
 *  menu) show one generic failure toast for all three causes; only PlanPanel narrows on the guard
 *  to name the specific cause. */
export function isPlanReviewError(s: PlanReviewTrigger): s is PlanReviewError {
  return s === "error-spawn" || s === "error-worktree" || s === "error-auth";
}

/** Trigger an on-demand plan review (202). Fire-and-forget; verdict returns via WS.
 *  Returns the trigger outcome so the caller can tell a real review from a silent dedupe
 *  ("skipped") and a genuine spawn failure (any `error-*` code, via `isPlanReviewError`). */
export async function reviewPlan(id: string): Promise<PlanReviewTrigger> {
  const r = await fetch(`/api/sessions/${id}/review-plan`, JSON_POST());
  if (!r.ok) throw await failed(r, "review-plan");
  const body = (await r.json().catch(() => ({}))) as { status?: PlanReviewTrigger };
  return body.status ?? "skipped";
}

export type PlanQuotaResumeStatus = "resumed" | "unreachable" | "not-stalled" | (string & {});
export type PlanQuotaDismissStatus = "dismissed" | "not-stalled" | (string & {});

/** Resume a quota-stalled plan gate. Status decides whether the PTY was reached. */
export async function resumeQuota(id: string): Promise<{ status: PlanQuotaResumeStatus }> {
  const r = await fetch(`/api/sessions/${id}/quota/resume`, JSON_POST());
  if (!r.ok) throw await failed(r, "quota resume");
  const body = (await r.json().catch(() => ({}))) as { status?: string };
  return { status: body.status ?? "not-stalled" };
}

/** Dismiss a quota-stalled plan gate without steering the findings back to the agent. */
export async function dismissQuota(id: string): Promise<{ status: PlanQuotaDismissStatus }> {
  const r = await fetch(`/api/sessions/${id}/quota/dismiss`, JSON_POST());
  if (!r.ok) throw await failed(r, "quota dismiss");
  const body = (await r.json().catch(() => ({}))) as { status?: string };
  return { status: body.status ?? "not-stalled" };
}

/** Submit operator answers to a plan's question-form (#803). The server resolves them against the
 *  gate's persisted questions, composes a steer, and delivers it to the live planning agent.
 *  Returns whether the steer reached the PTY (`delivered:false` ⇒ the planning pane is gone).
 *  Throws on non-2xx (e.g. 409 once the session leaves the planning phase). */
export async function answerPlanQuestions(
  id: string,
  answers: RawAnswer[],
): Promise<{ delivered: boolean }> {
  const r = await fetch(`/api/sessions/${id}/answer-plan-questions`, JSON_POST({ answers }));
  if (!r.ok) throw await failed(r, "answer-plan-questions");
  const body = (await r.json().catch(() => ({}))) as { delivered?: boolean };
  return { delivered: body.delivered === true };
}

export type PrReviewTrigger = "started" | "skipped" | "error";

/** Trigger an on-demand critic PR review (202). Fire-and-forget; the REVIEWING state and
 *  verdict return via WS. Returns the trigger outcome so the caller can tell a real start
 *  ("started") from a server decline ("skipped") and a spawn failure ("error"). */
export async function reviewPr(id: string): Promise<PrReviewTrigger> {
  const r = await fetch(`/api/sessions/${id}/review-pr`, JSON_POST());
  if (!r.ok) throw await failed(r, "review-pr");
  const body = (await r.json().catch(() => ({}))) as { status?: PrReviewTrigger };
  return body.status ?? "skipped";
}

export async function getBacklog(): Promise<BacklogPayload> {
  const r = await fetch("/api/backlog");
  if (!r.ok) throw await failed(r, "backlog");
  return r.json();
}

export async function getReadiness(repoPath: string): Promise<ReadinessReport> {
  return getJson(`/api/readiness?repo=${encodeURIComponent(repoPath)}`, "readiness");
}

/** Open a PR adding Shepherd's `.shepherd-*` session artifacts to the repo's
 *  `.gitignore` (only for repos you can push to; otherwise they're already hidden
 *  locally via git exclude). Resolves to the server's outcome:
 *  - `applied` — a PR was opened (`prUrl` carries its link),
 *  - `already`  — the entries are already present in `.gitignore` (no-op),
 *  - `no-access` — a forge exists but no push access; hidden locally only,
 *  - `no-forge` — no git forge configured for the repo; hidden locally only.
 *  Throws the server's `{error}` body on a non-2xx response (see `failed`). */
export async function adoptGitignore(repoPath: string): Promise<{
  status: "applied" | "already" | "no-access" | "no-forge";
  prUrl?: string;
  error?: string;
}> {
  const r = await fetch(`/api/adopt-gitignore?repo=${encodeURIComponent(repoPath)}`, {
    method: "POST",
    headers: JSON_HEADERS,
  });
  if (!r.ok) throw await failed(r, "adopt-gitignore");
  return r.json();
}

export type RepoConfigResponse = RepoConfig & {
  automationConfirmed?: boolean;
  automationRowExists?: boolean;
};

export async function getRepoConfig(repoPath: string): Promise<RepoConfigResponse> {
  return getJson(`/api/repo-config?repo=${encodeURIComponent(repoPath)}`, "repo-config");
}

export async function putRepoConfig(
  repoPath: string,
  patch: Partial<
    Pick<
      RepoConfig,
      | "criticEnabled"
      | "criticAllPrs"
      | "autoAddressEnabled"
      | "learningsEnabled"
      | "autopilotEnabled"
      | "autoDrainEnabled"
      | "autoMergeEnabled"
      | "planGateEnabled"
      | "signoffAuthority"
      | "sandboxProfile"
      | "defaultModel"
      | "maxAuto"
      | "autoLabel"
      | "usageCeilingPct"
      | "repoMode"
      | "autoOptimizeFlagged"
      | "criticSmellLensEnabled"
      | "manualStepsIssueEnabled"
      | "preWarmEpicLandingCi"
      | "hidden"
      | "previewStartScript"
      | "previewStartCommand"
      | "previewOpenMode"
    >
  > & { automationConfirmed?: boolean },
): Promise<RepoConfigResponse> {
  const r = await fetch(`/api/repo-config?repo=${encodeURIComponent(repoPath)}`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`repo-config put failed: ${r.status}`);
  return r.json();
}

export async function getRepoRoles(
  repoPath: string,
): Promise<{ roles: RepoRoles; me: string | null }> {
  return getJson(`/api/repo-roles?repo=${encodeURIComponent(repoPath)}`, "repo-roles");
}

export async function putRepoRoles(
  repoPath: string,
  patch: Partial<RepoRoles>,
): Promise<{ roles: RepoRoles; me: string | null; pushError?: string }> {
  const r = await fetch(`/api/repo-roles?repo=${encodeURIComponent(repoPath)}`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  });
  const data = (await r.json().catch(() => ({}))) as {
    roles?: RepoRoles;
    me?: string | null;
    pushError?: string;
  };
  // 502 carries a pushError (protected branch / no auth) — return it so the dialog
  // can surface the failure rather than throwing an opaque error.
  if (!r.ok && !data.pushError) throw new Error(`repo-roles put failed: ${r.status}`);
  return {
    roles: data.roles ?? { reviewer: null, merger: null },
    me: data.me ?? null,
    pushError: data.pushError,
  };
}

export async function getRepoCollaborators(
  repoPath: string,
): Promise<{ logins: string[]; me: string | null; collaboratorsUnavailable: boolean }> {
  return getJson(
    `/api/repo-collaborators?repo=${encodeURIComponent(repoPath)}`,
    "repo-collaborators",
  );
}

export async function getDrain(): Promise<DrainStatus[]> {
  return getJson("/api/drain", "drain");
}

/** The backlog issues behind a repo's `queued` count — fetched lazily when the
 *  QueueStrip popover opens (the drain:status WS event stays count-only). */
export async function getDrainQueue(repoPath: string): Promise<QueuedItem[]> {
  return getJson(`/api/drain/queue?repo=${encodeURIComponent(repoPath)}`, "drain-queue");
}

export async function setSessionAutopilot(id: string, enabled: boolean | null): Promise<void> {
  const r = await fetch(`/api/sessions/${id}/autopilot`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!r.ok) throw new Error(`autopilot toggle failed: ${r.status}`);
}

/** Bootstrap: per-repo automerge status (mirrors GET /api/drain). */
export async function getAutoMerge(): Promise<AutoMergeStatus[]> {
  return getJson("/api/automerge", "automerge");
}

export async function getPendingLearnings(): Promise<Learning[]> {
  const r = await fetch("/api/learnings/pending");
  if (!r.ok) throw await failed(r, "learnings");
  return r.json();
}

/** Per-repo injected/active house rules with budget meter data, for the drawer's
 *  "Injected house rules" view. One entry per repo with ≥1 active/promoted rule. */
export async function getInjectableLearnings(): Promise<RepoInjectable[]> {
  const r = await fetch("/api/learnings/injectable");
  if (!r.ok) throw await failed(r, "injectable learnings");
  return r.json();
}

export async function getLearningsHealth(): Promise<DistillerHealth> {
  const r = await fetch("/api/learnings/health");
  if (!r.ok) throw await failed(r, "learnings health");
  return r.json();
}

export async function approveLearning(id: string, rule?: string): Promise<Learning> {
  const r = await fetch(`/api/learnings/${id}/approve`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(rule !== undefined ? { rule } : {}),
  });
  if (!r.ok) throw await failed(r, "approve");
  return r.json();
}

export async function dismissLearning(id: string): Promise<Learning> {
  const r = await fetch(`/api/learnings/${id}/dismiss`, { method: "POST", headers: JSON_HEADERS });
  if (!r.ok) throw await failed(r, "dismiss");
  return r.json();
}

export async function distillRepo(repoPath: string): Promise<void> {
  const r = await fetch(`/api/learnings/distill?repo=${encodeURIComponent(repoPath)}`, {
    method: "POST",
    headers: JSON_HEADERS,
  });
  if (!r.ok) throw await failed(r, "distill");
}

/** Promote an active rule into the repo's CLAUDE.md via an auto-opened PR.
 *  Returns the PR url; the rule flips to `promoted` server-side. */
export async function promoteLearning(id: string): Promise<{ url: string }> {
  const r = await fetch(`/api/learnings/${id}/promote`, { method: "POST", headers: JSON_HEADERS });
  if (!r.ok) throw await failed(r, "promote");
  return r.json();
}

/** Snapshot of every session's build queue that has ≥1 step, keyed by session
 *  id (for the Herd list overview). Sessions with no steps are absent. */
export async function getBuildQueues(): Promise<Record<string, BuildQueue>> {
  const r = await fetch("/api/queues");
  if (!r.ok) throw await failed(r, "build queues");
  return r.json();
}

/** Optimize a single flagged ("not working") rule via the LLM rewrite pass. Fire-and-forget;
 *  the WS learnings:update event refreshes the drawer when the run finalizes. */
export async function optimizeLearning(id: string): Promise<void> {
  const r = await fetch(`/api/learnings/${id}/optimize`, { method: "POST", headers: JSON_HEADERS });
  if (!r.ok) throw await failed(r, "optimize");
}

/** Set (or clear, with `[]`) a rule's glob scope (#842). Returns the updated rule;
 *  the drawer reloads on the learnings:update event. */
export async function setLearningScope(id: string, globs: string[]): Promise<Learning> {
  const r = await fetch(`/api/learnings/${id}/scope`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ globs }),
  });
  if (!r.ok) throw await failed(r, "scope");
  return r.json();
}

/** Restore a retired learning rule back to active. */
export async function restoreLearning(id: string): Promise<Learning> {
  const r = await fetch(`/api/learnings/${id}/restore`, { method: "POST", headers: JSON_HEADERS });
  if (!r.ok) throw await failed(r, "restore");
  return r.json();
}

/** Revert an auto-trial back to the proposed queue or dismiss it. Trial-only server-side. */
export async function revertTrialLearning(
  id: string,
  target: "proposed" | "dismissed",
): Promise<Learning> {
  const r = await fetch(`/api/learnings/${id}/revert-trial`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ target }),
  });
  if (!r.ok) throw await failed(r, "revert-trial");
  return (await r.json()) as Learning;
}

/** Mark retired learnings as seen for a repo (clears the unseen banner). */
export async function markRetiredSeen(repoPath: string): Promise<void> {
  const r = await fetch(`/api/learnings/seen-retired?repo=${encodeURIComponent(repoPath)}`, {
    method: "POST",
    headers: JSON_HEADERS,
  });
  if (!r.ok) throw await failed(r, "seen-retired");
}

// ── Phase 4 merge suggestions ───────────────────────────────────────────────

/** Pending background merge suggestions (intra-repo consolidation + cross-repo recurrence),
 *  each with hydrated member rules. */
export async function getMergeSuggestions(): Promise<MergeSuggestion[]> {
  const r = await fetch("/api/learnings/merge-suggestions");
  if (!r.ok) throw await failed(r, "merge suggestions");
  return r.json();
}

/** Apply an intra-repo merge suggestion: consolidate the group into its survivor and
 *  soft-retire the rest. The drawer reloads on the learnings:update event. */
export async function applyMergeSuggestion(suggestionId: string): Promise<void> {
  const r = await fetch(`/api/learnings/merge`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ suggestionId }),
  });
  if (!r.ok) throw await failed(r, "merge");
}

/** Dismiss a merge suggestion (intra or cross); the same group won't be re-suggested. */
export async function dismissMergeSuggestion(suggestionId: string): Promise<void> {
  const r = await fetch(`/api/learnings/merge-dismiss`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ suggestionId }),
  });
  if (!r.ok) throw await failed(r, "merge dismiss");
}

/** Promote a cross-repo recurrence rule into the user-global ~/.claude/CLAUDE.md (#872).
 *  Operator-confirmed; writes directly (no PR). Marks the suggestion applied server-side. */
export async function promoteGlobalLearning(suggestionId: string): Promise<void> {
  const r = await fetch(`/api/learnings/promote-global`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ suggestionId }),
  });
  if (!r.ok) throw await failed(r, "promote global");
}

/** Manually trigger the background merge-suggestion pass for a repo ("Suggest merges now").
 *  Fire-and-forget; suggestions arrive via the learnings:update event. */
export async function mergeSuggestNow(repoPath: string): Promise<void> {
  const r = await fetch(`/api/learnings/merge-suggest?repo=${encodeURIComponent(repoPath)}`, {
    method: "POST",
    headers: JSON_HEADERS,
  });
  if (!r.ok) throw await failed(r, "merge suggest");
}

/** Optimize ALL flagged rules in a repo. Fire-and-forget (see optimizeLearning). */
export async function optimizeRepoFlagged(repoPath: string): Promise<void> {
  const r = await fetch(`/api/learnings/optimize?repo=${encodeURIComponent(repoPath)}`, {
    method: "POST",
    headers: JSON_HEADERS,
  });
  if (!r.ok) throw await failed(r, "optimize");
}

export async function getBuildQueue(sessionId: string): Promise<BuildQueue> {
  return getJson(`/api/sessions/${encodeURIComponent(sessionId)}/queue`, "build-queue");
}

export async function putBuildQueue(
  sessionId: string,
  steps: { id?: string; title: string; detail?: string; status?: BuildStepStatus }[],
): Promise<BuildQueue> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/queue`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ steps }),
  });
  if (!r.ok) throw await failed(r, "build-queue put");
  return r.json();
}

export async function approveBuildQueue(sessionId: string): Promise<BuildQueue> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/queue/approve`, {
    method: "POST",
    headers: JSON_HEADERS,
  });
  if (!r.ok) throw await failed(r, "build-queue approve");
  return r.json();
}

/** Read a session's epic draft (issue #1507), or null when none has been authored. */
export async function getEpicDraft(sessionId: string): Promise<EpicDraft | null> {
  return getJson(`/api/sessions/${encodeURIComponent(sessionId)}/epic-draft`, "epic-draft");
}

/** Approve an epic draft — the HARD GATE that materializes it into GitHub issues + links.
 *  Returns the created parent number/url + child numbers. */
export async function approveEpicDraft(
  sessionId: string,
): Promise<{ parentNumber: number; parentUrl: string; childNumbers: Record<string, number> }> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/epic-draft/approve`, {
    method: "POST",
    headers: JSON_HEADERS,
  });
  if (!r.ok) throw await failed(r, "epic-draft approve");
  return r.json();
}

/** Current "star us on GitHub?" nudge status. */
export async function getStarPrompt(): Promise<StarPromptStatus> {
  const r = await fetch("/api/star-prompt");
  if (!r.ok) throw await failed(r, "star prompt status");
  return r.json();
}

/** Resolve the star nudge: dismiss for good, snooze 3 days, or star the repo with
 *  the operator's gh account. Returns the fresh status (also pushed over the WS). */
export async function actStarPrompt(
  action: "dismiss" | "snooze" | "star",
): Promise<StarPromptStatus> {
  const r = await fetch("/api/star-prompt", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ action }),
  });
  if (!r.ok) throw await failed(r, "star prompt");
  return r.json();
}

/** Start the session's dev-server preview.
 *  - `{ok, command, mode:"local"}` — Shepherd started the repo-local preview script.
 *  - `{ok, command, mode:"agent_setup"}` — directive sent; the agent will create the local script.
 *  - `{ok, command, mode:"agent"}` — legacy directive sent; the agent will start the server.
 *  - `{needCommand}` — no command auto-detected; caller must collect one and retry.
 *  - `{alreadyBound}` — a preview port is already live (benign race).
 *  Throws on 404 (unknown/dead session) or any other unexpected failure. */
export async function startPreview(
  id: string,
  command?: string,
): Promise<
  | { needCommand: true }
  | { alreadyBound: true }
  | {
      ok: true;
      command: string;
      mode?: "local" | "agent_setup" | "agent";
      alreadyRunning?: boolean;
    }
> {
  const r = await fetch(`/api/sessions/${id}/preview/start`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(command ? { command } : {}),
  });
  // Read the body exactly once — both 409 variants and ok all need it.
  const body = (await r.json().catch(() => ({}))) as {
    ok?: boolean;
    command?: string;
    error?: string;
    mode?: "local" | "agent_setup" | "agent";
    alreadyRunning?: boolean;
  };
  if (r.ok) {
    const result: {
      ok: true;
      command: string;
      mode?: "local" | "agent_setup" | "agent";
      alreadyRunning?: boolean;
    } = {
      ok: true,
      command: body.command ?? "",
    };
    if (body.mode !== undefined) result.mode = body.mode;
    if (body.alreadyRunning === true) result.alreadyRunning = true;
    return result;
  }
  if (r.status === 409 && body.error === "command_unknown") return { needCommand: true };
  if (r.status === 409 && body.error === "already_bound") return { alreadyBound: true };
  throw apiError(r.status, body, `startPreview failed: ${r.status}`);
}

/** Force-stop the previewed dev server (SIGKILL on the server side).
 *  - `{killed}` — signal dispatched to `killed` process(es) (signals-sent, NOT a death
 *    confirmation; the preview clears via the sweep when the port stops listening).
 *  - `{notBound:true}` — no live preview (benign race; already gone).
 *  Throws on 404 (unknown session) or any other unexpected failure. */
export async function stopPreview(id: string): Promise<{ killed: number } | { notBound: true }> {
  const r = await fetch(`/api/sessions/${id}/preview/stop`, { method: "POST" });
  const body = (await r.json().catch(() => ({}))) as { killed?: number; error?: string };
  if (r.ok) return { killed: body.killed ?? 0 };
  if (r.status === 409 && body.error === "not_bound") return { notBound: true };
  throw apiError(r.status, body, `stopPreview failed: ${r.status}`);
}

// ── epics ──────────────────────────────────────────────────────────────────

export async function getEpics(
  repoPath: string,
): Promise<{ epics: EpicSummary[]; subIssues: number[] }> {
  return getJson(`/api/epics?repo=${encodeURIComponent(repoPath)}`, "get epics");
}

export async function getEpic(repoPath: string, parent: number): Promise<Epic> {
  return getJson(`/api/epic?repo=${encodeURIComponent(repoPath)}&parent=${parent}`, "get epic");
}

export async function diagnoseEpic(repoPath: string, parent: number): Promise<EpicDiagnosis> {
  return getJson(
    `/api/epic/diagnose?repo=${encodeURIComponent(repoPath)}&parent=${parent}`,
    "diagnose epic",
  );
}

export async function updateEpic(
  repoPath: string,
  parent: number,
  patch: Partial<Pick<EpicRun, "mode" | "status" | "agentProvider" | "model" | "effort">>,
): Promise<Epic> {
  const r = await fetch(`/api/epic?repo=${encodeURIComponent(repoPath)}&parent=${parent}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw await failed(r, "update epic");
  return r.json();
}

export async function approveEpicNext(repoPath: string, parent: number): Promise<Epic> {
  const r = await fetch(
    `/api/epic/approve-next?repo=${encodeURIComponent(repoPath)}&parent=${parent}`,
    { method: "POST" },
  );
  if (!r.ok) throw await failed(r, "approve next");
  return r.json();
}

export async function importEpic(
  repoPath: string,
  parent: number,
): Promise<{
  subIssuesAdded: number;
  dependenciesAdded: number;
  skipped: number;
  unresolved: number[];
}> {
  const r = await fetch(`/api/epic/import?repo=${encodeURIComponent(repoPath)}&parent=${parent}`, {
    method: "POST",
  });
  if (!r.ok) throw await failed(r, "import epic");
  return r.json();
}

export async function getCompletedEpics(repoPath?: string): Promise<CompletedEpic[]> {
  return getJson(
    `/api/epics/completed${repoPath ? `?repo=${encodeURIComponent(repoPath)}` : ""}`,
    "get completed epics",
  );
}

export async function dismissCompletedEpic(
  repoPath: string,
  parent: number,
): Promise<{ ok: boolean }> {
  return postJson(
    "/api/epics/completed/dismiss",
    { repo: repoPath, parent },
    "dismiss completed epic",
  );
}

/** Acknowledge the migrations detected in a completed epic's landing PR (#645). Like dismiss,
 *  this clears the band row — one operator action both records the acknowledgement and dismisses. */
export async function ackEpicMigrations(
  repoPath: string,
  parent: number,
): Promise<{ ok: boolean }> {
  return postJson(
    "/api/epics/completed/ack-migrations",
    { repo: repoPath, parent },
    "acknowledge epic migrations",
  );
}

/** Acknowledge a session's manual operator steps (#1060), clearing the auto-merge gate. */
export async function ackManualSteps(sessionId: string): Promise<{ ok: boolean }> {
  return postJson(
    `/api/sessions/${encodeURIComponent(sessionId)}/ack-manual-steps`,
    {},
    "acknowledge manual steps",
  );
}

/** Durable post-merge steps (#1061): records still owing manual steps after merge (Owed lens). */
export async function getOutstandingManualSteps(): Promise<PostMergeSteps[]> {
  return getJson("/api/manual-steps/outstanding", "outstanding manual steps");
}

/** Tick or un-tick one materialized post-merge step; returns the updated record. */
export async function setManualStepDone(
  sessionId: string,
  stepId: string,
  done: boolean,
): Promise<PostMergeSteps> {
  return postJson(
    `/api/manual-steps/${encodeURIComponent(sessionId)}/steps/${encodeURIComponent(stepId)}`,
    { done },
    "update manual step",
  );
}

/** Dismiss a whole post-merge record (clear all its owed steps at once). */
export async function dismissManualSteps(sessionId: string): Promise<PostMergeSteps> {
  return postJson(
    `/api/manual-steps/${encodeURIComponent(sessionId)}/dismiss`,
    {},
    "dismiss manual steps",
  );
}

/** Merge the landing PR for a completed epic (#1039). Fails non-2xx on not-ready / not-open / no row
 *  (409), merge failure (502), or invalid input (400). On success the server emits an `epic:completed`
 *  WS event with the updated row (`landingState:"merged"`) so the band updates live. */
export async function landEpic(repoPath: string, parent: number): Promise<{ ok: boolean }> {
  return postJson("/api/epics/completed/land", { repo: repoPath, parent }, "land epic");
}

/** Manually trigger the PR-gated doc agent for a repo. 202 → started; 409 → skipped
 *  (with the server's reason); other non-2xx throws. */
export async function triggerDocAgent(
  repoPath: string,
): Promise<{ started: boolean; reason?: string }> {
  const r = await fetch(`/api/doc-agent?repo=${encodeURIComponent(repoPath)}`, {
    method: "POST",
    headers: JSON_HEADERS,
  });
  if (r.status === 202) return { started: true };
  if (r.status === 409) {
    const body = await r.json().catch(() => ({}) as Record<string, unknown>);
    return { started: false, reason: body.reason as string };
  }
  throw await failed(r, "doc agent");
}

export async function getDocAgentRuns(
  repoPath: string,
): Promise<{ running: boolean; runs: DocAgentRun[] }> {
  const r = await fetch(`/api/doc-agent/runs?repo=${encodeURIComponent(repoPath)}`);
  if (!r.ok) throw await failed(r, "doc agent runs");
  return r.json() as Promise<{ running: boolean; runs: DocAgentRun[] }>;
}
