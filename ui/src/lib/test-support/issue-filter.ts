import { issueFilterSettings } from "#lib/issue-filter-settings.svelte.js";
import { DEFAULT_ISSUE_FILTER } from "#lib/issue-filter-migration.js";
import type { IssueFilterSettings } from "#lib/types.js";

// Browser-test seam for the server-side default issue filter (#3019): seed it as if the server
// had pushed `patch` (a settings:issue-filter event), without a network round trip.
export function pushIssueFilter(patch: Partial<IssueFilterSettings> = {}) {
  issueFilterSettings.apply({ ...issueFilterSettings.effective, ...patch });
}

/** Back to the loaded server defaults. */
export function resetIssueFilter() {
  issueFilterSettings.apply(structuredClone(DEFAULT_ISSUE_FILTER));
}

/** The hide toggles by their pre-#3019 names, so list tests read as before. */
export const issuesFilter = {
  get hideOthers() {
    return issueFilterSettings.effective.scope !== "all";
  },
  get hideActive() {
    return issueFilterSettings.effective.hideActive;
  },
  get hideSubIssues() {
    return issueFilterSettings.effective.hideSubIssues;
  },
  get hideBlocked() {
    return issueFilterSettings.effective.hideBlocked;
  },
  set: (v: boolean) => pushIssueFilter({ scope: v ? "mine_unassigned" : "all" }),
  setActive: (v: boolean) => pushIssueFilter({ hideActive: v }),
  setSubIssues: (v: boolean) => pushIssueFilter({ hideSubIssues: v }),
  setBlocked: (v: boolean) => pushIssueFilter({ hideBlocked: v }),
};
