import type { RepoConfigResponse } from "./api";

// Mirrors src/repo-config-file.ts. A test keeps the browser allowlist in sync without importing Git.
export const RULE_FIELDS = [
  "leitrechner",
  "criticEnabled",
  "criticAllPrs",
  "criticSmellLensEnabled",
  "autoAddressEnabled",
  "autopilotEnabled",
  "planGateEnabled",
  "autoDrainEnabled",
  "autoMergeEnabled",
  "buildQueueEnabled",
  "draftMode",
  "signoffAuthority",
  "manualStepsIssueEnabled",
  "preWarmEpicLandingCi",
  "epicStacksEnabled",
  "autoLabel",
  "defaultModel",
  "defaultEffort",
] as const;
export type RuleField = (typeof RULE_FIELDS)[number];
export const isRuleField = (field: string): field is RuleField =>
  RULE_FIELDS.some((k) => k === field);

/** Keep machine values from one response and committed rules/ownership metadata from another. */
export function mergeRepoRuleView(
  machine: RepoConfigResponse,
  rules: RepoConfigResponse,
): RepoConfigResponse {
  return {
    ...machine,
    ...Object.fromEntries(RULE_FIELDS.map((key) => [key, rules[key]])),
    repoConfigCommit: rules.repoConfigCommit,
    repoConfigBranch: rules.repoConfigBranch,
    leitrechnerStatus: rules.leitrechnerStatus,
    fieldSources: {
      ...machine.fieldSources,
      ...Object.fromEntries(RULE_FIELDS.map((key) => [key, rules.fieldSources?.[key]])),
    },
  };
}
