// Command-bar row model + group arrangement (#3052). Pure, so the ordering rules — pinned rows
// first, the empty-query Needs-you group, rank-ordered groups for a typed query — are unit-tested
// without mounting CommandBar.svelte.

import type { HerdFilter } from "#lib/components/herd-partition.js";

// Row unions the navigation and action targets. `rank` is comparable across every kind for a
// typed query.
export type Row =
  | {
      kind: "session";
      id: string;
      title: string;
      designation: string;
      repoPath: string;
      repoName: string | null;
      status: string;
      hl: number[];
      designationHl: number[];
      repoHl: number[];
      promptMatch: boolean;
      rank: number;
    }
  | {
      kind: "repo";
      // `path` is the raw entry path (backlog is keyed on it); `realPath` is the
      // realpath'd form that session.repoPath / the herd repoFilter use — they differ
      // for a symlinked repo root, so the filter action keys on realPath, backlog on path.
      path: string;
      realPath: string;
      name: string;
      display: string;
      hl: number[];
      displayHl: number[];
      hasLiveSession: boolean;
      rank: number;
    }
  | { kind: "lens"; lens: HerdFilter; label: string; icon: string; hl: number[]; rank: number }
  | {
      kind: "command";
      id: string;
      label: string;
      run: () => void;
      // Both are non-null only for a destructive (two-step) verb: `confirmLabel` is the armed
      // row's visible text, `confirmAria` the sentence the live region speaks (it names the
      // target, which the short visible label drops). The bar has no session context of its
      // own, so both ride along on the row.
      confirmLabel: (() => string) | null;
      confirmAria: (() => string) | null;
      /** The verb's global chord label (⌘J / Ctrl+J), or null when it has none. */
      shortcut: string | null;
      hl: number[];
      rank: number;
    }
  | { kind: "doc"; title: string; url: string; hl: number[]; rank: number };

/** The row's identity across re-derives — the `{#each}` key and the pin key. */
export function stableKey(row: Row): string {
  switch (row.kind) {
    case "session":
      return "s:" + row.id;
    case "repo":
      return "r:" + row.path;
    case "lens":
      return "l:" + row.lens;
    case "command":
      return "c:" + row.id;
    case "doc":
      return "d:" + row.url;
  }
}

/** The row's visible primary text — what a pin/unpin announcement names. */
export function rowLabel(row: Row): string {
  switch (row.kind) {
    case "session":
    case "doc":
      return row.title;
    case "repo":
      return row.name;
    case "lens":
    case "command":
      return row.label;
  }
}

export type Group = { key: string; label: string; rows: Row[] };

export type GroupLabels = {
  pinned: string;
  needsYou: (count: number) => string;
  sessions: string;
  repos: string;
  lenses: string;
  commands: string;
  docs: string;
};

export type ArrangeInput = {
  /** The trimmed, lower-cased query. */
  q: string;
  /** Pin keys in pin order. */
  pins: readonly string[];
  /** Rows that match `q`, each list already relevance/recency ordered. For an empty query the
   *  command and doc lists hold every available verb/page; only pinned ones are shown. */
  rows: { sessions: Row[]; repos: Row[]; lenses: Row[]; commands: Row[]; docs: Row[] };
  needsInputIds: ReadonlySet<string>;
  labels: GroupLabels;
};

function bestRank(rows: Row[]): number {
  return rows.reduce((max, row) => Math.max(max, row.rank), Number.NEGATIVE_INFINITY);
}

/** Final group order. `Pinned` (pin order, matching rows only) always leads and its rows appear
 *  nowhere else. Empty query: Pinned → Needs you · N → Sessions → Repositories → Lenses, with
 *  commands/docs reachable only through a pin. Typed query: the other groups follow, ordered by
 *  their strongest row. Empty groups are dropped. */
export function arrangeGroups({ q, pins, rows, needsInputIds, labels }: ArrangeInput): Group[] {
  const all = [...rows.sessions, ...rows.repos, ...rows.lenses, ...rows.commands, ...rows.docs];
  const byKey = new Map(all.map((row) => [stableKey(row), row] as const));
  const pinned = pins.map((k) => byKey.get(k)).filter((row) => row !== undefined);
  const pinnedKeys = new Set(pins);
  const rest = (list: Row[]) => list.filter((row) => !pinnedKeys.has(stableKey(row)));

  const head: Group = { key: "pinned", label: labels.pinned, rows: pinned };
  let tail: Group[];
  if (q === "") {
    const sessions = rest(rows.sessions);
    const waiting = sessions.filter((r) => r.kind === "session" && needsInputIds.has(r.id));
    tail = [
      { key: "needs-you", label: labels.needsYou(waiting.length), rows: waiting },
      {
        key: "sessions",
        label: labels.sessions,
        rows: sessions.filter((r) => !waiting.includes(r)),
      },
      { key: "repos", label: labels.repos, rows: rest(rows.repos) },
      { key: "lenses", label: labels.lenses, rows: rest(rows.lenses) },
    ];
  } else {
    tail = [
      { key: "sessions", label: labels.sessions, rows: rest(rows.sessions) },
      { key: "repos", label: labels.repos, rows: rest(rows.repos) },
      { key: "lenses", label: labels.lenses, rows: rest(rows.lenses) },
      { key: "commands", label: labels.commands, rows: rest(rows.commands) },
      { key: "docs", label: labels.docs, rows: rest(rows.docs) },
    ]
      .map((g, order) => ({ g, order, rank: bestRank(g.rows) }))
      .sort((a, b) => b.rank - a.rank || a.order - b.order)
      .map(({ g }) => g);
  }
  return [head, ...tail].filter((g) => g.rows.length > 0);
}

export type PinSources = {
  /** Local session ids, or null while they aren't known to be loaded (keep every `s:` pin). */
  sessionIds: ReadonlySet<string> | null;
  /** Repo entry paths, or null while they aren't known to be loaded (keep every `r:` pin). */
  repoPaths: ReadonlySet<string> | null;
  commandIds: ReadonlySet<string>;
  docUrls: ReadonlySet<string>;
  lensIds: ReadonlySet<string>;
};

/** Whether a stored pin still has a target. An unavailable-but-known command stays pinned. */
export function pinKeep(key: string, src: PinSources): boolean {
  const id = key.slice(2);
  switch (key.slice(0, 2)) {
    case "s:":
      return src.sessionIds === null || src.sessionIds.has(id);
    case "r:":
      return src.repoPaths === null || src.repoPaths.has(id);
    case "c:":
      return src.commandIds.has(id);
    case "d:":
      return src.docUrls.has(id);
    case "l:":
      return src.lensIds.has(id);
    default:
      return false;
  }
}
