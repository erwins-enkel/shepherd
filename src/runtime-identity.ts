import { readFileSync } from "node:fs";
import { claudeRuntimeIdentity, type RuntimeIdentity } from "./activity-signal";
import { codexRuntimeIdentity, listRolloutMetas, selectCodexRollout } from "./codex-activity";
import type { RolloutMeta } from "./codex-activity";
import { jsonlPathFor } from "./usage";
import type { AgentProvider } from "./types";

/** One session considered for backfill — the identity fields needed to find its transcript. */
export interface RuntimeIdentityCandidate {
  id: string;
  agentProvider: AgentProvider;
  worktreePath: string;
  claudeSessionId: string | null;
  providerSessionId: string | null;
  spawnAccountDir: string | null;
}

/** What the backfill needs from the store (structural, so it's trivially injectable in tests). */
export interface RuntimeIdentityStore {
  listIncompleteRuntimeIdentity(limit?: number): RuntimeIdentityCandidate[];
  setRuntimeIdentity(
    id: string,
    identity: { runtimeModel?: string | null; runtimeEffort?: string | null },
  ): void;
}

export interface RuntimeIdentityDeps {
  /** The ONE shared `$CODEX_HOME` tree walk, reused across every Codex candidate. */
  listMetas: () => RolloutMeta[];
  /** Reads a transcript/rollout file; throws or returns null when it's gone. */
  readText: (path: string) => string | null;
}

function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Resolve a Codex row's rollout by its NATIVE session id and read the identity out of it.
 *
 * Resolving by id sidesteps the cwd ambiguity that makes `CodexTranscriptLocator.pathFor()` refuse
 * non-isolated sessions (#1175): a native id names exactly one conversation, so there is nothing to
 * mis-attribute. A row with no id recorded stays unresolved. */
function codexIdentity(
  row: RuntimeIdentityCandidate,
  metas: RolloutMeta[],
  readText: RuntimeIdentityDeps["readText"],
): RuntimeIdentity {
  if (!row.providerSessionId) return {};
  const hit = selectCodexRollout(metas, {
    worktreePath: row.worktreePath,
    source: "cli",
    providerSessionId: row.providerSessionId,
  });
  if (!hit) return {};
  const text = readText(hit.path);
  return text === null ? {} : codexRuntimeIdentity(text);
}

/** Read a Claude row's transcript. Model only — Claude transcripts record no reasoning effort, so
 *  `runtimeEffort` stays null for these rows and the UI keeps showing the configured value. */
function claudeIdentity(
  row: RuntimeIdentityCandidate,
  readText: RuntimeIdentityDeps["readText"],
): RuntimeIdentity {
  if (!row.claudeSessionId) return {};
  const text = readText(jsonlPathFor(row.worktreePath, row.claudeSessionId, row.spawnAccountDir));
  return text === null ? {} : claudeRuntimeIdentity(text);
}

/**
 * Fill in the OBSERVED runtime identity for sessions that never got one persisted (#1823) — rows
 * that concluded before this feature existed, and rows whose live write only caught one of the two
 * fields.
 *
 * Boot-only and bounded, mirroring `backfillCodexSpawnUsage`: ONE `listMetas` tree walk is shared
 * across every Codex candidate (never one per row), the store caps how many rows are considered,
 * and it never throws — a backfill failure must not block startup.
 *
 * Writes go through the store's PARTIAL setter, so filling in a missing effort can never clear an
 * already-known model. Rows whose transcript/rollout is gone stay NULL, which remains the honest
 * answer and leaves them eligible should the file reappear.
 *
 * Returns the number of rows written.
 */
export function backfillRuntimeIdentity(
  store: RuntimeIdentityStore,
  deps: RuntimeIdentityDeps = { listMetas: () => listRolloutMetas(), readText: readTextOrNull },
): number {
  let rows: RuntimeIdentityCandidate[];
  try {
    rows = store.listIncompleteRuntimeIdentity();
  } catch {
    return 0;
  }
  if (rows.length === 0) return 0;

  // The shared walk is Codex-only work — skip it entirely when no Codex row is a candidate.
  let metas: RolloutMeta[] = [];
  if (rows.some((r) => r.agentProvider === "codex")) {
    try {
      metas = deps.listMetas();
    } catch {
      metas = [];
    }
  }

  let filled = 0;
  for (const row of rows) {
    try {
      const identity =
        row.agentProvider === "codex"
          ? codexIdentity(row, metas, deps.readText)
          : claudeIdentity(row, deps.readText);
      if (!identity.runtimeModel && !identity.runtimeEffort) continue;
      store.setRuntimeIdentity(row.id, identity);
      filled += 1;
    } catch {
      /* one bad row must not abort the sweep */
    }
  }
  if (filled > 0)
    console.log(`[runtime-identity] backfilled runtime identity for ${filled} row(s)`);
  return filled;
}
