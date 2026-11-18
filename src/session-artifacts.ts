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
import { open, readlink, realpath, type FileHandle } from "node:fs/promises";
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
  /** When it was last published; strictly increasing across a session's list, so the newest
   *  entry is never a tie. */
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
/** Bounds on agent-supplied values a hook event retains and a list rebroadcasts. */
const FILE_PATH_MAX = 4096;
const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,128}$/;

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
  if (toolUseId && TOOL_USE_ID.test(toolUseId)) publish.toolUseId = toolUseId;
  const inputTitle = cleanTitle(input.title);
  if (inputTitle) publish.inputTitle = inputTitle;
  const filePath = input.file_path;
  if (typeof filePath === "string" && filePath && filePath.length <= FILE_PATH_MAX)
    publish.filePath = filePath;
  const seq = obj(response)?.seq;
  if (typeof seq === "number" && Number.isSafeInteger(seq) && seq > 0) publish.seq = seq;
  return publish;
}

/**
 * Merge one publish into a session's list. A new url appends an entry; a known url keeps its
 * entry (and `firstSeenAt`), counts its version up — to the result's `seq` when that is higher —
 * and takes the new `updatedAt` and `toolUseId`. A fallback title (the shortened url) never
 * replaces a title the entry already has. Nothing is ever dropped. `updatedAt` is bumped past every
 * entry's, so two publishes in one millisecond keep their order.
 */
export function applyArtifactPublish(
  list: SessionArtifact[],
  p: { url: string; title: string; titleIsFallback: boolean; seq?: number; toolUseId?: string },
  now: number,
): SessionArtifact[] {
  const toolUseId = p.toolUseId ?? null;
  const at = list.reduce((t, a) => Math.max(t, a.updatedAt + 1), now);
  const index = list.findIndex((a) => a.url === p.url);
  if (index < 0) {
    return [
      ...list,
      {
        url: p.url,
        title: p.title,
        versions: p.seq ?? 1,
        firstSeenAt: now,
        updatedAt: at,
        toolUseId,
      },
    ];
  }
  const prev = list[index]!;
  const next: SessionArtifact = {
    ...prev,
    title: p.titleIsFallback ? prev.title : p.title,
    versions: Math.max(prev.versions + 1, p.seq ?? 0),
    updatedAt: at,
    toolUseId,
  };
  return list.map((a, i) => (i === index ? next : a));
}

/** Bounds of the `<title>` scan. Exported so tests can shrink them. */
export const TITLE_READ_LIMITS = {
  /** Never read past this many bytes, nor past the file's size when it was opened. */
  maxBytes: 4 * 1024 * 1024,
  chunkBytes: 64 * 1024,
  /** Characters of title text buffered; a longer title, or one without its end, counts as none. */
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

/** Elements whose content never holds the document title: raw text (script, style), escapable raw
 *  text (textarea), inert content (template, noscript) and foreign content (svg, math), whose own
 *  `<title>` is no document title. */
const SKIPPED = new Set(["script", "style", "textarea", "template", "noscript", "svg", "math"]);
/** Characters after `<` needed to tell a comment or one of the names above from other markup. */
const TAG_LOOKAHEAD = 10;

/**
 * A streaming scan for the HTML document title: the first `<title>` element outside comments and
 * outside {@link SKIPPED} elements, reading tag attributes quote-aware. Between chunks it keeps at
 * most a few characters, plus the title text itself up to `maxTitleChars`.
 */
class TitleScanner {
  #mode: "text" | "tag" | "comment" | "skip" | "title" = "text";
  #afterTag: "text" | "skip" | "title" = "text";
  #quote = "";
  #skipName = "";
  #carry = "";
  #title = "";
  /** The raw title once found; null once there is none to find; undefined while scanning. */
  result: string | null | undefined = undefined;

  feed(chunk: string, final: boolean): void {
    const buf = this.#carry + chunk;
    this.#carry = "";
    let i = 0;
    while (i >= 0 && i < buf.length && this.result === undefined) i = this.#step(buf, i, final);
    if (final && this.result === undefined) this.result = null;
  }

  /** One step from `i`; the next index, or -1 when the rest of `buf` is consumed (or carried). */
  #step(buf: string, i: number, final: boolean): number {
    switch (this.#mode) {
      case "text":
        return this.#text(buf, i, final);
      case "tag":
        return this.#tag(buf, i);
      case "comment":
        return this.#until(buf, i, /-->/g, 3);
      case "skip":
        return this.#until(
          buf,
          i,
          new RegExp(`</${this.#skipName}`, "gi"),
          this.#skipName.length + 2,
        );
      case "title":
        return this.#titleText(buf, i);
    }
  }

  #text(buf: string, i: number, final: boolean): number {
    const lt = buf.indexOf("<", i);
    if (lt < 0) return -1;
    if (!final && buf.length - lt < TAG_LOOKAHEAD) {
      this.#carry = buf.slice(lt);
      return -1;
    }
    if (buf.startsWith("<!--", lt)) {
      this.#mode = "comment";
      return lt + 4;
    }
    const named = /^<([a-z][a-z0-9-]*)(?=[\s/>])/i.exec(buf.slice(lt, lt + TAG_LOOKAHEAD + 1));
    const name = named?.[1]?.toLowerCase();
    if (!name && !/^<[a-z/!?]/i.test(buf.slice(lt, lt + 2))) return lt + 1;
    this.#mode = "tag";
    this.#quote = "";
    this.#skipName = name ?? "";
    this.#afterTag = name === "title" ? "title" : name && SKIPPED.has(name) ? "skip" : "text";
    return lt + 1;
  }

  /** Inside a tag: its end is the first `>` outside a quoted attribute value. */
  #tag(buf: string, i: number): number {
    for (let j = i; j < buf.length; j++) {
      const c = buf[j];
      if (this.#quote) {
        if (c === this.#quote) this.#quote = "";
      } else if (c === '"' || c === "'") {
        this.#quote = c;
      } else if (c === ">") {
        this.#mode = this.#afterTag;
        return j + 1;
      }
    }
    return -1;
  }

  /** Skip to the end marker; an end tag's own `>` is then skipped as a tag. */
  #until(buf: string, i: number, marker: RegExp, length: number): number {
    marker.lastIndex = i;
    const found = marker.exec(buf);
    if (!found) {
      this.#carry = buf.slice(Math.max(i, buf.length - (length - 1)));
      return -1;
    }
    if (this.#mode === "comment") {
      this.#mode = "text";
    } else {
      this.#mode = "tag";
      this.#afterTag = "text";
      this.#quote = "";
    }
    return found.index + length;
  }

  #titleText(buf: string, i: number): number {
    const end = /<\/title/gi;
    end.lastIndex = i;
    const found = end.exec(buf);
    const stop = found ? found.index : Math.max(i, buf.length - 7);
    this.#title += buf.slice(i, stop);
    if (this.#title.length > TITLE_READ_LIMITS.maxTitleChars) this.result = null;
    else if (found) this.result = this.#title;
    else this.#carry = buf.slice(stop);
    return -1;
  }
}

/** Scan an open file for its document title, reading at most `limit` bytes. */
async function titleFromHandle(
  fh: FileHandle,
  limit: number,
  state: ScanState,
): Promise<string | null> {
  const { chunkBytes } = TITLE_READ_LIMITS;
  const buf = Buffer.alloc(chunkBytes);
  const decoder = new TextDecoder("utf-8");
  const scanner = new TitleScanner();
  let pos = 0;
  while (pos < limit && !state.aborted && scanner.result === undefined) {
    const { bytesRead } = await fh.read(buf, 0, Math.min(chunkBytes, limit - pos), pos);
    if (bytesRead === 0) break;
    pos += bytesRead;
    scanner.feed(decoder.decode(buf.subarray(0, bytesRead), { stream: true }), false);
  }
  if (scanner.result === undefined && !state.aborted) scanner.feed(decoder.decode(), true);
  return scanner.result ? (cleanTitle(decodeEntities(scanner.result)) ?? null) : null;
}

/** macOS (11+) `open(2)` flag: fail on a symlink in ANY path component. Not in `fs.constants`. */
const DARWIN_O_NOFOLLOW_ANY = 0x20000000;

/**
 * Open `rel` under the real worktree root so the open itself proves where the file is — a later
 * path check could be fooled by swapping a parent directory. Linux asks the kernel where the opened
 * handle lives (`/proc/self/fd/<fd>`); macOS refuses a symlink anywhere in the path; any other
 * platform reads nothing. Null when the file is not inside the worktree.
 */
async function openInWorktree(root: string, rel: string): Promise<FileHandle | null> {
  const flags =
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY | constants.O_NOFOLLOW;
  const target = join(root, rel);
  if (process.platform === "darwin") return open(target, flags | DARWIN_O_NOFOLLOW_ANY);
  if (process.platform !== "linux") return null;
  const fh = await open(target, flags);
  const opened = await readlink(`/proc/self/fd/${fh.fd}`).catch(() => "");
  if (within(opened, root)) return fh;
  await fh.close().catch(() => {});
  return null;
}

/** Open `filePath` inside the worktree and scan it once the open handle proved to be a regular
 *  file there. Everything after the open goes through the handle. */
async function scanWorktreeFile(
  worktreePath: string,
  filePath: string,
  state: ScanState,
): Promise<string | null> {
  const root = await realpath(worktreePath);
  const rel = worktreeRelative(worktreePath, root, filePath);
  if (!rel) return null;
  const fh = await openInWorktree(root, rel);
  if (!fh) return null;
  try {
    if (state.aborted) return null;
    const opened = await fh.stat();
    if (!opened.isFile()) return null;
    return await titleFromHandle(fh, Math.min(opened.size, TITLE_READ_LIMITS.maxBytes), state);
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
