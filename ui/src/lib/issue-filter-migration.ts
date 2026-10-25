import type { IssueFilterSettings } from "./types";

// One-time move of the pre-#3007 localStorage issue toggles onto the server-side default issue
// filter (#3019). Each old key stored only its non-default value, so a present key IS a choice.
const LEGACY = {
  hideOthers: "shepherd:issues-hide-others",
  hideActive: "shepherd:issues-hide-active",
  hideSubIssues: "shepherd:issues-hide-subissues",
  hideBlocked: "shepherd:issues-hide-blocked",
} as const;

/** Mirror of src/issue-filter.ts DEFAULT_ISSUE_FILTER. */
export const DEFAULT_ISSUE_FILTER: IssueFilterSettings = {
  scope: "mine_unassigned",
  forks: "all",
  hiddenLabels: [],
  hideActive: false,
  hideSubIssues: true,
  hideBlocked: true,
};

export function isDefaultIssueFilter(f: IssueFilterSettings): boolean {
  const d = DEFAULT_ISSUE_FILTER;
  return (
    f.scope === d.scope &&
    f.forks === d.forks &&
    f.hiddenLabels.length === 0 &&
    f.hideActive === d.hideActive &&
    f.hideSubIssues === d.hideSubIssues &&
    f.hideBlocked === d.hideBlocked
  );
}

/** The non-default choices the old keys hold, as a server patch (empty = nothing to migrate). */
export function legacyPatch(storage: Storage): Partial<IssueFilterSettings> {
  const patch: Partial<IssueFilterSettings> = {};
  if (storage.getItem(LEGACY.hideOthers) === "0") patch.scope = "all";
  if (storage.getItem(LEGACY.hideActive) === "1") patch.hideActive = true;
  if (storage.getItem(LEGACY.hideSubIssues) === "0") patch.hideSubIssues = false;
  if (storage.getItem(LEGACY.hideBlocked) === "0") patch.hideBlocked = false;
  return patch;
}

export function clearLegacy(storage: Storage) {
  for (const key of Object.values(LEGACY)) storage.removeItem(key);
}

/** localStorage, or null where it is missing or throws (SSR, private mode). */
export function browserStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
