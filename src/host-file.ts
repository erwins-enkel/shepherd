import { constants, promises as fsp } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { readTranscriptTailAsync } from "./activity";
import { parseClaudeMessages, parseCodexMessages } from "./agent-messages";
import { config } from "./config";
import { eachJsonlObject } from "./jsonl";
import { isUnder } from "./process-reaper";
import { agentTmpDir, legacyClaudeTmpRoot } from "./tmp-sweep";
import type { AgentProvider } from "./types";

/**
 * Read-only access to host files an agent reported OUTSIDE its worktree and scratchpad (#4017),
 * e.g. a tool report under `~/.local/state/…` the agent linked in chat. A new read surface for
 * host files, so every read passes all of these, in order:
 *
 * 1. scope + denylist on the lexical path (no IO): only under `$HOME` or the tmp dir, never a
 *    credential/env/key file or Shepherd's own state ({@link deniedHostPath});
 * 2. allow-list: the session announced the path itself — in its own assistant text (what the Chat
 *    renders) or as a Claude Write/Edit target. Tool results and user messages never count;
 * 3. the realpath passes (1) again, so a symlink can't launder a denied target;
 * 4. a regular file, ≤ {@link MAX_HOST_FILE_BYTES}, not owner-only (secret stores are 0600),
 *    UTF-8 text without NUL bytes. Opened with O_NOFOLLOW; the read re-checks the open fd.
 *
 * The denylist can never be complete; it is defense in depth behind the allow-list.
 */

export const MAX_HOST_FILE_BYTES = 1024 * 1024;
const SNIFF_BYTES = 8 * 1024;
/** Matches the Chat's own read-back window (MESSAGES_TAIL_MAX_BYTES in agent-messages). */
const TRANSCRIPT_TAIL_BYTES = 16 * 1024 * 1024;
const CACHE_MAX = 32;

const DENIED_SEGMENTS: ReadonlySet<string> = new Set([
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".password-store",
  ".netrc",
  ".git-credentials",
  ".npmrc",
  ".pypirc",
  ".pgpass",
  ".claude",
  ".claude.json",
  ".codex",
  ".shepherd",
  "keyrings",
]);
const DENIED_BASENAMES: ReadonlySet<string> = new Set([
  "credentials",
  "credentials.json",
  ".credentials.json",
  "auth.json",
  "token.json",
  "secrets.json",
  ".htpasswd",
]);
const DENIED_EXT = /\.(pem|key|p12|pfx|kdbx|env)$/i;
const DENIED_KEY_PREFIX = /^id_(rsa|dsa|ecdsa|ed25519)/;
const DENIED_HOME_DIRS = [".config/gh", ".config/shepherd", ".config/gcloud", ".cache/shepherd"];

export interface HostEnv {
  home: string;
  /** Roots a host file may live under ($HOME, tmp), lexical and realpath. */
  scopeRoots: string[];
  /** Whole subtrees that are never readable, lexical and realpath. */
  deniedRoots: string[];
}

const deniedSegment = (seg: string): boolean =>
  seg.startsWith(".env") || seg.startsWith("shepherd-spawn-") || DENIED_SEGMENTS.has(seg);

const deniedBasename = (name: string): boolean =>
  DENIED_BASENAMES.has(name) || DENIED_EXT.test(name) || DENIED_KEY_PREFIX.test(name);

/** True when an absolute, normalized `p` is out of scope or matches the denylist. Pure. */
export function deniedHostPath(p: string, env: HostEnv): boolean {
  if (!env.scopeRoots.some((r) => isUnder(p, r))) return true;
  if (env.deniedRoots.some((r) => isUnder(p, r))) return true;
  if (p.split("/").some(deniedSegment)) return true;
  return deniedBasename(basename(p));
}

async function withReal(paths: string[]): Promise<string[]> {
  const out = new Set<string>();
  for (const p of paths) {
    if (!isAbsolute(p)) continue;
    const n = normalize(p).replace(/(.)\/$/, "$1");
    out.add(n);
    const real = await fsp.realpath(n).catch(() => null);
    if (real) out.add(real);
  }
  return [...out];
}

/** The live environment the guard checks against. Read at call time (HOME, TMPDIR). */
export async function hostEnv(): Promise<HostEnv> {
  const home = process.env.HOME || homedir();
  const denied = [
    ...DENIED_HOME_DIRS.map((d) => join(home, d)),
    agentTmpDir() ?? "",
    legacyClaudeTmpRoot(),
    dirname(config.dbPath),
  ];
  return {
    home,
    scopeRoots: await withReal([home, "/tmp", tmpdir()]),
    deniedRoots: await withReal(denied),
  };
}

// ── allow-list: what the session itself announced ─────────────────────────────

export interface HostAllowList {
  /** The session's assistant text messages (what the Chat renders). */
  texts: string[];
  /** Normalized Claude Write/Edit/MultiEdit/NotebookEdit targets. */
  writes: Set<string>;
}

const WRITE_TOOLS: ReadonlySet<unknown> = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

interface ToolUse {
  type?: unknown;
  name?: unknown;
  input?: { file_path?: unknown; notebook_path?: unknown } | null;
}

function writeTarget(b: ToolUse): string | null {
  if (b?.type !== "tool_use" || !WRITE_TOOLS.has(b.name)) return null;
  const p = b.input?.file_path ?? b.input?.notebook_path;
  return typeof p === "string" && isAbsolute(p) ? normalize(p) : null;
}

function claudeWrites(text: string): Set<string> {
  const out = new Set<string>();
  for (const o of eachJsonlObject(text)) {
    const rec = o as { type?: unknown; isSidechain?: unknown; message?: { content?: unknown } };
    if (rec?.type !== "assistant" || rec.isSidechain === true) continue;
    const content = rec.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as ToolUse[]) {
      const p = writeTarget(b);
      if (p) out.add(p);
    }
  }
  return out;
}

export function parseAllowList(text: string, provider: AgentProvider): HostAllowList {
  const parsed = provider === "codex" ? parseCodexMessages(text) : parseClaudeMessages(text);
  return {
    texts: parsed.messages.filter((m) => m.role === "assistant").map((m) => m.text),
    writes: provider === "codex" ? new Set() : claudeWrites(text),
  };
}

const allowCache = new Map<string, { size: number; mtimeMs: number; allow: HostAllowList }>();

/** The transcript's allow-list, parsed once per (size, mtime) so N chat links cost one parse. */
async function hostAllowList(
  transcriptPath: string,
  provider: AgentProvider,
): Promise<HostAllowList | null> {
  const st = await fsp.stat(transcriptPath).catch(() => null);
  if (!st?.isFile()) return null;
  const hit = allowCache.get(transcriptPath);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.allow;
  const text = await readTranscriptTailAsync(transcriptPath, TRANSCRIPT_TAIL_BYTES).catch(
    () => null,
  );
  if (text === null) return null;
  const allow = parseAllowList(text, provider);
  allowCache.delete(transcriptPath);
  allowCache.set(transcriptPath, { size: st.size, mtimeMs: st.mtimeMs, allow });
  if (allowCache.size > CACHE_MAX) allowCache.delete(allowCache.keys().next().value!);
  return allow;
}

/** A char that would extend a path on the left: the match is then part of a longer path. */
const PATH_CHAR_BEFORE = /[\w.~/-]/;
/** A char that may end a path in prose or Markdown. */
const PATH_END = /[\s`)>\]"'#?,;:*|]/;

function boundedAt(text: string, i: number, len: number): boolean {
  const before = i === 0 ? "" : text[i - 1]!;
  if (before && PATH_CHAR_BEFORE.test(before)) return false;
  const after = text[i + len] ?? "";
  if (!after || PATH_END.test(after)) return true;
  // Sentence punctuation right after the path ("saved to /x/r.md.").
  const next = text[i + len + 1] ?? "";
  return (after === "." || after === "!") && (!next || /\s/.test(next));
}

function occurs(text: string, needle: string): boolean {
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1))
    if (boundedAt(text, i, needle.length)) return true;
  return false;
}

/** Did the session announce `p` — a Write/Edit target, or named in its own assistant text as the
 *  raw path, `~/…`, percent-encoded, or `file://` URL, delimited on both sides? */
export function announced(allow: HostAllowList, p: string, home: string): boolean {
  if (allow.writes.has(p)) return true;
  const forms = new Set([p, encodeURI(p), `file://${encodeURI(p)}`]);
  if (isUnder(p, home) && p !== home) {
    const rest = p.slice(home.replace(/\/$/, "").length);
    forms.add(`~${rest}`);
    forms.add(`~${encodeURI(rest)}`);
  }
  return allow.texts.some((t) => [...forms].some((f) => occurs(t, f)));
}

// ── resolve + read ────────────────────────────────────────────────────────────

export interface HostFile {
  /** The normalized path as announced. */
  path: string;
  real: string;
  size: number;
  dev: number;
  ino: number;
}

interface TextRead {
  text: string;
  size: number;
  dev: number;
  ino: number;
}

function decodeText(bytes: Buffer, partial: boolean): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: partial });
  } catch {
    return null;
  }
}

/** Open `real` without following a symlink and read it (or its first {@link SNIFF_BYTES}) as text,
 *  refusing anything but a small, group/other-readable, UTF-8, NUL-free regular file. */
async function readText(real: string, sniff: boolean): Promise<TextRead | null> {
  const fh = await fsp.open(real, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!fh) return null;
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > MAX_HOST_FILE_BYTES || (st.mode & 0o044) === 0) return null;
    const want = sniff ? Math.min(st.size, SNIFF_BYTES) : st.size;
    const buf = Buffer.alloc(want);
    const { bytesRead } = await fh.read(buf, 0, want, 0);
    const text = decodeText(buf.subarray(0, bytesRead), sniff && want < st.size);
    return text === null ? null : { text, size: st.size, dev: st.dev, ino: st.ino };
  } finally {
    await fh.close();
  }
}

function expandPath(rawPath: string, home: string): string | null {
  if (!rawPath || rawPath.includes("\0")) return null;
  const expanded = rawPath.startsWith("~/") ? home.replace(/\/$/, "") + rawPath.slice(1) : rawPath;
  return isAbsolute(expanded) ? normalize(expanded) : null;
}

export interface HostLookup {
  transcriptPath: string | null;
  provider: AgentProvider;
}

/** Resolve a host path the session reported, or null when any guard refuses it (see header). */
export async function resolveHostFile(rawPath: string, q: HostLookup): Promise<HostFile | null> {
  if (!q.transcriptPath) return null;
  const env = await hostEnv();
  const p = expandPath(rawPath, env.home);
  if (!p || deniedHostPath(p, env)) return null;
  const allow = await hostAllowList(q.transcriptPath, q.provider);
  if (!allow || !announced(allow, p, env.home)) return null;
  const real = await fsp.realpath(p).catch(() => null);
  if (!real || deniedHostPath(real, env)) return null;
  const head = await readText(real, true);
  return head ? { path: p, real, size: head.size, dev: head.dev, ino: head.ino } : null;
}

/** The whole text of a resolved host file, or null if it changed identity or no longer passes. */
export async function readHostFile(hit: HostFile): Promise<string | null> {
  const r = await readText(hit.real, false);
  return r && r.dev === hit.dev && r.ino === hit.ino ? r.text : null;
}
