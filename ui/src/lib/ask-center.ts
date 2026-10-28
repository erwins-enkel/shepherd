import type { PendingAsk, Session } from "./types";
import type { BlockState } from "./triage";

/** One open AskUserQuestion (#3165) and the session asking it. `since` is when the session
 *  blocked; absent when the caller only knows the ask (the Viewport's own prop). */
export interface AskEntry {
  session: Session;
  ask: PendingAsk;
  since?: number;
}

export interface AskRepoGroup {
  repoPath: string;
  entries: AskEntry[];
}

/** Every session with an open question, oldest question first. Mirrored sessions (#2762) are
 *  read-only references and assistants answer in their own chat, so neither is listed. */
export function pendingAskEntries(
  sessions: Session[],
  blocks: Record<string, BlockState>,
): AskEntry[] {
  return sessions
    .flatMap((session) => {
      const block = blocks[session.id];
      if (!block || session.host || session.operatorAssistant || session.assistantRepo) return [];
      const asks = block.reason.asks ?? (block.reason.ask ? [block.reason.ask] : []);
      return asks.map((ask) => ({ session, ask, since: block.since }));
    })
    .sort((a, b) => a.since - b.since);
}

/** Entries grouped by repo in first-seen order, `focusRepo`'s group first. */
export function groupAsksByRepo(entries: AskEntry[], focusRepo?: string): AskRepoGroup[] {
  const groups = new Map<string, AskEntry[]>();
  if (focusRepo && entries.some((e) => e.session.repoPath === focusRepo)) groups.set(focusRepo, []);
  for (const e of entries) {
    const list = groups.get(e.session.repoPath) ?? [];
    list.push(e);
    groups.set(e.session.repoPath, list);
  }
  return [...groups].map(([repoPath, list]) => ({ repoPath, entries: list }));
}

export const askEntryKey = (entry: AskEntry): string =>
  JSON.stringify([entry.session.id, entry.ask.toolUseId]);
