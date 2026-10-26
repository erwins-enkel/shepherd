import type { AgentProvider, Issue, SandboxProfile } from "#lib/types.js";

/** How long a dismissed New Task draft stays restorable. */
export const DRAFT_TTL_MS = 120_000;

/** Everything the operator set up in the composer — enough to reopen it as they left it. */
export type NewTaskDraft = {
  prompt: string;
  repoPath: string;
  baseBranch: string;
  issueRef: Issue | null;
  attachedRepoPath: string | null;
  images: { path: string; name: string; previewFile?: File }[];
  agentProvider: AgentProvider;
  model: string;
  modelTouched: boolean;
  effort: string;
  effortTouched: boolean;
  /** Plan-gated execution effort (#3434); optional so older drafts/fixtures stay valid. */
  executionEffort?: string;
  executionEffortTouched?: boolean;
  planGate: boolean;
  planGateTouched: boolean;
  autopilot: boolean;
  autopilotTouched: boolean;
  research: boolean;
  epicAuthoring: boolean;
  plain: boolean;
  /** Bootstrap mode (#3109); optional so older drafts/fixtures stay valid. */
  bootstrap?: boolean;
  modeTouched: boolean;
  designPreselected: boolean;
  sandboxProfile: "default" | SandboxProfile;
};

// Module memory, not storage: a draft survives the composer unmounting, never a reload.
let stashed: { draft: NewTaskDraft; at: number } | null = null;

/** Keep a dismissed composer's contents for the grace window. A draft with no prompt text
 *  and no attachments has nothing worth restoring and is ignored. */
export function stashDraft(draft: NewTaskDraft, now = Date.now()): void {
  if (!draft.prompt.trim() && draft.images.length === 0) return;
  stashed = { draft, at: now };
}

/** Hand back the stashed draft once, if it is still inside the grace window. */
export function takeDraft(now = Date.now()): NewTaskDraft | null {
  const entry = stashed;
  stashed = null;
  return entry && now - entry.at <= DRAFT_TTL_MS ? entry.draft : null;
}
