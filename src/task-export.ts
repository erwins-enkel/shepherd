/**
 * Whole-session export bundle, keyed on the Task-ID (issue #1268).
 *
 * One payload carrying everything Shepherd knows about a task — metadata + usage, the full
 * transcript (raw JSONL **and** parsed), and the diff — so a finished session can be analysed
 * externally or re-ingested into another CLI/model without reaching into the DB or the disk.
 *
 * This module only *aggregates*: usage comes from the caller (the server owns that DTO ladder),
 * the diff from `computeDiff`, the parsed activity from `parseActivity`. It invents no new
 * resolution logic — every gap is reported as an explicit marker rather than an empty field, so a
 * consumer can always tell "nothing happened" apart from "Shepherd could not tell you".
 */
import { stat } from "node:fs/promises";

import { parseActivity, type ActivityEntry } from "./activity";
import { computeDiff, toSessionDiff } from "./diff";
import { resolveDiffBase } from "./diff-base";
import type { GitForge } from "./forge/types";
import type { PrCache } from "./pr-poller";
import type { SessionUsageDto } from "./server";
import type { AgentProvider, DiffResult, Session } from "./types";
import { jsonlPathFor } from "./usage";

/** Byte budget for the transcript inlined into the bundle. Transcripts are usually well under this
 *  (p90 ≈ 0.5 MB) but the tail is long — a 32 MB one would serialize to ~65 MB of escaped JSON. Past
 *  the cap the bundle carries a valid JSONL *prefix* plus `truncated`, and the untruncated bytes stay
 *  reachable through the sibling transcript route. */
export const RAW_CAP_BYTES = 8 * 1024 * 1024;

/** Why a transcript isn't in the bundle.
 *  - `codex-pending-1267` — non-Claude provider; native transcript resolution lands with #1267.
 *  - `no-transcript-id`   — session predates the pinned agent session id (nothing to resolve).
 *  - `file-missing`       — resolved a path, but the JSONL is gone from disk. */
export type TranscriptUnavailable = "codex-pending-1267" | "no-transcript-id" | "file-missing";

export interface TaskExportTranscript {
  format: "jsonl";
  /** Absolute path the transcript was read from; null when it could not be resolved. */
  path: string | null;
  /** Raw JSONL, capped at `RAW_CAP_BYTES` (always cut on a line boundary, so it stays parseable). */
  raw: string | null;
  /** FULL size on disk, not the length of `raw` — the number that tells you whether to stream. */
  rawBytes: number;
  truncated: boolean;
  unavailable: TranscriptUnavailable | null;
  /** The COMPLETE parsed activity (not the 30-entry tail the live /activity read serves), derived
   *  from the whole file even when `raw` is capped. */
  entries: ActivityEntry[];
}

export interface TaskExportMeta {
  desig: string;
  id: string;
  name: string;
  prompt: string;
  /** Never absent here (unlike the row, where a legacy null means claude). */
  agentProvider: AgentProvider;
  /** Provider-native session id: the Claude session id, or the Codex rollout id once known. */
  agentSessionId: string | null;
  model: string | null;
  effort: string | null;
  status: string;
  lastState: string;
  repoPath: string;
  branch: string | null;
  baseBranch: string;
  worktreePath: string;
  isolated: boolean;
  issueNumber: number | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  archiveReason: string | null;
  usage: SessionUsageDto;
}

export interface TaskExportBundle {
  meta: TaskExportMeta;
  transcript: TaskExportTranscript;
  diff: DiffResult | null;
  /** `"no-branch" | "worktree-removed"`, or the underlying error message; null when `diff` is set. */
  diffUnavailable: string | null;
}

export interface TaskExportDeps {
  /** Resolved by the caller — the server owns the snapshot/live/unavailable ladder. */
  usage: SessionUsageDto;
  prCache?: Pick<PrCache, "get">;
  resolveForge?: (repoDir: string) => GitForge | null;
}

/** Where a session's transcript lives, or why it can't be known. `spawnAccountDir` is passed on
 *  purpose: a swap/pool session writes its JSONL under `<account>/projects`, so omitting it
 *  resolves a nonexistent path and yields a silently empty transcript. */
export function resolveTranscript(s: Session): {
  path: string | null;
  unavailable: TranscriptUnavailable | null;
} {
  if ((s.agentProvider ?? "claude") !== "claude")
    return { path: null, unavailable: "codex-pending-1267" };
  if (!s.claudeSessionId) return { path: null, unavailable: "no-transcript-id" };
  return {
    path: jsonlPathFor(s.worktreePath, s.claudeSessionId, s.spawnAccountDir),
    unavailable: null,
  };
}

/** Cap `text` to a byte budget, cutting back to the last complete line so the result is still
 *  valid JSONL rather than a half record. A single record larger than the cap yields "" (there is
 *  no complete line to keep) — `truncated` still says so, and `rawBytes` says how much is out there. */
export function capRaw(
  text: string,
  cap = RAW_CAP_BYTES,
): { raw: string; truncated: boolean; rawBytes: number } {
  const rawBytes = Buffer.byteLength(text, "utf8");
  if (rawBytes <= cap) return { raw: text, truncated: false, rawBytes };
  // Byte-slice (the budget is bytes, not UTF-16 units); a multi-byte char split at the boundary
  // decodes to a replacement char that the line-boundary cut below discards anyway.
  const prefix = Buffer.from(text, "utf8").subarray(0, cap).toString("utf8");
  const nl = prefix.lastIndexOf("\n");
  return { raw: nl === -1 ? "" : prefix.slice(0, nl + 1), truncated: true, rawBytes };
}

async function isDir(path: string): Promise<boolean> {
  return stat(path)
    .then((st) => st.isDirectory())
    .catch(() => false);
}

async function readTranscript(s: Session): Promise<TaskExportTranscript> {
  const empty = (
    path: string | null,
    unavailable: TranscriptUnavailable | null,
  ): TaskExportTranscript => ({
    format: "jsonl",
    path,
    raw: null,
    rawBytes: 0,
    truncated: false,
    unavailable,
    entries: [],
  });
  const { path, unavailable } = resolveTranscript(s);
  if (!path) return empty(null, unavailable);

  const file = Bun.file(path);
  if (!(await file.exists())) return empty(path, "file-missing");
  const text = await file.text();
  return {
    format: "jsonl",
    path,
    ...capRaw(text),
    unavailable: null,
    entries: parseActivity(text, -1), // -1 = every entry, not the live view's tail
  };
}

async function readDiff(
  s: Session,
  deps: TaskExportDeps,
): Promise<Pick<TaskExportBundle, "diff" | "diffUnavailable">> {
  if (!s.branch) return { diff: null, diffUnavailable: "no-branch" };
  // Probed on disk rather than inferred from `status === "archived"`: a non-isolated session runs in
  // the live checkout and still has a usable diff after archive, while an isolated one does not.
  if (!(await isDir(s.worktreePath))) return { diff: null, diffUnavailable: "worktree-removed" };
  try {
    // Same base the /diff tab uses: the PR's actual target when known, else the stored baseBranch.
    const { base } = await resolveDiffBase(s, deps.prCache, deps.resolveForge);
    return {
      diff: toSessionDiff(await computeDiff(s.worktreePath, base, s.branch)),
      diffUnavailable: null,
    };
  } catch (e) {
    return { diff: null, diffUnavailable: e instanceof Error ? e.message : "diff failed" };
  }
}

function metaOf(s: Session, usage: SessionUsageDto): TaskExportMeta {
  const provider = s.agentProvider ?? "claude";
  return {
    desig: s.desig,
    id: s.id,
    name: s.name,
    prompt: s.prompt,
    agentProvider: provider,
    agentSessionId: (provider === "claude" ? s.claudeSessionId : s.providerSessionId) || null,
    model: s.model,
    effort: s.effort,
    status: s.status,
    lastState: s.lastState,
    repoPath: s.repoPath,
    branch: s.branch,
    baseBranch: s.baseBranch,
    worktreePath: s.worktreePath,
    isolated: s.isolated,
    issueNumber: s.issueNumber,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    archivedAt: s.archivedAt,
    archiveReason: s.archiveReason ?? null,
    usage,
  };
}

/** Assemble the whole bundle. Transcript and diff are read concurrently — the transcript can be
 *  tens of MB and the diff shells out to git; neither needs the other. */
export async function buildTaskExport(s: Session, deps: TaskExportDeps): Promise<TaskExportBundle> {
  const [transcript, diff] = await Promise.all([readTranscript(s), readDiff(s, deps)]);
  return { meta: metaOf(s, deps.usage), transcript, ...diff };
}
