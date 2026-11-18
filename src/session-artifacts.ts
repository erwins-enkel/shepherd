// Artifacts a Claude session published with Claude Code's `Artifact` tool (#3875).
//
// The hook ingest hands every matched `PostToolUse(Artifact)` to `parseArtifactPublish`; a publish
// that names a valid artifact URL becomes one entry per URL on the session, persisted with the
// session row and pushed to every client as `session:artifacts` (always the full list).
//
// The shape read here is the real http-hook body (test/fixtures/hooks/artifact-publish.json):
// `tool_response` is an object whose top-level `url`/`seq` describe the artifact a publish wrote,
// while `read`/`delete` nest their url one level down and so never count.

import { constants } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { isArtifactUrl, shortArtifactUrl } from "../shared/artifact-url";
import { within } from "./fs-browse";
import type { Session } from "./types";

/** One published artifact of a session. Title and url are agent-supplied: render as text only. */
export type SessionArtifact = {
  url: string;
  title: string;
  /** Starts at the result's `seq` (else 1) and grows by at least one on every re-publish. */
  versions: number;
  firstSeenAt: number;
  updatedAt: number;
  /** The `tool_use_id` of the latest publish; null when the hook carried none. */
  toolUseId: string | null;
};

/** What one publishing `Artifact` call contributes, before the title is resolved. */
export type ArtifactPublish = {
  url: string;
  toolUseId?: string;
  inputTitle?: string;
  filePath?: string;
  seq?: number;
};

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const TITLE_MAX = 200;

/** Agent-supplied title text made safe to show: no control/format chars, whitespace collapsed,
 *  capped. Undefined when nothing is left. */
function cleanTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean ? clean.slice(0, TITLE_MAX) : undefined;
}

/**
 * The publish one successful `Artifact` call made, or null when it was no publish: an action
 * other than publish (read, list, delete, open, pin, unpin, quickstart, …), an asset upload, or a
 * result without a valid artifact url at its top level. The caller passes only ok PostToolUse
 * events — a failed call never reaches here.
 */
export function parseArtifactPublish(
  toolInput: unknown,
  response: unknown,
  toolUseId?: string,
): ArtifactPublish | null {
  const input = obj(toolInput) ?? {};
  const action = input.action;
  if (action !== undefined && action !== null && action !== "" && action !== "publish") return null;
  if (input.asset === true) return null;
  const url = obj(response)?.url;
  if (!isArtifactUrl(url)) return null;
  const publish: ArtifactPublish = { url };
  if (toolUseId) publish.toolUseId = toolUseId;
  const inputTitle = cleanTitle(input.title);
  if (inputTitle) publish.inputTitle = inputTitle;
  if (typeof input.file_path === "string" && input.file_path) publish.filePath = input.file_path;
  const seq = obj(response)?.seq;
  if (typeof seq === "number" && Number.isSafeInteger(seq) && seq > 0) publish.seq = seq;
  return publish;
}

/**
 * Merge one publish into a session's list. A new url appends an entry; a known url keeps its
 * entry (and `firstSeenAt`), counts its version up — to the result's `seq` when that is higher —
 * and takes the new `updatedAt` and `toolUseId`. A fallback title (the shortened url) never
 * replaces a title the entry already has. Nothing is ever dropped.
 */
export function applyArtifactPublish(
  list: SessionArtifact[],
  p: { url: string; title: string; titleIsFallback: boolean; seq?: number; toolUseId?: string },
  now: number,
): SessionArtifact[] {
  const toolUseId = p.toolUseId ?? null;
  const index = list.findIndex((a) => a.url === p.url);
  if (index < 0) {
    return [
      ...list,
      {
        url: p.url,
        title: p.title,
        versions: p.seq ?? 1,
        firstSeenAt: now,
        updatedAt: now,
        toolUseId,
      },
    ];
  }
  const prev = list[index]!;
  const next: SessionArtifact = {
    ...prev,
    title: p.titleIsFallback ? prev.title : p.title,
    versions: Math.max(prev.versions + 1, p.seq ?? 0),
    updatedAt: now,
    toolUseId,
  };
  return list.map((a, i) => (i === index ? next : a));
}

/** Bounds of the `<title>` scan. Exported so tests can shrink them. */
export const TITLE_READ_LIMITS = {
  /** Never read past this many bytes, nor past the file's size when it was opened. */
  maxBytes: 4 * 1024 * 1024,
  chunkBytes: 64 * 1024,
  /** Characters kept before `<title` is seen — enough for the tag to straddle two chunks. */
  overhang: 16,
  /** Characters buffered from `<title` on; a longer title without its end counts as none. */
  maxTitleChars: 8 * 1024,
  timeoutMs: 2000,
};

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] !== "#") return ENTITIES[ref.toLowerCase()] ?? whole;
    const code =
      ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : whole;
  });
}

/** The worktree-relative form of `filePath`, or null when it points outside the worktree. An
 *  absolute path may use the worktree's path as stored or its real path. */
function worktreeRelative(worktreePath: string, rootReal: string, filePath: string): string | null {
  const candidates = isAbsolute(filePath)
    ? [relative(worktreePath, filePath), relative(rootReal, filePath)]
    : [normalize(filePath)];
  for (const rel of candidates) {
    if (rel && rel !== "." && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
      return rel;
  }
  return null;
}

type ScanState = { aborted: boolean };

/** Scan an open file for its first `<title>…</title>`, reading at most `limit` bytes. */
async function titleFromHandle(
  fh: FileHandle,
  limit: number,
  state: ScanState,
): Promise<string | null> {
  const { chunkBytes, overhang, maxTitleChars } = TITLE_READ_LIMITS;
  const buf = Buffer.alloc(chunkBytes);
  const decoder = new TextDecoder("utf-8");
  let pending = "";
  let opened = false;
  let pos = 0;
  while (pos < limit && !state.aborted) {
    const { bytesRead } = await fh.read(buf, 0, Math.min(chunkBytes, limit - pos), pos);
    if (bytesRead === 0) break;
    pos += bytesRead;
    pending += decoder.decode(buf.subarray(0, bytesRead), { stream: true });
    if (!opened) {
      const start = pending.search(/<title(?=[\s>/])/i);
      if (start < 0) {
        pending = pending.slice(-overhang);
        continue;
      }
      opened = true;
      pending = pending.slice(start);
    }
    const match = /^<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(pending);
    if (match) return cleanTitle(decodeEntities(match[1]!)) ?? null;
    if (pending.length > maxTitleChars) return null;
  }
  return null;
}

/** Open `filePath` inside the worktree and scan it — only after the open handle itself proved
 *  to be a regular file that the worktree's real path reaches (same device and inode). */
async function scanWorktreeFile(
  worktreePath: string,
  filePath: string,
  state: ScanState,
): Promise<string | null> {
  const root = await realpath(worktreePath);
  const rel = worktreeRelative(worktreePath, root, filePath);
  if (!rel) return null;
  const target = join(root, rel);
  const flags =
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY | constants.O_NOFOLLOW;
  const fh = await open(target, flags);
  try {
    if (state.aborted) return null;
    const opened = await fh.stat({ bigint: true });
    if (!opened.isFile()) return null;
    const real = await realpath(target);
    if (!within(real, root)) return null;
    const reached = await stat(real, { bigint: true });
    if (reached.dev !== opened.dev || reached.ino !== opened.ino) return null;
    const limit = Math.min(Number(opened.size), TITLE_READ_LIMITS.maxBytes);
    return await titleFromHandle(fh, limit, state);
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * The first `<title>` of `filePath` when it lies inside the session's worktree, or null — outside
 * the worktree, not a regular file, no complete title within the bounds of
 * {@link TITLE_READ_LIMITS}, out of time, or any error. Never throws.
 */
export async function readTitleInWorktree(
  worktreePath: string,
  filePath: string,
): Promise<string | null> {
  if (!worktreePath || !filePath) return null;
  const state: ScanState = { aborted: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), TITLE_READ_LIMITS.timeoutMs);
  });
  try {
    return await Promise.race([
      scanWorktreeFile(worktreePath, filePath, state).catch(() => null),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
    // A scan still running stops at its next chunk; its own `finally` closes the handle.
    state.aborted = true;
  }
}

/** Where a recorded publish goes: the session row and every client. */
export type ArtifactSink = {
  store: {
    get(id: string): Pick<Session, "artifacts"> | null | undefined;
    setSessionArtifacts(id: string, artifacts: SessionArtifact[]): void;
  };
  emit: (id: string, artifacts: SessionArtifact[]) => void;
};

async function applyPublish(
  sink: ArtifactSink,
  session: Pick<Session, "id" | "worktreePath">,
  publish: ArtifactPublish,
  now: number,
): Promise<void> {
  const fileTitle =
    !publish.inputTitle && publish.filePath
      ? await readTitleInWorktree(session.worktreePath, publish.filePath)
      : null;
  const title = publish.inputTitle ?? fileTitle;
  const current = sink.store.get(session.id);
  if (!current) return;
  const next = applyArtifactPublish(
    current.artifacts ?? [],
    {
      url: publish.url,
      title: title ?? shortArtifactUrl(publish.url),
      titleIsFallback: !title,
      seq: publish.seq,
      toolUseId: publish.toolUseId,
    },
    now,
  );
  sink.store.setSessionArtifacts(session.id, next);
  sink.emit(session.id, next);
}

// sessionId → the tail of its publish chain, so an async title read never reorders two publishes.
const chains = new Map<string, Promise<void>>();

/** Record one publish for a session: resolve its title, merge it into the stored list, persist
 *  and push. Publishes of one session apply in arrival order. Never rejects. */
export function recordArtifactPublish(
  sink: ArtifactSink,
  session: Pick<Session, "id" | "worktreePath">,
  publish: ArtifactPublish,
  now: number,
): Promise<void> {
  const run = (chains.get(session.id) ?? Promise.resolve())
    .then(() => applyPublish(sink, session, publish, now))
    .catch((err) => {
      console.warn(`[artifacts] record failed for session=${session.id}: ${String(err)}`);
    });
  chains.set(session.id, run);
  void run.then(() => {
    if (chains.get(session.id) === run) chains.delete(session.id);
  });
  return run;
}
