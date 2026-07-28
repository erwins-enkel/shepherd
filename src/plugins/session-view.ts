// Projection from core's internal `Session` row (+ its cached forge `GitState`) onto the
// curated, versioned `PluginSessionSnapshot` handed to plugins through `ctx.sessions`.
//
// Kept as a PURE function in its own module for two reasons: it is the single place the
// curated surface is defined (so widening it is one deliberate edit, guarded by a test that
// asserts the withheld fields stay withheld), and it is unit-testable without standing up a
// registry, a store, or a plugin folder.
//
// This module — unlike `./types`, which is import-free by design — imports the real core
// types on purpose: a new `SessionStatus` or `AgentProvider` in core then fails to compile
// HERE, at the seam, instead of silently diverging from the contract plugins vendor.

import type { Session } from "../types";
import type { GitState } from "../forge/types";
import type { PluginSessionPr, PluginSessionSnapshot } from "./types";

/** Project the cached forge git state onto the plugin-facing PR view. `null` git state
 *  (never polled, or archived — `putSessionGitCache` refuses archived rows) reads as `null`,
 *  which a plugin must distinguish from a polled `state: "none"` (no PR yet). Optional
 *  fields are omitted rather than set to `undefined` so the snapshot round-trips through
 *  JSON unchanged (a plugin may persist it in `ctx.state`). */
function toPluginSessionPr(git: GitState | null): PluginSessionPr | null {
  if (!git) return null;
  const pr: PluginSessionPr = { state: git.state, checks: git.checks };
  if (git.number !== undefined) pr.number = git.number;
  if (git.url !== undefined) pr.url = git.url;
  if (git.title !== undefined) pr.title = git.title;
  if (git.isDraft !== undefined) pr.isDraft = git.isDraft;
  return pr;
}

/** Build the read-only snapshot for one session. Field-by-field on purpose — a spread of
 *  `session` would leak every future `Session` field into the plugin contract. */
export function toPluginSessionSnapshot(
  session: Session,
  git: GitState | null,
): PluginSessionSnapshot {
  return {
    id: session.id,
    desig: session.desig,
    name: session.name,
    repoPath: session.repoPath,
    baseBranch: session.baseBranch,
    branch: session.branch,
    status: session.status,
    model: session.model,
    // Optional on legacy rows spawned before the field existed; those are all Claude.
    agentProvider: session.agentProvider ?? "claude",
    issueNumber: session.issueNumber,
    haltReason: session.haltReason,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    archivedAt: session.archivedAt,
    pr: toPluginSessionPr(git),
  };
}
