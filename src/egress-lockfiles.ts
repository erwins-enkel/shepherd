// Registry hosts a repo's lockfiles need (#3927), suggested in Repo settings › Agent before an
// Autonomous run hits the egress firewall. Lockfiles are repo content (agent-writable through
// PRs), so this only extracts hostnames: the UI's trust tiers decide how loudly Allow asks.
// Runs on the single server loop: git and file reads are async, and file count and bytes are
// capped so the (linear) regex passes stay bounded.

import { constants } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { urlEgressEntry } from "./egress";
import { execGit } from "./safe-git";
import type { EgressSuggestion } from "./types";

const LOCKFILE_NAMES = [
  "bun.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Cargo.lock",
  "uv.lock",
  "poetry.lock",
  "go.sum",
] as const;

const NPM = "registry.npmjs.org";
const YARN = "registry.yarnpkg.com";
const CRATES = ["crates.io", "static.crates.io", "index.crates.io"];
const PYPI = ["pypi.org", "files.pythonhosted.org"];
const GO = ["proxy.golang.org", "sum.golang.org"];
const CRATES_GIT_INDEX = "https://github.com/rust-lang/crates.io-index";

/** The allowlist entry (`host`, or `host:port` off 443 — see urlEgressEntry) of an http(s) URL,
 *  else null. */
function urlHost(raw: string): string | null {
  if (!/^https?:\/\//i.test(raw)) return null;
  return urlEgressEntry(raw);
}

/** Hosts of the URLs in capture group 1 of every `re` match. */
function captured(text: string, re: RegExp): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(re)) {
    const host = urlHost(match[1] ?? "");
    if (host) out.push(host);
  }
  return out;
}

// No `resolved` field at all (an old or workspace-only lockfile) = the default registry.
function npmLockHosts(text: string): string[] {
  if (!/"resolved":/.test(text)) return [NPM];
  return captured(text, /"resolved":\s*"([^"]+)"/g);
}

// Package tuples: ["name@version", "<registry>", {…}, "<integrity>"]; "" = the default registry.
function bunLockHosts(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/\[\s*"[^"]*@[^"]*",\s*"([^"]*)"/g)) {
    const slot = match[1] ?? "";
    const host = slot === "" ? NPM : urlHost(slot);
    if (host) out.push(host);
  }
  return out;
}

// `resolution: {integrity: …}` alone = the default registry; a `tarball:` names another.
function pnpmLockHosts(text: string): string[] {
  const out = captured(text, /tarball:\s*['"]?([^'"\s,}]+)/g);
  for (const match of text.matchAll(/resolution:\s*\{[^}\n]*\}/g)) {
    if (!match[0].includes("tarball:")) {
      out.push(NPM);
      break;
    }
  }
  return out;
}

function yarnLockHosts(text: string): string[] {
  const out = captured(text, /^\s+resolved\s+"([^"]+)"/gm);
  if (/^__metadata:/m.test(text) && text.includes("@npm:")) out.push(YARN);
  return out;
}

function cargoLockHosts(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/^source = "([^"]+)"/gm)) {
    const source = match[1] ?? "";
    const plus = source.indexOf("+");
    if (plus < 0) continue;
    const url = source.slice(plus + 1);
    const host = urlHost(url);
    if (!host) continue;
    if (source.startsWith("git+")) out.push(host);
    else if (url.replace(/\/$/, "") === CRATES_GIT_INDEX || host === "index.crates.io")
      out.push(...CRATES);
    else out.push(host);
  }
  return out;
}

/** The hosts lockfile `name` (a basename from {@link LOCKFILE_NAMES}) says its installs reach. */
export function hostsFromLockfile(name: string, text: string): string[] {
  let hosts: string[];
  switch (name) {
    case "package-lock.json":
      hosts = npmLockHosts(text);
      break;
    case "bun.lock":
      hosts = bunLockHosts(text);
      break;
    case "pnpm-lock.yaml":
      hosts = pnpmLockHosts(text);
      break;
    case "yarn.lock":
      hosts = yarnLockHosts(text);
      break;
    case "Cargo.lock":
      hosts = cargoLockHosts(text);
      break;
    case "uv.lock":
      hosts = captured(text, /\b(?:registry|url|git)\s*=\s*"([^"]+)"/g);
      break;
    case "poetry.lock":
      hosts = [...PYPI, ...captured(text, /^url\s*=\s*"([^"]+)"/gm)];
      break;
    case "go.sum":
      hosts = text.trim() ? [...GO] : [];
      break;
    default:
      hosts = [];
  }
  return [...new Set(hosts)];
}

export interface LockfileScanLimits {
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

const MAX_SOURCES = 5;
const MIB = 1024 * 1024;

/** The tracked lockfiles under `repoDir`, shallowest first; empty when git fails. */
async function trackedLockfiles(repoDir: string): Promise<string[]> {
  try {
    const { stdout } = await execGit(
      ["ls-files", "-z", "--", ...LOCKFILE_NAMES.map((n) => `:(glob)**/${n}`)],
      { cwd: repoDir, timeout: 10_000, maxBuffer: 4 * MIB },
    );
    const depth = (p: string) => p.split("/").length;
    return stdout
      .split("\0")
      .filter(Boolean)
      .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
  } catch {
    return [];
  }
}

/** The text of regular file `path` when it fits the budget and resolves inside `root` (a real
 *  path), else null: missing, a symlink, under a symlinked dir that leaves the repo, too big.
 *  Checks and read go through one open handle, so a swap between them can't change what is
 *  read: O_NOFOLLOW refuses a symlink, O_NONBLOCK keeps a FIFO from hanging the open, and the
 *  inode at the in-repo real path must be the opened one. */
async function readBounded(root: string, path: string, maxBytes: number): Promise<string | null> {
  let fh: FileHandle | undefined;
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = await fh.stat();
    if (!st.isFile() || st.size > maxBytes) return null;
    const real = await realpath(path);
    if (!real.startsWith(root + sep)) return null;
    const at = await stat(real);
    if (at.dev !== st.dev || at.ino !== st.ino) return null;
    return await fh.readFile("utf8");
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

/** Every host the repo's tracked lockfiles name, in first-seen order, with their sources. */
export async function suggestLockfileHosts(
  repoDir: string,
  limits: LockfileScanLimits = {},
): Promise<EgressSuggestion[]> {
  const { maxFiles = 50, maxFileBytes = 8 * MIB, maxTotalBytes = 32 * MIB } = limits;
  const byHost = new Map<string, EgressSuggestion>();
  let budget = maxTotalBytes;
  const files = (await trackedLockfiles(repoDir)).slice(0, maxFiles);
  if (!files.length) return [];
  const root = await realpath(repoDir);
  for (const rel of files) {
    const text = await readBounded(root, join(repoDir, rel), Math.min(maxFileBytes, budget));
    if (text === null) continue;
    budget -= text.length;
    for (const host of hostsFromLockfile(basename(rel), text)) {
      const entry = byHost.get(host) ?? { host, sources: [] };
      byHost.set(host, entry);
      if (entry.sources.length < MAX_SOURCES) entry.sources.push(rel);
    }
  }
  return [...byHost.values()];
}
