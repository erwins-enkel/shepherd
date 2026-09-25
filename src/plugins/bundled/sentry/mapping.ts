// Repo → Sentry project mapping SUGGESTIONS (#2464), in precedence order:
//   1. the repo's own Sentry config (bundler plugin options, `.sentryclirc`, `sentry.properties`);
//   2. Sentry's private, undocumented `code-mappings` endpoint (any failure is ignored);
//   3. manual entry (panel).
// Suggestions are never used until the operator confirms them.

import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { isSlug } from "./api";
import type { MappingSource, Suggestion } from "./state";

export type ReadText = (path: string) => Promise<string | null>;

/** `readFile` as text, null when unreadable or larger than 256 KB. */
export const readText: ReadText = async (path) => {
  try {
    const s = await readFile(path, "utf8");
    return s.length > 256 * 1024 ? null : s;
  } catch {
    return null;
  }
};

const BUNDLER_CONFIGS = [
  "vite.config.ts",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.mts",
  "svelte.config.js",
  "webpack.config.js",
  "webpack.config.ts",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "astro.config.mjs",
  "astro.config.ts",
];

interface OrgProject {
  org: string | null;
  project: string;
}

function literal(text: string, key: string): string | null {
  const m = new RegExp(`\\b${key}\\s*:\\s*["'\`]([^"'\`\\s]+)["'\`]`).exec(text);
  return m?.[1] ?? null;
}

/** `org`/`project` string literals from a Sentry bundler-plugin config. Only when the file
 *  mentions Sentry, so an unrelated `project:` key is not mistaken for one. */
export function parseBundlerConfig(text: string): OrgProject | null {
  if (!/sentry/i.test(text)) return null;
  const project = literal(text, "project");
  return isSlug(project) ? { org: literal(text, "org"), project } : null;
}

/** `.sentryclirc` (INI, `[defaults]` section). */
export function parseSentryclirc(text: string): OrgProject | null {
  let section = "";
  const vals: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    const sec = /^\[(.+)\]$/.exec(t);
    if (sec) section = sec[1]!.trim();
    const kv = /^([\w.]+)\s*=\s*(.*)$/.exec(t);
    if (kv && section === "defaults") vals[kv[1]!] = kv[2]!.trim();
  }
  return isSlug(vals.project) ? { org: vals.org ?? null, project: vals.project } : null;
}

/** `sentry.properties` (`defaults.org=`, `defaults.project=`). */
export function parseSentryProperties(text: string): OrgProject | null {
  const vals: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const kv = /^\s*(defaults\.(?:org|project))\s*[=:]\s*(.*)$/.exec(line);
    if (kv) vals[kv[1]!] = kv[2]!.trim();
  }
  const project = vals["defaults.project"];
  return isSlug(project) ? { org: vals["defaults.org"] ?? null, project } : null;
}

const FILE_PARSERS: Array<[string, (t: string) => OrgProject | null, MappingSource]> = [
  ...BUNDLER_CONFIGS.map(
    (f) =>
      [f, parseBundlerConfig, "sentry-config"] as [
        string,
        typeof parseBundlerConfig,
        MappingSource,
      ],
  ),
  [".sentryclirc", parseSentryclirc, "sentryclirc"],
  ["sentry.properties", parseSentryProperties, "sentry-properties"],
];

/** First suggestion found in the repo's root files, or null. */
export async function detectFromFiles(
  repo: string,
  read: ReadText = readText,
): Promise<Suggestion | null> {
  for (const [file, parse, source] of FILE_PARSERS) {
    const text = await read(join(repo, file));
    const hit = text === null ? null : parse(text);
    if (hit) return { repo, org: hit.org, project: hit.project, source };
  }
  return null;
}

// ── code-mappings (private API) ──────────────────────────────────────────────────────────

/** `owner/repo` from a git remote URL (https or scp-style ssh), lowercased. */
export function repoSlugFromUrl(url: string): string | null {
  const m = /[:/]([^/:\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

function originFromConfig(text: string): string | null {
  let inOrigin = false;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("[")) inOrigin = /^\[remote\s+"origin"\]$/.test(t);
    const url = inOrigin ? /^url\s*=\s*(.+)$/.exec(t) : null;
    if (url) return url[1]!.trim();
  }
  return null;
}

/** The repo's `origin` URL, read from git config files (no git subprocess). Handles a linked
 *  worktree, whose `.git` is a `gitdir:` file pointing at a dir with a `commondir`. */
export async function originUrl(repo: string, read: ReadText = readText): Promise<string | null> {
  let gitDir = join(repo, ".git");
  const gitFile = await read(gitDir);
  const pointer = gitFile === null ? null : /^gitdir:\s*(.+)$/m.exec(gitFile);
  if (pointer) {
    const p = pointer[1]!.trim();
    gitDir = isAbsolute(p) ? p : resolve(repo, p);
    const common = (await read(join(gitDir, "commondir")))?.trim();
    if (common) gitDir = isAbsolute(common) ? common : resolve(gitDir, common);
  }
  const config = await read(join(gitDir, "config"));
  return config === null ? null : originFromConfig(config);
}

/** Suggestions from a code-mappings response for repos whose origin slug matches `repoName`. */
export function matchCodeMappings(
  data: unknown,
  repos: Array<{ path: string; slug: string }>,
): Suggestion[] {
  if (!Array.isArray(data)) return [];
  const bySlug = new Map(repos.map((r) => [r.slug, r.path]));
  const out: Suggestion[] = [];
  for (const row of data) {
    const o = row && typeof row === "object" ? (row as Record<string, unknown>) : null;
    const project = o?.projectSlug;
    const repoName = typeof o?.repoName === "string" ? o.repoName.toLowerCase() : null;
    const path = repoName ? bySlug.get(repoName) : undefined;
    if (path && isSlug(project) && !out.some((s) => s.repo === path)) {
      out.push({ repo: path, org: null, project, source: "code-mappings" });
    }
  }
  return out;
}
