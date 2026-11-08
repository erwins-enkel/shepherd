import type { RepoConfig } from "#lib/types.js";

// How a repo's finished PRs land (#3444) — one choice over the two fields that encode it, so
// draft mode and full-auto merge are never both on. The repo settings' Merge section shows it;
// the autonomy levels (#3445) set and read it.

export const MERGE_MODES = ["manual", "draft", "auto"] as const;
/** You merge · draft until sign-off · the merge train lands it (full-auto merge). */
export type MergeMode = (typeof MERGE_MODES)[number];

type MergeFields = Pick<RepoConfig, "draftMode" | "autoMergeEnabled">;

/** The merge mode a repo config holds. Draft wins over an auto-merge beside it, as on the server
 *  (src/full-auto.ts → isFullAuto), which never lands a draft repo's PRs. */
export function mergeModeOf(cfg: MergeFields): MergeMode {
  if (cfg.draftMode) return "draft";
  return cfg.autoMergeEnabled ? "auto" : "manual";
}

/** The patch that sets a merge mode: always both fields, so one write switches cleanly. */
export function mergeModePatch(mode: MergeMode): MergeFields {
  return { draftMode: mode === "draft", autoMergeEnabled: mode === "auto" };
}
