import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { CodexTranscriptLocator } from "./codex-activity";
import { CodexQuestionState, type CodexAsk } from "./codex-question-state";
import type { PendingAsk } from "./ask-user-question";
import type { Session } from "./types";

type QuestionSession = Pick<Session, "id" | "agentProvider" | "providerSessionId" | "herdrAgentId">;
interface Entry {
  identity: string;
  path: string;
  inode: number;
  offset: number;
  mtime: number;
  tail: string;
  decoder: StringDecoder;
  state: CodexQuestionState;
  visible: CodexAsk[];
}

function publicCodexAsk(ask: CodexAsk): PendingAsk {
  return { toolUseId: ask.toolUseId, questions: ask.questions };
}

/** Incremental, read-only observer of the proven conversation. No cwd/latest-file fallback. */
export class CodexQuestionTracker {
  private entries = new Map<string, Entry>();
  private reading = new Map<string, Promise<void>>();

  constructor(private locator = new CodexTranscriptLocator()) {}

  async refresh(s: QuestionSession): Promise<void> {
    const read = (this.reading.get(s.id) ?? Promise.resolve()).then(() => this.read(s));
    this.reading.set(s.id, read);
    try {
      await read;
    } finally {
      if (this.reading.get(s.id) === read) this.reading.delete(s.id);
    }
  }

  private async read(s: QuestionSession): Promise<void> {
    const path =
      s.agentProvider === "codex" && s.providerSessionId ? this.locator.pathFor(s) : null;
    if (!path) {
      this.entries.delete(s.id);
      return;
    }
    const identity = `${s.providerSessionId}:${s.herdrAgentId}`;
    let file;
    try {
      file = await open(path, "r");
      const stat = await file.stat();
      let entry = this.entries.get(s.id);
      if (
        !entry ||
        entry.identity !== identity ||
        entry.path !== path ||
        entry.inode !== stat.ino ||
        stat.size < entry.offset ||
        (stat.size === entry.offset && stat.mtimeMs !== entry.mtime)
      ) {
        entry = {
          identity,
          path,
          inode: stat.ino,
          offset: 0,
          mtime: stat.mtimeMs,
          tail: "",
          decoder: new StringDecoder("utf8"),
          state: new CodexQuestionState(),
          visible: [],
        };
        this.entries.delete(s.id); // never publish half a replay
      }
      const buffer = Buffer.alloc(64 * 1024);
      while (entry.offset < stat.size) {
        const { bytesRead } = await file.read(
          buffer,
          0,
          Math.min(buffer.length, stat.size - entry.offset),
          entry.offset,
        );
        if (!bytesRead) throw new Error("rollout changed during read");
        entry.offset += bytesRead;
        const lines = (entry.tail + entry.decoder.write(buffer.subarray(0, bytesRead))).split("\n");
        entry.tail = lines.pop()!;
        for (const line of lines) if (line.trim()) entry.state.ingest(JSON.parse(line));
      }
      entry.mtime = stat.mtimeMs;
      const pending = entry.state.candidates();
      entry.visible = entry.visible.flatMap((old) => {
        const current = pending.find((r) => r.toolUseId === old.toolUseId);
        if (!current) return [];
        const positions = current.indices
          .map((n, i) => (old.indices.includes(n) ? i : -1))
          .filter((i) => i >= 0);
        return positions.length
          ? [
              {
                ...current,
                indices: positions.map((i) => current.indices[i]!),
                nativeIds: positions.map((i) => current.nativeIds[i]!),
                questions: positions.map((i) => current.questions[i]!),
              },
            ]
          : [];
      });
      this.entries.set(s.id, entry);
    } catch {
      this.entries.delete(s.id); // unreadable/invalid evidence must never authorize an answer
    } finally {
      await file?.close();
    }
  }

  observe(s: QuestionSession, visible: string): PendingAsk[] {
    const entry = this.entry(s);
    if (!entry) {
      this.entries.delete(s.id);
      return [];
    }
    entry.visible = entry.state.visible(visible);
    return entry.visible.map(publicCodexAsk);
  }

  pending(id: string): PendingAsk[] {
    return (this.entries.get(id)?.visible ?? []).map(publicCodexAsk);
  }

  get(s: QuestionSession, requestId: string): CodexAsk | null {
    return this.entry(s)?.visible.find((r) => r.toolUseId === requestId) ?? null;
  }

  answer(s: QuestionSession, requestId: string, index: number): string[] | null {
    return this.entry(s)?.state.answer(requestId, index) ?? null;
  }

  private entry(s: QuestionSession): Entry | null {
    const e = this.entries.get(s.id);
    return e?.identity === `${s.providerSessionId}:${s.herdrAgentId}` ? e : null;
  }

  prune(activeIds: Set<string>): void {
    for (const id of this.entries.keys()) if (!activeIds.has(id)) this.entries.delete(id);
  }
}
