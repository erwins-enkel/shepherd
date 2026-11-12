// Sub-agent task names for the fan-out roster.
//
// The SubagentStart/Stop hooks carry only `agent_id` + `agent_type`. Claude Code also writes a
// per-agent sidecar next to the parent transcript —
// `<transcript minus .jsonl>/subagents/agent-<agentId>.meta.json` — whose `description` is the
// Agent call's short task name. The file is undocumented, so every failure is a quiet
// `undefined` and the roster keeps its type-only row.

import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** A Claude Code agent id: the roster key from an untrusted hook body, so it must never path. */
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** The sidecar is ~300 bytes; anything far larger is not the file we expect. */
const META_MAX_BYTES = 8 * 1024;
/** Display cap for the task name. */
export const DESCRIPTION_MAX = 120;

/** Control/format chars stripped, whitespace trimmed, capped; empty ⇒ undefined. */
function cleanDescription(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const clean = v.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim();
  if (!clean) return undefined;
  return clean.length > DESCRIPTION_MAX ? `${clean.slice(0, DESCRIPTION_MAX)}…` : clean;
}

/** The sidecar path for `agentId` under the parent transcript, or null for an unusable input. */
export function subagentMetaPath(transcriptPath: string, agentId: string): string | null {
  if (!AGENT_ID.test(agentId) || !transcriptPath.endsWith(".jsonl")) return null;
  return `${transcriptPath.slice(0, -".jsonl".length)}/subagents/agent-${agentId}.meta.json`;
}

/** The sub-agent's task name from its meta sidecar, or undefined. Async, bounded, never throws. */
export async function readSubagentDescription(
  transcriptPath: string,
  agentId: string,
): Promise<string | undefined> {
  const path = subagentMetaPath(transcriptPath, agentId);
  if (!path) return undefined;
  // One handle for the size check and the read, so the file checked is the file read; O_NONBLOCK so
  // a FIFO planted at the path can't park the open.
  const fh = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => null);
  if (!fh) return undefined;
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > META_MAX_BYTES) return undefined;
    const parsed: unknown = JSON.parse(await fh.readFile("utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return cleanDescription((parsed as Record<string, unknown>).description);
  } catch {
    return undefined;
  } finally {
    await fh.close().catch(() => {});
  }
}
