import type { ResolvedBase } from "../../src/worktree";
export const stubBaseRef = (over: Partial<ResolvedBase> = {}): ResolvedBase => ({
  baseRef: "main",
  behind: 0,
  ahead: 0,
  diverged: false,
  hasUpstream: false,
  localExists: true,
  localFf: "none",
  ...over,
});
