// Host-wide start queue — the pure core. While the heavy-slot pressure brake is engaged, new agent
// sessions (New Task, Up Next, released held tasks, the auto-drain) wait here instead of starting
// into the same memory storm; once it lets go they start FIFO, one at a time. No I/O, no timers:
// HeavySlotService (src/heavy-slot.ts) owns the brake and drives this core.

/** After a start that had waited, the next one waits this long — the new agent's memory has to
 *  show up in a fresh sample before another start is let through. */
export const START_PACE_MS = 30_000;
/** A waiter nobody asked about for this long is gone (its task discarded, its drain switched off)
 *  and must not hold the head of the queue. */
export const START_STALE_MS = 120_000;

export interface StartEntry {
  /** `task:<heldTaskId>` or `drain:<repoPath>`. */
  key: string;
  kind: "task" | "drain";
  repoPath: string;
  issueNumber: number | null;
  /** What starts, as data (an issue title or the prompt's first line); null when unknown. */
  label: string | null;
}

export interface StartWaiter extends StartEntry {
  /** When it began waiting; the queue order. */
  since: number;
  /** When a caller last asked for it; drives {@link StartQueue.prune}. */
  seenAt: number;
}

const LABEL_MAX_CHARS = 80;

/** The entry of a held (or about to be held) task: its issue's title, else its prompt's first line. */
export function taskStartEntry(
  id: string,
  input: { repoPath: string; prompt: string; issueRef?: { number: number; title: string } },
): StartEntry {
  const line = input.issueRef?.title || input.prompt.split("\n").find((l) => l.trim()) || "";
  const flat = line.replace(/\s+/g, " ").trim();
  return {
    key: `task:${id}`,
    kind: "task",
    repoPath: input.repoPath,
    issueNumber: input.issueRef?.number ?? null,
    label: flat
      ? flat.length > LABEL_MAX_CHARS
        ? `${flat.slice(0, LABEL_MAX_CHARS - 1)}…`
        : flat
      : null,
  };
}

export class StartQueue {
  // Insertion order breaks ties between waiters that share a `since`.
  #waiters = new Map<string, StartWaiter>();
  #paceUntil = 0;

  /**
   * May `entry` start now? Not while the brake is engaged, not during the pause after a start that
   * had waited, and not while an older waiter is ahead — then it waits (its place is kept on a
   * repeat ask). A start that had waited — or `queued`, one that waited somewhere this queue can't
   * see (a held task across a restart) — starts the pause for the next.
   */
  admit(entry: StartEntry, ctx: { now: number; brakeEngaged: boolean }, queued = false): boolean {
    const head = this.list()[0];
    if (ctx.brakeEngaged || ctx.now < this.#paceUntil || (head && head.key !== entry.key)) {
      const prev = this.#waiters.get(entry.key);
      this.#waiters.set(entry.key, { ...entry, since: prev?.since ?? ctx.now, seenAt: ctx.now });
      return false;
    }
    const waited = this.#waiters.delete(entry.key);
    if (waited || queued) this.#paceUntil = ctx.now + START_PACE_MS;
    return true;
  }

  forget(key: string): boolean {
    return this.#waiters.delete(key);
  }

  clear(): void {
    this.#waiters.clear();
  }

  prune(now: number): boolean {
    let dropped = false;
    for (const [key, w] of this.#waiters)
      if (w.seenAt < now - START_STALE_MS) dropped = this.#waiters.delete(key) || dropped;
    return dropped;
  }

  waiting(key: string): boolean {
    return this.#waiters.has(key);
  }

  /** Waiters in the order they start. */
  list(): StartWaiter[] {
    return [...this.#waiters.values()].toSorted((a, b) => a.since - b.since);
  }
}
