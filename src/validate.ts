import { statSync, realpathSync } from "node:fs";
import { resolve, sep, join } from "node:path";
import { homedir } from "node:os";
import { timingSafeEqual, randomUUID } from "node:crypto";
import {
  AGENT_PROVIDERS,
  CODEX_MODELS,
  MODELS,
  EFFORTS,
  type AgentProvider,
  type CreateSessionInput,
  type IssueRef,
  type LaunchUiState,
  type RelaunchOverrides,
  type Steer,
  type BuildStepInput,
  type BuildStepStatus,
  type EpicDraftContent,
  type EpicDraftChild,
} from "./types";
import { modelCompatibleWithProvider } from "./default-model";
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
export type HandoffMode = "resume" | "summarize";

const err = (error: string): Err => ({ ok: false, error });

const BRANCH_RE = /^(?!-)[A-Za-z0-9._/-]{1,200}$/;
const ALLOWED_KEYS = new Set([
  "repoPath",
  "baseBranch",
  "prompt",
  "agentProvider",
  "model",
  "effort",
  "images",
  "attachmentNames",
  "issueRef",
  "launchUiState",
  "planGateEnabled",
  "autopilotEnabled",
  "sandboxProfile",
  "research",
  "epicAuthoring",
  "mergeTrainPrs",
  "force", // transport-only: bypass hold gate; not forwarded to CreateSessionInput
]);

/** Max staged attachments per spawn. Bounds the attach list (and the relaunch merge of
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

function validateAgentProvider(value: unknown): Field<AgentProvider | undefined> {
  if (value == null) return field(undefined);
  if (!(AGENT_PROVIDERS as readonly unknown[]).includes(value)) {
    return err("agentProvider must be one of: claude, codex");
  }
  return field(value as AgentProvider);
}

/** model — optional; absent/null/"default" → null (provider default, no --model flag). */
function validateModel(value: unknown, agentProvider?: AgentProvider): Field<string | null> {
  if (value == null || value === "default") return field(null);
  if (typeof value !== "string") return err("model must be a string");
  if (agentProvider) {
    if (modelCompatibleWithProvider(value, agentProvider)) return field(value);
    return agentProvider === "codex" ? err("invalid codex model") : err("unknown model");
  }
  if (
    (MODELS as readonly string[]).includes(value) ||
    (CODEX_MODELS as readonly string[]).includes(value)
  ) {
    return field(value);
  }
  return err("unknown model");
}

/** effort — optional; absent/null/"default" → null (provider default, no effort flag). A present
 *  value must be an EFFORTS tier. Provider clamping (Codex has no xhigh/max) happens at argv-build,
 *  so the tier is accepted here for either provider. */
function validateEffort(value: unknown): Field<string | null> {
  if (value == null || value === "default") return field(null);
  if (typeof value !== "string") return err("effort must be a string");
  if ((EFFORTS as readonly string[]).includes(value)) return field(value);
  return err("effort must be one of: low, medium, high, xhigh, max");
}

function validateHandoffMode(value: unknown): Field<HandoffMode> {
  if (value == null) return field("resume");
  if (value === "resume" || value === "summarize") return field(value);
  return err("handoffMode must be one of: resume, summarize");
}

/**
 * Validate a `{ agentProvider?, model? }` body for the variant / comparison spawn endpoints.
 * `agentProvider` is optional (absent → caller falls back to the original's / config default);
 * `model` is validated against the supplied provider (absent/null/"default" → provider default).
 * Mirrors validateCreate's `{ ok, error }` contract so routes return the same 400 shape.
 */
export function validateModelChoice(body: unknown):
  | {
      ok: true;
      value: { agentProvider?: AgentProvider; model: string | null; effort: string | null };
    }
  | { ok: false; error: string } {
  const obj = body == null ? {} : (body as Record<string, unknown>);
  if (typeof obj !== "object" || Array.isArray(obj)) return err("body must be a non-null object");
  const provider = validateAgentProvider(obj.agentProvider);
  if (!provider.ok) return provider;
  const model = validateModel(obj.model, provider.value);
  if (!model.ok) return model;
  const effort = validateEffort(obj.effort);
  if (!effort.ok) return effort;
  return {
    ok: true,
    value: { agentProvider: provider.value, model: model.value, effort: effort.value },
  };
}

/** Validate the in-place continuation payload for `/api/sessions/:id/replace`. */
export function validateReplaceAgentChoice(body: unknown):
  | {
      ok: true;
      value: {
        agentProvider?: AgentProvider;
        model: string | null;
        handoffMode: HandoffMode;
        effort: string | null;
      };
    }
  | { ok: false; error: string } {
  const obj = body == null ? {} : (body as Record<string, unknown>);
  if (typeof obj !== "object" || Array.isArray(obj)) return err("body must be a non-null object");
  const provider = validateAgentProvider(obj.agentProvider);
  if (!provider.ok) return provider;
  const model = validateModel(obj.model, provider.value);
  if (!model.ok) return model;
  const handoffMode = validateHandoffMode(obj.handoffMode);
  if (!handoffMode.ok) return handoffMode;
  const effort = validateEffort(obj.effort);
  if (!effort.ok) return effort;
  return {
    ok: true,
    value: {
      agentProvider: provider.value,
      model: model.value,
      handoffMode: handoffMode.value,
      effort: effort.value,
    },
  };
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

/** A single attachment entry — must resolve inside the staging dir and be a file. */
function validateImageEntry(it: unknown, stagingReal: string): Field<string> {
  if (typeof it !== "string") return err("each attachment must be a string path");
  let real: string;
  try {
    real = realpathSync(resolve(it));
  } catch {
    return err("attachment does not exist");
  }
  const inside = real === stagingReal || real.startsWith(stagingReal + sep);
  if (!inside) return err("attachment must be inside the staging dir");
  try {
    if (!statSync(real).isFile()) return err("attachment must be a file");
  } catch {
    return err("attachment does not exist");
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

/** images — optional array of staged attachment paths, confined to the staging dir. */
function validateImages(value: unknown, root: string): Field<string[]> {
  const images: string[] = [];
  if (value == null) return field(images);
  if (!Array.isArray(value)) return err("attachments must be an array");
  if (value.length > MAX_IMAGES) return err(`attachments must be ≤ ${MAX_IMAGES} entries`);
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
  if (new Set(images).size !== images.length) return err("duplicate attachment paths");
  return field(images);
}

function sanitizeAttachmentName(value: string, fallback: string): string {
  const clean = value
    .replace(/[/\\]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/^\.+/, "")
    .trim();
  return clean.slice(0, 160) || fallback;
}

function validateAttachmentNames(value: unknown, imageCount: number): Field<string[] | undefined> {
  if (value === undefined) return field(undefined);
  if (!Array.isArray(value)) return err("attachmentNames must be an array");
  if (value.length !== imageCount) return err("attachmentNames length must match images");
  const names: string[] = [];
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== "string") return err(`attachmentNames[${i}] must be a string`);
    names.push(sanitizeAttachmentName(value[i], `Attachment ${i + 1}`));
  }
  return field(names);
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
  owner: string;
};

const NEW_PROJECT_ALLOWED_KEYS = new Set(["name", "idea", "createRemote", "visibility", "owner"]);

/**
 * GitHub login/org slug: 1–39 chars, alphanumeric with single internal hyphens,
 * no leading/trailing hyphen. Empty is allowed and means "personal account".
 */
const GH_OWNER_RE = /^[a-zA-Z0-9](?:-?[a-zA-Z0-9])*$/;

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

/** owner — optional GitHub login/org slug, default "" (personal account). */
function parseOwnerField(value: unknown): Field<string> {
  if (value === undefined || value === "") return field("");
  if (typeof value !== "string") return err("newproject_failed_generic");
  const owner = value.trim();
  if (owner === "") return field("");
  if (owner.length > 39 || !GH_OWNER_RE.test(owner)) return err("newproject_failed_generic");
  return field(owner);
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

  const ownerResult = parseOwnerField(obj.owner);
  if (!ownerResult.ok) return ownerResult;

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
      owner: ownerResult.value,
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

// Bare `owner/repo` shorthand for `gh repo fork` (exactly two safe segments).
const OWNER_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Resolve a fork input into the gh `repo` argument and its `owner/repo` slug, or
 * null if the form is unrecognized. Accepts the same URL forms as
 * {@link validateCloneUrl} (https://, http://, scp-style git@) plus the bare
 * `owner/repo` shorthand that `gh repo fork` understands.
 */
function parseForkInput(input: string): { repo: string; slug: string } | null {
  const isHttps = /^https?:\/\//i.test(input);
  const isScp = /^[^@]+@[^:/]+:/.test(input) && !input.includes("://");
  if (isHttps || isScp) {
    const parsed = parseRemote(input);
    return parsed ? { repo: input, slug: parsed.slug } : null; // full URL → gh
  }
  if (OWNER_REPO_RE.test(input)) {
    const slug = input.replace(/\.git$/i, "");
    return { repo: slug, slug }; // normalized owner/repo → gh
  }
  return null;
}

/**
 * Validate a fork target submitted by the user. Derives the target folder name
 * from the last slug segment. Returns `{ repo, name }` where `repo` is the
 * argument passed to `gh repo fork` and `name` is the destination folder.
 */
export function validateForkTarget(value: unknown): Field<{ repo: string; name: string }> {
  if (typeof value !== "string") return err("forkrepo_failed_url");
  const input = value.trim();
  if (input.length === 0 || input.length > CLONE_URL_MAX) return err("forkrepo_failed_url");

  const parsed = parseForkInput(input);
  if (!parsed) return err("forkrepo_failed_url");
  const { repo, slug } = parsed;

  // Reject slugs containing any traversal segment
  if (slug.split("/").some((s) => s === "..")) return err("forkrepo_failed_outside");

  // Derive folder name from the last slug segment (e.g. "owner/repo" → "repo")
  const name = (slug.split("/").at(-1) ?? "").replace(/\.git$/i, "").trim();
  if (name.length === 0) return err("forkrepo_failed_url");
  if (name.includes("..") || name.includes("/") || name.includes("\\")) {
    return err("forkrepo_failed_outside");
  }
  // Reject values that would be interpreted as a git/gh flag
  if (name.startsWith("-") || repo.startsWith("-")) return err("forkrepo_failed_url");

  return field({ repo, name });
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

  const agentProvider = validateAgentProvider(obj.agentProvider);
  if (!agentProvider.ok) return agentProvider;

  const model = validateModel(obj.model, agentProvider.value);
  if (!model.ok) return model;

  const effort = validateEffort(obj.effort);
  if (!effort.ok) return effort;

  const root = resolve(expandHome(repoRoot));
  const launch = validateCreateLaunchFields(obj, root);
  if (!launch.ok) return launch;

  const options = validateOptions(obj);
  if (!options.ok) return options;

  return {
    ok: true,
    value: {
      repoPath: launch.value.repoPath,
      baseBranch: baseBranch.value,
      prompt: prompt.value,
      agentProvider: agentProvider.value,
      model: model.value,
      effort: effort.value,
      images: launch.value.images,
      attachmentNames: launch.value.attachmentNames,
      issueRef: launch.value.issueRef,
      launchUiState: launch.value.launchUiState,
      // mergeTrainPrs is number[] | undefined; consumers read it via truthiness /
      // `?? null`, so an explicit undefined is equivalent to omitting the key.
      ...options.value,
    },
  };
}

function validateCreateLaunchFields(
  obj: Record<string, unknown>,
  root: string,
): Field<{
  repoPath: string;
  images: string[];
  attachmentNames: string[] | undefined;
  issueRef: IssueRef | undefined;
  launchUiState: LaunchUiState | undefined;
}> {
  const repoPath = validateRepoPath(obj.repoPath, root);
  if (!repoPath.ok) return repoPath;

  const images = validateImages(obj.images, root);
  if (!images.ok) return images;

  const attachmentNames = validateAttachmentNames(obj.attachmentNames, images.value.length);
  if (!attachmentNames.ok) return attachmentNames;

  const issueRef = validateIssueRef(obj.issueRef);
  if (!issueRef.ok) return issueRef;

  const launchUiState = validateLaunchUiState(obj.launchUiState);
  if (!launchUiState.ok) return launchUiState;

  return field({
    repoPath: repoPath.value,
    images: images.value,
    attachmentNames: attachmentNames.value,
    issueRef: issueRef.value,
    launchUiState: launchUiState.value,
  });
}

/** Optional create-time overrides, bundled so validateCreate stays flat (below the
 *  complexity gate). Validator order is preserved, so first-error precedence is
 *  identical to inlining these. */
function validateOptions(obj: Record<string, unknown>): Field<{
  planGateEnabled: boolean | null | undefined;
  autopilotEnabled: boolean | null | undefined;
  sandboxProfile: SandboxProfile | null | undefined;
  research: boolean;
  epicAuthoring: boolean;
  mergeTrainPrs: number[] | undefined;
}> {
  const planGateEnabled = validatePlanGateEnabled(obj.planGateEnabled);
  if (!planGateEnabled.ok) return planGateEnabled;

  const autopilotEnabled = validateAutopilotEnabled(obj.autopilotEnabled);
  if (!autopilotEnabled.ok) return autopilotEnabled;

  const sandboxProfile = validateSandboxProfile(obj.sandboxProfile);
  if (!sandboxProfile.ok) return sandboxProfile;

  const research = validateResearch(obj.research);
  if (!research.ok) return research;

  const epicAuthoring = validateEpicAuthoring(obj.epicAuthoring);
  if (!epicAuthoring.ok) return epicAuthoring;

  const mergeTrainPrs = validateMergeTrainPrs(obj.mergeTrainPrs);
  if (!mergeTrainPrs.ok) return mergeTrainPrs;

  return field({
    planGateEnabled: planGateEnabled.value,
    autopilotEnabled: autopilotEnabled.value,
    sandboxProfile: sandboxProfile.value,
    research: research.value,
    epicAuthoring: epicAuthoring.value,
    mergeTrainPrs: mergeTrainPrs.value,
  });
}

/** planGateEnabled — optional per-task override; absent/null → inherit the repo default. */
function validatePlanGateEnabled(value: unknown): Field<boolean | null | undefined> {
  if (value === undefined) return field(undefined);
  if (value === null || typeof value === "boolean") return field(value);
  return err("planGateEnabled must be a boolean, null, or absent");
}

/** autopilotEnabled — optional per-task override; absent/null → inherit the repo default. */
function validateAutopilotEnabled(value: unknown): Field<boolean | null | undefined> {
  if (value === undefined) return field(undefined);
  if (value === null || typeof value === "boolean") return field(value);
  return err("autopilotEnabled must be a boolean, null, or absent");
}

/** research — optional plain boolean; absent/undefined → false; null or non-boolean rejected. */
function validateResearch(value: unknown): Field<boolean> {
  if (value === undefined) return field(false);
  if (typeof value === "boolean") return field(value);
  return err("research must be a boolean or absent");
}

/** epicAuthoring — optional plain boolean; absent/undefined → false; null or non-boolean rejected. */
function validateEpicAuthoring(value: unknown): Field<boolean> {
  if (value === undefined) return field(false);
  if (typeof value === "boolean") return field(value);
  return err("epicAuthoring must be a boolean or absent");
}

function validateLaunchUiState(value: unknown): Field<LaunchUiState | undefined> {
  if (value === undefined) return field(undefined);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return err("launchUiState must be an object or absent");
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (
      !["researchChecked", "planGateChecked", "autopilotChecked", "epicAuthoringChecked"].includes(
        key,
      )
    )
      return err(`launchUiState unknown key: ${key}`);
  }
  if (typeof obj.researchChecked !== "boolean")
    return err("launchUiState.researchChecked must be a boolean");
  if (typeof obj.planGateChecked !== "boolean")
    return err("launchUiState.planGateChecked must be a boolean");
  if (typeof obj.autopilotChecked !== "boolean")
    return err("launchUiState.autopilotChecked must be a boolean");
  // epicAuthoringChecked is optional (absent on legacy/most rows); validate only when present.
  if (obj.epicAuthoringChecked !== undefined && typeof obj.epicAuthoringChecked !== "boolean")
    return err("launchUiState.epicAuthoringChecked must be a boolean");
  return field({
    researchChecked: obj.researchChecked,
    planGateChecked: obj.planGateChecked,
    autopilotChecked: obj.autopilotChecked,
    ...(obj.epicAuthoringChecked !== undefined
      ? { epicAuthoringChecked: obj.epicAuthoringChecked }
      : {}),
  });
}

/** mergeTrainPrs — optional array of positive integers; absent → undefined (store defaults null). */
function validateMergeTrainPrs(value: unknown): Field<number[] | undefined> {
  if (value === undefined) return field(undefined);
  if (!Array.isArray(value)) return err("mergeTrainPrs must be an array of integers");
  for (let i = 0; i < value.length; i++) {
    const n = value[i];
    if (typeof n !== "number" || !Number.isInteger(n) || n <= 0)
      return err(`mergeTrainPrs[${i}] must be an integer`);
  }
  return field(value as number[]);
}

type RelaunchResult = { ok: true; value: RelaunchOverrides } | { ok: false; error: string };

const RELAUNCH_ALLOWED_KEYS = new Set([
  "repoPath",
  "baseBranch",
  "prompt",
  "agentProvider",
  "model",
  "effort",
  "planGateEnabled",
  "autopilotEnabled",
  "research",
  "epicAuthoring",
  "images",
  "attachmentNames",
  "launchUiState",
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
  // agentProvider runs BEFORE model so model can validate against the (overridden) provider —
  // e.g. an override switching to codex lets a codex-only alias through. The session-blind
  // pair check here is best-effort; the service re-checks against the EFFECTIVE provider
  // (override ?? original) and resets a carried incompatible model.
  const fields: { key: keyof RelaunchOverrides; apply: () => Field<unknown> }[] = [
    { key: "prompt", apply: () => validatePrompt(obj.prompt) },
    { key: "baseBranch", apply: () => validateBaseBranch(obj.baseBranch) },
    { key: "agentProvider", apply: () => validateAgentProvider(obj.agentProvider) },
    { key: "model", apply: () => validateModel(obj.model, out.agentProvider) },
    { key: "effort", apply: () => validateEffort(obj.effort) },
    { key: "planGateEnabled", apply: () => validatePlanGateEnabled(obj.planGateEnabled) },
    { key: "autopilotEnabled", apply: () => validateAutopilotEnabled(obj.autopilotEnabled) },
    { key: "research", apply: () => validateResearch(obj.research) },
    { key: "epicAuthoring", apply: () => validateEpicAuthoring(obj.epicAuthoring) },
    { key: "repoPath", apply: () => validateRepoPath(obj.repoPath, root) },
    { key: "images", apply: () => validateImages(obj.images, root) },
    {
      key: "attachmentNames",
      apply: () =>
        obj.images === undefined
          ? err("attachmentNames requires images")
          : validateAttachmentNames(obj.attachmentNames, (out.images ?? []).length),
    },
    { key: "launchUiState", apply: () => validateLaunchUiState(obj.launchUiState) },
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

/** Verdict for an incoming CSRF origin check: allowed, rejected because it's a
 *  preview-port origin, or rejected because its host isn't allowlisted. The two
 *  rejection reasons let the caller surface distinct copy (issue #1645 Fix 3): a
 *  genuine preview app is "read-only", while an un-allowlisted HUD host should
 *  point the operator at SHEPHERD_ALLOWED_HOSTS instead of blaming the preview. */
export type OriginVerdict = "allow" | "preview-port" | "host-not-allowed";

/**
 * Classify an incoming Origin for the CSRF guard (see {@link originAllowed} for the
 * boolean shorthand). Preserves the historical edges: an absent/empty Origin
 * (curl/CLI, no browser) is `"allow"`; a malformed Origin is `"host-not-allowed"`.
 *
 * When `previewRange` is supplied, any Origin whose port falls in
 * [base, base + count) is `"preview-port"` even if its hostname is allowlisted —
 * a preview app running on that port shares the HUD's hostname and could otherwise
 * forge `/api` mutations (CSRF via blind cross-origin POST). This check runs BEFORE
 * the hostname check so a previewed app can never be reclassified as an allowed host.
 */
export function classifyOrigin(
  originHeader: string | null | undefined,
  allowedHosts: string[],
  previewRange?: { base: number; count: number },
): OriginVerdict {
  if (!originHeader) return "allow"; // no-browser client (curl, CLI)
  let parsed: URL;
  try {
    parsed = new URL(originHeader);
  } catch {
    return "host-not-allowed"; // malformed origin
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
        return "preview-port"; // preview-port origin → reject
      }
    }
  }

  return allowedHosts.includes(parsed.hostname) ? "allow" : "host-not-allowed";
}

/**
 * Returns true when the request should be allowed through the CSRF origin check.
 * Thin boolean wrapper over {@link classifyOrigin}; CLI / curl clients (no Origin
 * header) are always allowed through.
 */
export function originAllowed(
  originHeader: string | null | undefined,
  allowedHosts: string[],
  previewRange?: { base: number; count: number },
): boolean {
  return classifyOrigin(originHeader, allowedHosts, previewRange) === "allow";
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

/** Optional steer repo-allowlist: undefined when absent; null on violation; else a
 *  trimmed, de-duplicated, capped list of non-empty repo-name strings. */
function validateSteerRepos(v: unknown): string[] | undefined | null {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > STEER_MAX) return null;
  const seen = new Set<string>();
  for (const it of v) {
    if (typeof it !== "string") return null;
    const name = it.trim();
    if (name.length === 0 || name.length > 255) return null;
    seen.add(name);
  }
  return seen.size === 0 ? undefined : [...seen];
}

function validateSteerAgentProviders(v: unknown): AgentProvider[] | undefined | null {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) return null;
  const out: AgentProvider[] = [];
  for (const p of v) {
    if (!(AGENT_PROVIDERS as readonly unknown[]).includes(p)) return null;
    if (!out.includes(p as AgentProvider)) out.push(p as AgentProvider);
  }
  if (out.length === 0 || out.length === AGENT_PROVIDERS.length) return undefined;
  return out;
}

/** Validate a steer's required label + text strings. Returns null on any violation. */
function validateSteerLabelText(
  o: Record<string, unknown>,
): { label: string; text: string } | null {
  if (typeof o.label !== "string" || typeof o.text !== "string") return null;
  const label = o.label.trim();
  const text = o.text.trim();
  if (label.length === 0 || label.length > STEER_LABEL_MAX) return null;
  if (text.length === 0 || text.length > STEER_TEXT_MAX) return null;
  return { label, text };
}

/** Validate a steer's surface flags + the "must render somewhere" guard. Null on violation.
 *  Legacy payloads predate the surfaces: they were steer-bar-only chips. */
function validateSteerSurfaces(
  o: Record<string, unknown>,
): { inSteerBar: boolean; onIssues: boolean } | null {
  const inSteerBar = validateSteerScope(o.inSteerBar, true);
  const onIssues = validateSteerScope(o.onIssues, false);
  if (inSteerBar === null || onIssues === null) return null;
  // both surfaces off → the steer renders nowhere; mirror the SteersEditor guard
  if (!inSteerBar && !onIssues) return null;
  return { inSteerBar, onIssues };
}

/** Validate + normalize a single steer item. Returns null on any violation. */
function validateSteerItem(it: unknown): Steer | null {
  if (it === null || typeof it !== "object" || Array.isArray(it)) return null;
  const o = it as Record<string, unknown>;
  const labelText = validateSteerLabelText(o);
  const surfaces = validateSteerSurfaces(o);
  if (labelText === null || surfaces === null) return null;
  const emoji = validateSteerEmoji(o.emoji);
  const repos = validateSteerRepos(o.repos);
  const agentProviders = validateSteerAgentProviders(o.agentProviders);
  if (emoji === null || repos === null || agentProviders === null) return null;
  const id = typeof o.id === "string" && o.id.length > 0 ? o.id : randomUUID();
  return {
    id,
    label: labelText.label,
    text: labelText.text,
    ...(emoji !== undefined ? { emoji } : {}),
    inSteerBar: surfaces.inSteerBar,
    onIssues: surfaces.onIssues,
    ...(repos !== undefined ? { repos } : {}),
    ...(agentProviders !== undefined ? { agentProviders } : {}),
  };
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
  const seenIds = new Set<string>();
  for (const it of o.steps) {
    const step = validateBuildStepItem(it);
    if (step === null) return null;
    // Explicit ids are stored verbatim and must be unique within a queue (the composite PK
    // (sessionId, id) would otherwise throw on insert) — reject duplicates as an invalid body.
    if (step.id !== undefined) {
      if (seenIds.has(step.id)) return null;
      seenIds.add(step.id);
    }
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

// Caps for the epic-draft PUT body — bound the structural size (issue creation limits + abuse guard).
const EPIC_DRAFT_TITLE_MAX = 200; // matches the /api/issues create title cap
const EPIC_DRAFT_BODY_MAX = 16000; // matches the /api/issues create body cap
const EPIC_DRAFT_CHILDREN_MAX = 50;
const EPIC_DRAFT_LIST_MAX = 30; // acceptanceCriteria / nonGoals / blockedBy entries
const EPIC_DRAFT_KEY_MAX = 64;

/** Coerce an optional string[] field: absent → []; reject a non-array or non-string/oversized item. */
function stringArrayField(value: unknown, itemMax: number): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > EPIC_DRAFT_LIST_MAX) return null;
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string" || v.length > itemMax) return null;
    out.push(v);
  }
  return out;
}

function validateEpicDraftChild(value: unknown): EpicDraftChild | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (typeof o.key !== "string" || o.key.length === 0 || o.key.length > EPIC_DRAFT_KEY_MAX)
    return null;
  if (typeof o.title !== "string" || o.title.length > EPIC_DRAFT_TITLE_MAX) return null;
  const body = o.body === undefined ? "" : o.body;
  if (typeof body !== "string" || body.length > EPIC_DRAFT_BODY_MAX) return null;
  const acceptanceCriteria = stringArrayField(o.acceptanceCriteria, EPIC_DRAFT_BODY_MAX);
  if (acceptanceCriteria === null) return null;
  const blockedBy = stringArrayField(o.blockedBy, EPIC_DRAFT_KEY_MAX);
  if (blockedBy === null) return null;
  return { key: o.key, title: o.title, body, acceptanceCriteria, blockedBy };
}

/** Structurally validate the draft's parent object (types + size caps), or null on violation. */
function validateEpicDraftParent(value: unknown): EpicDraftContent["parent"] | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const parent = value as Record<string, unknown>;
  if (typeof parent.title !== "string" || parent.title.length > EPIC_DRAFT_TITLE_MAX) return null;
  const body = parent.body === undefined ? "" : parent.body;
  if (typeof body !== "string" || body.length > EPIC_DRAFT_BODY_MAX) return null;
  const acceptanceCriteria = stringArrayField(parent.acceptanceCriteria, EPIC_DRAFT_BODY_MAX);
  if (acceptanceCriteria === null) return null;
  const nonGoals = stringArrayField(parent.nonGoals, EPIC_DRAFT_BODY_MAX);
  if (nonGoals === null) return null;
  return { title: parent.title, body, acceptanceCriteria, nonGoals };
}

/**
 * Validate the PUT /api/sessions/:id/epic-draft body into a typed {@link EpicDraftContent}.
 * STRUCTURAL only (types + size caps); semantic checks (dependency cycles, unknown/self edges,
 * empty parent title, zero children) are `validateEpicDraft` in epic-author.ts, run by the handler.
 * Returns null on any structural violation.
 */
export function validateEpicDraftBody(body: unknown): EpicDraftContent | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const o = body as Record<string, unknown>;
  const parent = validateEpicDraftParent(o.parent);
  if (parent === null) return null;
  if (!Array.isArray(o.children) || o.children.length > EPIC_DRAFT_CHILDREN_MAX) return null;
  const children: EpicDraftChild[] = [];
  for (const c of o.children) {
    const child = validateEpicDraftChild(c);
    if (child === null) return null;
    children.push(child);
  }
  return { parent, children };
}

/** Validate a PATCH body for PUT /api/epic. Returns null on any violation. */
export type EpicRunPatch = {
  mode?: "auto" | "attended";
  status?: "idle" | "running" | "paused";
  agentProvider?: AgentProvider | null;
  model?: string | null;
  effort?: string | null;
};

const EPIC_RUN_PATCH_KEYS = ["mode", "status", "agentProvider", "model", "effort"] as const;
const EPIC_RUN_PATCH_KEY_SET = new Set(EPIC_RUN_PATCH_KEYS);
type EpicRunPatchKey = (typeof EPIC_RUN_PATCH_KEYS)[number];
type EpicRunPatchFieldValidator = (value: unknown, out: EpicRunPatch) => boolean;

function parseEpicRunMode(v: unknown): EpicRunPatch["mode"] | null {
  return v === "auto" || v === "attended" ? v : null;
}

function parseEpicRunStatus(v: unknown): EpicRunPatch["status"] | null {
  return v === "idle" || v === "running" || v === "paused" ? v : null;
}

function parseEpicRunAgentProvider(v: unknown): AgentProvider | null | undefined {
  if (v === null) return null;
  return (AGENT_PROVIDERS as readonly unknown[]).includes(v) ? (v as AgentProvider) : undefined;
}

const EPIC_RUN_PATCH_FIELD_VALIDATORS: Record<EpicRunPatchKey, EpicRunPatchFieldValidator> = {
  mode(value, out) {
    const mode = parseEpicRunMode(value);
    if (mode === null) return false;
    out.mode = mode;
    return true;
  },
  status(value, out) {
    const status = parseEpicRunStatus(value);
    if (status === null) return false;
    out.status = status;
    return true;
  },
  agentProvider(value, out) {
    const agentProvider = parseEpicRunAgentProvider(value);
    if (agentProvider === undefined) return false;
    out.agentProvider = agentProvider;
    return true;
  },
  model(value, out) {
    const model = validateModel(value, out.agentProvider ?? undefined);
    if (!model.ok) return false;
    out.model = model.value;
    return true;
  },
  effort(value, out) {
    const effort = validateEffort(value);
    if (!effort.ok) return false;
    out.effort = effort.value;
    return true;
  },
};

export function validateEpicRunPatch(v: unknown): EpicRunPatch | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).some((key) => !EPIC_RUN_PATCH_KEY_SET.has(key as EpicRunPatchKey)))
    return null;
  const out: EpicRunPatch = {};
  for (const key of EPIC_RUN_PATCH_KEYS) {
    if (key in o && !EPIC_RUN_PATCH_FIELD_VALIDATORS[key](o[key], out)) return null;
  }
  return out;
}

function validateTextToIds(body: unknown): { text: string; ids: string[] } | null {
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

/** Validate a POST /api/broadcast payload. Returns null on any violation. */
export function validateBroadcast(body: unknown): { text: string; ids: string[] } | null {
  return validateTextToIds(body);
}

/** Validate a POST /api/retry payload. Returns null on any violation. */
export function validateRetry(body: unknown): { text: string; ids: string[] } | null {
  return validateTextToIds(body);
}
