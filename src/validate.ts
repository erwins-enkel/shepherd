import { statSync, realpathSync } from "node:fs";
import { resolve, sep, join } from "node:path";
import { homedir } from "node:os";
import { timingSafeEqual, randomUUID } from "node:crypto";
import {
  MODELS,
  type CreateSessionInput,
  type IssueRef,
  type RelaunchOverrides,
  type Steer,
  type BuildStepInput,
  type BuildStepStatus,
} from "./types";
import { stagingDir } from "./uploads";
import { parseRemote } from "./forge/remote";
import { isSandboxProfile, SANDBOX_PROFILES, type SandboxProfile } from "./sandbox";
import { normalizeHost } from "./egress";

/** Expand a leading `~` / `~/` to the user's home dir (the UI suggests `~/<repo>/…`). */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

type Ok = { ok: true; value: CreateSessionInput };
type Err = { ok: false; error: string };
type Result = Ok | Err;

const err = (error: string): Err => ({ ok: false, error });

const BRANCH_RE = /^(?!-)[A-Za-z0-9._/-]{1,200}$/;
const ALLOWED_KEYS = new Set([
  "repoPath",
  "baseBranch",
  "prompt",
  "model",
  "images",
  "issueRef",
  "planGateEnabled",
  "sandboxProfile",
]);

/** Max staged images per spawn. Bounds the attach list (and the relaunch merge of
 *  carried-over originals + supplied overrides) so a spawn's prompt stays sane. */
export const MAX_IMAGES = 10;

// The issue body rides out-of-band into the agent prompt — generous cap, separate
// from the 8000-char human-prompt guard. Title/URL bounded to sane sizes.
const ISSUE_TITLE_MAX = 500;
const ISSUE_URL_MAX = 2048;
const ISSUE_BODY_MAX = 100_000;

/** A field-validation helper either fails with an error or yields a parsed value. */
type FieldErr = { ok: false; error: string };
type FieldOk<T> = { ok: true; value: T };
type Field<T> = FieldOk<T> | FieldErr;

const field = <T>(value: T): FieldOk<T> => ({ ok: true, value });

/** prompt — required non-empty string, trimmed, ≤ 8000 chars. */
function validatePrompt(value: unknown): Field<string> {
  if (typeof value !== "string") return err("prompt must be a string");
  const prompt = value.trim();
  if (prompt.length === 0) return err("prompt must not be empty");
  if (prompt.length > 8000) return err("prompt must be ≤ 8000 chars");
  return field(prompt);
}

/** baseBranch — required string matching the safe branch pattern. */
function validateBaseBranch(value: unknown): Field<string> {
  if (typeof value !== "string") return err("baseBranch must be a string");
  if (!BRANCH_RE.test(value)) return err("baseBranch contains invalid characters");
  return field(value);
}

/** model — optional; absent/null/"default" → null (claude's own default, no --model flag). */
function validateModel(value: unknown): Field<string | null> {
  if (value == null || value === "default") return field(null);
  if (typeof value !== "string") return err("model must be a string");
  if (!(MODELS as readonly string[]).includes(value)) return err("unknown model");
  return field(value);
}

/** repoPath — required non-empty string, confined to repoRoot, existing directory. */
function validateRepoPath(value: unknown, root: string): Field<string> {
  if (typeof value !== "string" || value.length === 0) {
    return err("repoPath must be a non-empty string");
  }
  const resolved = resolve(expandHome(value));
  const inside = resolved === root || resolved.startsWith(root + sep);
  if (!inside) return err("repoPath must be inside the configured repoRoot");
  try {
    if (!statSync(resolved).isDirectory()) return err("repoPath must be a directory");
  } catch {
    return err("repoPath does not exist");
  }
  return field(resolved);
}

/** A single image entry — must resolve inside the staging dir and be a file. */
function validateImageEntry(it: unknown, stagingReal: string): Field<string> {
  if (typeof it !== "string") return err("each image must be a string path");
  let real: string;
  try {
    real = realpathSync(resolve(it));
  } catch {
    return err("image does not exist");
  }
  const inside = real === stagingReal || real.startsWith(stagingReal + sep);
  if (!inside) return err("image must be inside the staging dir");
  try {
    if (!statSync(real).isFile()) return err("image must be a file");
  } catch {
    return err("image does not exist");
  }
  return field(real);
}

/** issueRef — optional attached issue; absent → undefined. */
function validateIssueRef(value: unknown): Field<IssueRef | undefined> {
  if (value == null) return field(undefined);
  if (typeof value !== "object" || Array.isArray(value)) return err("issueRef must be an object");
  const o = value as Record<string, unknown>;
  if (typeof o.number !== "number" || !Number.isInteger(o.number) || o.number <= 0) {
    return err("issueRef.number must be a positive integer");
  }
  if (typeof o.title !== "string" || o.title.length > ISSUE_TITLE_MAX) {
    return err("issueRef.title must be a string ≤ 500 chars");
  }
  if (typeof o.url !== "string" || o.url.length > ISSUE_URL_MAX || !/^https?:\/\//.test(o.url)) {
    return err("issueRef.url must be an http(s) URL");
  }
  if (typeof o.body !== "string" || o.body.length > ISSUE_BODY_MAX) {
    return err("issueRef.body must be a string ≤ 100000 chars");
  }
  return field({ number: o.number, title: o.title, url: o.url, body: o.body });
}

/** images — optional array of staged upload paths, confined to the staging dir. */
function validateImages(value: unknown, root: string): Field<string[]> {
  const images: string[] = [];
  if (value == null) return field(images);
  if (!Array.isArray(value)) return err("images must be an array");
  if (value.length > MAX_IMAGES) return err(`images must be ≤ ${MAX_IMAGES} entries`);
  // an empty list needs no confinement — don't require a staging dir to exist
  // (the staging dir is created lazily on first upload; a fresh repoRoot has none)
  if (value.length === 0) return field(images);

  let stagingReal: string;
  try {
    stagingReal = realpathSync(stagingDir(root));
  } catch {
    return err("no staged uploads exist");
  }
  for (const it of value) {
    const entry = validateImageEntry(it, stagingReal);
    if (!entry.ok) return entry;
    images.push(entry.value);
  }
  if (new Set(images).size !== images.length) return err("duplicate image paths");
  return field(images);
}

// ── validateNewProject ────────────────────────────────────────────────────────

/**
 * Slug regex for new project names.
 * Identical rule mirrored in the UI (NewProject.svelte) — cross-reference kept in both files.
 */
const PROJECT_SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/;

export type NewProjectInput = {
  name: string;
  idea: string;
  createRemote: boolean;
  visibility: "private" | "public";
};

const NEW_PROJECT_ALLOWED_KEYS = new Set(["name", "idea", "createRemote", "visibility"]);

/**
 * Validate and normalize a project name against slug rules.
 * Returns the trimmed name on success or an error code on failure.
 * Defense-in-depth: the regex already blocks most unsafe chars, but extra
 * checks guard against traversal and git-reserved names.
 */
function validateProjectSlug(
  value: unknown,
): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof value !== "string") return err("newproject_failed_slug");
  const name = value.trim();
  if (!PROJECT_SLUG_RE.test(name)) return err("newproject_failed_slug");
  if (name.includes("..")) return err("newproject_failed_slug");
  if (name === "." || name === "..") return err("newproject_failed_slug");
  if (name.endsWith(".git")) return err("newproject_failed_slug");
  if (name.includes("/") || name.includes("\\")) return err("newproject_failed_slug");
  return { ok: true, name };
}

/** idea — optional string ≤ 8000 chars, trimmed, default "". */
function parseIdeaField(value: unknown): Field<string> {
  if (value === undefined) return field("");
  if (typeof value !== "string") return err("newproject_failed_generic");
  const idea = value.trim();
  if (idea.length > 8000) return err("newproject_failed_generic");
  return field(idea);
}

/** createRemote — optional boolean, default false. */
function parseCreateRemoteField(value: unknown): Field<boolean> {
  if (value === undefined) return field(false);
  if (typeof value !== "boolean") return err("newproject_failed_generic");
  return field(value);
}

/** visibility — optional "private" | "public", default "private". */
function parseVisibilityField(value: unknown): Field<"private" | "public"> {
  if (value === undefined) return field("private");
  if (value !== "private" && value !== "public") return err("newproject_failed_generic");
  return field(value);
}

/**
 * Validate a POST /api/projects request body.
 * Returns `{ ok: true; value: NewProjectInput }` on success or `{ ok: false; error: string }`
 * with a stable `newproject_failed_*` code. Never throws.
 * Does NOT check whether the target directory exists — that is done in createProject.
 */
export function validateNewProject(
  body: unknown,
  repoRoot: string,
): { ok: true; value: NewProjectInput } | { ok: false; error: string } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return err("newproject_failed_generic");
  }

  const obj = body as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!NEW_PROJECT_ALLOWED_KEYS.has(key)) return err("newproject_failed_generic");
  }

  const slugResult = validateProjectSlug(obj.name);
  if (!slugResult.ok) return slugResult;
  const name = slugResult.name;

  const ideaResult = parseIdeaField(obj.idea);
  if (!ideaResult.ok) return ideaResult;

  const createRemoteResult = parseCreateRemoteField(obj.createRemote);
  if (!createRemoteResult.ok) return createRemoteResult;

  const visibilityResult = parseVisibilityField(obj.visibility);
  if (!visibilityResult.ok) return visibilityResult;

  // Containment guard: target must resolve inside repoRoot.
  // The slug regex already blocks separators, but this is defense-in-depth (mirrors cloneRepo).
  const root = resolve(expandHome(repoRoot));
  const target = join(root, name);
  if (!(target === root || target.startsWith(root + sep))) return err("newproject_failed_outside");

  return {
    ok: true,
    value: {
      name,
      idea: ideaResult.value,
      createRemote: createRemoteResult.value,
      visibility: visibilityResult.value,
    },
  };
}

const CLONE_URL_MAX = 2048;

/**
 * Validate a clone URL submitted by the user.
 * Accepts https://, http://, and scp-style git@ URLs that parseRemote can parse.
 * Derives the target folder name from the last path segment of the slug.
 * Returns `{ url: trimmedUrl, name }` on success.
 */
export function validateCloneUrl(value: unknown): Field<{ url: string; name: string }> {
  if (typeof value !== "string") return err("clonerepo_failed_url");
  const url = value.trim();
  if (url.length === 0 || url.length > CLONE_URL_MAX) return err("clonerepo_failed_url");

  // Only permit http(s):// and scp-style git@ forms; reject ftp://, file://, etc.
  const isHttps = /^https?:\/\//i.test(url);
  const isScp = /^[^@]+@[^:/]+:/.test(url) && !url.includes("://");
  if (!isHttps && !isScp) return err("clonerepo_failed_url");

  const parsed = parseRemote(url);
  if (parsed === null) return err("clonerepo_failed_url");

  // Reject slugs containing any traversal segment
  if (parsed.slug.split("/").some((s) => s === "..")) {
    return err("clonerepo_failed_outside");
  }

  // Derive folder name from the last segment of the slug (e.g. "owner/repo" → "repo")
  const segments = parsed.slug.split("/");
  const last = segments[segments.length - 1] ?? "";
  // Strip a trailing .git suffix
  const name = last.replace(/\.git$/i, "").trim();

  if (name.length === 0) return err("clonerepo_failed_url");

  // Reject name-level traversal or separator characters
  if (name.includes("..") || name.includes("/") || name.includes("\\")) {
    return err("clonerepo_failed_outside");
  }

  // Reject names that would become a git flag
  if (name.startsWith("-")) return err("clonerepo_failed_url");

  return field({ url, name });
}

/** Pure validator — no side-effects beyond fs.statSync for the repoPath check. */
export function validateCreate(body: unknown, repoRoot: string): Result {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return err("body must be a non-null object");
  }

  const obj = body as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(key)) return err(`unknown key: ${key}`);
  }

  const prompt = validatePrompt(obj.prompt);
  if (!prompt.ok) return prompt;

  const baseBranch = validateBaseBranch(obj.baseBranch);
  if (!baseBranch.ok) return baseBranch;

  const model = validateModel(obj.model);
  if (!model.ok) return model;

  const root = resolve(expandHome(repoRoot));
  const repoPath = validateRepoPath(obj.repoPath, root);
  if (!repoPath.ok) return repoPath;

  const images = validateImages(obj.images, root);
  if (!images.ok) return images;

  const issueRef = validateIssueRef(obj.issueRef);
  if (!issueRef.ok) return issueRef;

  const planGateEnabled = validatePlanGateEnabled(obj.planGateEnabled);
  if (!planGateEnabled.ok) return planGateEnabled;

  const sandboxProfile = validateSandboxProfile(obj.sandboxProfile);
  if (!sandboxProfile.ok) return sandboxProfile;

  return {
    ok: true,
    value: {
      repoPath: repoPath.value,
      baseBranch: baseBranch.value,
      prompt: prompt.value,
      model: model.value,
      images: images.value,
      issueRef: issueRef.value,
      planGateEnabled: planGateEnabled.value,
      sandboxProfile: sandboxProfile.value,
    },
  };
}

/** planGateEnabled — optional per-task override; absent/null → inherit the repo default. */
function validatePlanGateEnabled(value: unknown): Field<boolean | null | undefined> {
  if (value === undefined) return field(undefined);
  if (value === null || typeof value === "boolean") return field(value);
  return err("planGateEnabled must be a boolean, null, or absent");
}

type RelaunchResult = { ok: true; value: RelaunchOverrides } | { ok: false; error: string };

const RELAUNCH_ALLOWED_KEYS = new Set([
  "repoPath",
  "baseBranch",
  "prompt",
  "model",
  "planGateEnabled",
  "images",
]);

/**
 * Validate a POST /api/sessions/:id/relaunch override body — the SAME fields create
 * validates, but every one is OPTIONAL (an absent field inherits the original session's
 * already-validated value, so it is NOT re-checked). Closes the create/relaunch asymmetry:
 * a present `repoPath`/`baseBranch`/`model`/`images` is run through the identical validator
 * `validateCreate` uses, and unknown keys are rejected — so an override can never reach
 * `worktree.create` / the `--model` spawn flag unguarded. Pure (only `validateRepoPath` /
 * `validateImages` touch the fs); never throws. Mirrors `validateCreate`'s `{ ok, error }`
 * contract so the route can return the same 400 body. `null` → no overrides (quick relaunch).
 */
export function validateRelaunchOverrides(body: unknown, repoRoot: string): RelaunchResult {
  if (body === null) return { ok: true, value: {} };
  if (typeof body !== "object" || Array.isArray(body)) {
    return err("body must be a non-null object");
  }

  const obj = body as Record<string, unknown>;
  const unknown = rejectUnknownRelaunchKeys(obj);
  if (unknown) return unknown;

  const root = resolve(expandHome(repoRoot));
  // model: an explicit `null` is legal ("default", no --model flag); only an absent key
  // inherits the original's model, so each validator runs whenever its key is present
  // (incl. null). Each row maps a present field through the SAME validator create uses,
  // writing the typed value onto `out`; the first failure short-circuits.
  const out: RelaunchOverrides = {};
  const fields: { key: keyof RelaunchOverrides; apply: () => Field<unknown> }[] = [
    { key: "prompt", apply: () => validatePrompt(obj.prompt) },
    { key: "baseBranch", apply: () => validateBaseBranch(obj.baseBranch) },
    { key: "model", apply: () => validateModel(obj.model) },
    { key: "planGateEnabled", apply: () => validatePlanGateEnabled(obj.planGateEnabled) },
    { key: "repoPath", apply: () => validateRepoPath(obj.repoPath, root) },
    { key: "images", apply: () => validateImages(obj.images, root) },
  ];
  for (const { key, apply } of fields) {
    if (obj[key] === undefined) continue;
    const r = apply();
    if (!r.ok) return r;
    (out as Record<string, unknown>)[key] = r.value;
  }

  return { ok: true, value: out };
}

/** Reject any key not in the relaunch override allow-list; null when all keys are allowed. */
function rejectUnknownRelaunchKeys(obj: Record<string, unknown>): RelaunchResult | null {
  for (const key of Object.keys(obj)) {
    if (!RELAUNCH_ALLOWED_KEYS.has(key)) return err(`unknown key: ${key}`);
  }
  return null;
}

/** sandboxProfile — per-spawn override; absent/null → inherit the repo default. */
function validateSandboxProfile(value: unknown): Field<SandboxProfile | null | undefined> {
  if (value === undefined) return field(undefined);
  if (value === null) return field(null);
  if (isSandboxProfile(value)) return field(value);
  return err(`sandboxProfile must be one of: ${SANDBOX_PROFILES.join(", ")}, null, or absent`);
}

/**
 * egressExtraHosts — per-repo extra allowlisted hosts for the autonomous egress firewall.
 * Absent → default []. Each entry is validated AND normalized with the SAME gate the
 * allowlist builder uses (`normalizeHost` from egress.ts), so a host that validates is
 * exactly a host that will make the allowlist — and the stored value is the normalized
 * form, eliminating the "persisted but silently dropped at spawn" skew.
 */
export function validateEgressExtraHosts(value: unknown): Field<string[]> {
  if (value === undefined || value === null) return field([]);
  if (!Array.isArray(value)) return err("egressExtraHosts must be an array of hostname strings");
  const normalized: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const h = value[i];
    if (typeof h !== "string") return err(`egressExtraHosts[${i}]: must be a string`);
    const n = normalizeHost(h);
    if (n === null)
      return err(
        `egressExtraHosts[${i}]: "${h}" is not a valid hostname (≥2 dot-separated labels, ` +
          `lowercase alphanum/hyphen, no leading/trailing hyphen or empty label)`,
      );
    normalized.push(n);
  }
  return field(normalized);
}

/**
 * Timing-safe token check.
 * Returns true when token config is null (auth disabled) or header matches.
 */
export function isAuthorized(
  headerValue: string | null | undefined,
  token: string | null,
): boolean {
  if (token === null) return true;
  if (!headerValue) return false;
  const prefix = "Bearer ";
  if (!headerValue.startsWith(prefix)) return false;
  const provided = headerValue.slice(prefix.length);
  // Guard length before timingSafeEqual (it throws on unequal-length buffers)
  if (provided.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(token));
}

/**
 * Parse + clamp terminal dimensions from untrusted query params.
 * Garbage / out-of-range falls back to 100×30 (herdr's default attach size).
 */
export function parseTermDims(cols: unknown, rows: unknown): { cols: number; rows: number } {
  return { cols: clampDim(cols, 100), rows: clampDim(rows, 30) };
}

function clampDim(v: unknown, fallback: number): number {
  const n = typeof v === "string" || typeof v === "number" ? Math.floor(Number(v)) : NaN;
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, 1000);
}

/** Returns true when the terminalId is safe to pass to spawn args. */
export function isValidTerminalId(id: string): boolean {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id) && !id.startsWith("-");
}

/** Resolve a repo path, confined to repoRoot and required to be an existing directory. null if invalid. */
export function safeRepoDir(repoPathRaw: string, repoRoot: string): string | null {
  if (typeof repoPathRaw !== "string" || repoPathRaw.length === 0) return null;
  // realpath both sides so a symlink inside repoRoot can't escape the containment check
  let resolvedReal: string;
  let rootReal: string;
  try {
    rootReal = realpathSync(resolve(expandHome(repoRoot)));
    resolvedReal = realpathSync(resolve(expandHome(repoPathRaw)));
  } catch {
    return null; // non-existent path (realpath throws) → reject
  }
  const inside = resolvedReal === rootReal || resolvedReal.startsWith(rootReal + sep);
  if (!inside) return null;
  try {
    return statSync(resolvedReal).isDirectory() ? resolvedReal : null;
  } catch {
    return null;
  }
}

/**
 * Returns true when the request should be allowed through the CSRF origin check.
 *
 * When `previewRange` is supplied, any Origin whose port falls in
 * [base, base + count) is **rejected** even if its hostname is allowlisted —
 * a preview app running on that port shares the HUD's hostname and could
 * otherwise forge `/api` mutations (CSRF via blind cross-origin POST).
 * CLI / curl clients (no Origin header) are always allowed through.
 */
export function originAllowed(
  originHeader: string | null | undefined,
  allowedHosts: string[],
  previewRange?: { base: number; count: number },
): boolean {
  if (!originHeader) return true; // no-browser client (curl, CLI)
  let parsed: URL;
  try {
    parsed = new URL(originHeader);
  } catch {
    return false; // malformed origin
  }

  // Reject preview-port origins before the hostname check so a previewed app
  // can never forge state-changing requests against the HUD's API, even when its
  // hostname is in the allowlist.
  if (previewRange) {
    const { base, count } = previewRange;
    // URL.port is "" when the URL uses its scheme's default port (80/443).
    // A missing port means HTTPS default (443) or HTTP default (80) — neither
    // should be in a preview range; treat "" as the default (not a preview port).
    if (parsed.port !== "") {
      const port = Number(parsed.port);
      if (port >= base && port < base + count) {
        return false; // preview-port origin → reject
      }
    }
  }

  return allowedHosts.includes(parsed.hostname);
}

const STEER_LABEL_MAX = 60;
const STEER_TEXT_MAX = 4000;
/** Max saved steers per list; loadSteers' migration honors the same cap. */
export const STEER_MAX = 40;

/** Single displayable emoji/glyph: ≤8 code points (covers ZWJ sequences), no control chars. */
function isValidEmoji(emoji: string): boolean {
  const codePoints = [...emoji];
  if (codePoints.length > 8) return false;
  return !codePoints.some((c) => (c.codePointAt(0) ?? 0x20) < 0x20);
}

/** Trimmed optional steer emoji: undefined when absent/blank, null on violation. */
function validateSteerEmoji(v: unknown): string | undefined | null {
  if (v === undefined) return undefined;
  if (typeof v !== "string") return null;
  const emoji = v.trim();
  if (emoji.length === 0) return undefined;
  return isValidEmoji(emoji) ? emoji : null;
}

/** Optional surface flag: fallback when absent, null when present but not a boolean. */
function validateSteerScope(v: unknown, fallback: boolean): boolean | null {
  if (v === undefined) return fallback;
  return typeof v === "boolean" ? v : null;
}

/** Validate + normalize a single steer item. Returns null on any violation. */
function validateSteerItem(it: unknown): Steer | null {
  if (it === null || typeof it !== "object" || Array.isArray(it)) return null;
  const o = it as Record<string, unknown>;
  if (typeof o.label !== "string" || typeof o.text !== "string") return null;
  const label = o.label.trim();
  const text = o.text.trim();
  if (label.length === 0 || label.length > STEER_LABEL_MAX) return null;
  if (text.length === 0 || text.length > STEER_TEXT_MAX) return null;
  const emoji = validateSteerEmoji(o.emoji);
  // legacy payloads predate the surfaces: they were steer-bar-only chips
  const inSteerBar = validateSteerScope(o.inSteerBar, true);
  const onIssues = validateSteerScope(o.onIssues, false);
  if (emoji === null || inSteerBar === null || onIssues === null) return null;
  // both surfaces off → the steer renders nowhere; mirror the SteersEditor guard
  if (!inSteerBar && !onIssues) return null;
  const id = typeof o.id === "string" && o.id.length > 0 ? o.id : randomUUID();
  return { id, label, text, ...(emoji !== undefined ? { emoji } : {}), inSteerBar, onIssues };
}

/** Validate + normalize a PUT /api/steers payload. Returns null on any violation. */
export function validateSteers(body: unknown): Steer[] | null {
  if (!Array.isArray(body) || body.length > STEER_MAX) return null;
  const out: Steer[] = [];
  for (const it of body) {
    const item = validateSteerItem(it);
    if (item === null) return null;
    out.push(item);
  }
  return out;
}

/** Validate a PUT /api/project-icons patch. `emoji === ""` means "clear". Returns null on violation. */
export function validateIconPatch(body: unknown): { path: string; emoji: string } | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const o = body as Record<string, unknown>;
  if (typeof o.path !== "string" || typeof o.emoji !== "string") return null;
  const path = o.path.trim();
  if (path.length === 0 || path.length > 1024) return null;
  const emoji = o.emoji.trim();
  if (emoji.length > 0 && !isValidEmoji(emoji)) return null;
  return { path, emoji };
}

// ── build-queue validators ────────────────────────────────────────────────────

export const BUILD_STEP_STATUSES = ["pending", "active", "done", "skipped"] as const;

const STEP_TITLE_MAX = 200;
const STEP_DETAIL_MAX = 4000;
const STEP_ID_MAX = 200;
const STEPS_MAX = 100;

/** A trimmed string within [min,max] length, or null when not a string / out of range. */
function boundedString(v: unknown, max: number, allowEmpty: boolean): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t.length > max || (!allowEmpty && t.length === 0)) return null;
  return t;
}

/** Validate + normalize a single queue-step input. Returns null on any violation. */
function validateBuildStepItem(it: unknown): BuildStepInput | null {
  if (it === null || typeof it !== "object" || Array.isArray(it)) return null;
  const s = it as Record<string, unknown>;
  const title = boundedString(s.title, STEP_TITLE_MAX, false);
  if (title === null) return null;
  const step: BuildStepInput = { title };
  if (s.detail !== undefined) {
    const detail = boundedString(s.detail, STEP_DETAIL_MAX, true);
    if (detail === null) return null;
    step.detail = detail;
  }
  if (s.id !== undefined) {
    const id = boundedString(s.id, STEP_ID_MAX, false);
    if (id === null) return null;
    step.id = id;
  }
  if (s.status !== undefined) {
    if (!(BUILD_STEP_STATUSES as readonly string[]).includes(s.status as string)) return null;
    step.status = s.status as BuildStepStatus;
  }
  return step;
}

/** Validate + normalize a PUT /api/sessions/:id/queue body. Returns null on any violation. */
export function validateBuildSteps(body: unknown): BuildStepInput[] | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const o = body as Record<string, unknown>;
  if (!Array.isArray(o.steps) || o.steps.length > STEPS_MAX) return null;
  const out: BuildStepInput[] = [];
  for (const it of o.steps) {
    const step = validateBuildStepItem(it);
    if (step === null) return null;
    out.push(step);
  }
  return out;
}

/** Validate a POST /api/sessions/:id/queue/steps/:stepId body. Returns null on any violation. */
export function validateBuildStepStatus(body: unknown): BuildStepStatus | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const o = body as Record<string, unknown>;
  if (!(BUILD_STEP_STATUSES as readonly string[]).includes(o.status as string)) return null;
  return o.status as BuildStepStatus;
}

/** Validate a PATCH body for PUT /api/epic. Returns null on any violation. */
export function validateEpicRunPatch(
  v: unknown,
): { mode?: "auto" | "attended"; status?: "idle" | "running" | "paused" } | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const out: { mode?: "auto" | "attended"; status?: "idle" | "running" | "paused" } = {};
  if ("mode" in o) {
    if (o.mode !== "auto" && o.mode !== "attended") return null;
    out.mode = o.mode;
  }
  if ("status" in o) {
    if (o.status !== "idle" && o.status !== "running" && o.status !== "paused") return null;
    out.status = o.status;
  }
  return out;
}

/** Validate a POST /api/broadcast payload. Returns null on any violation. */
export function validateBroadcast(body: unknown): { text: string; ids: string[] } | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const o = body as Record<string, unknown>;
  if (typeof o.text !== "string") return null;
  const text = o.text.trim();
  if (text.length === 0 || text.length > STEER_TEXT_MAX) return null;
  if (!Array.isArray(o.ids)) return null;
  const ids: string[] = [];
  for (const id of o.ids) {
    if (typeof id !== "string" || id.length === 0) return null;
    ids.push(id);
  }
  return { text, ids };
}
