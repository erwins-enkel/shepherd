import { test, expect } from "bun:test";
import { isFullAuto } from "../src/full-auto";

// session with autopilot+autoMerge both on (per-session overrides)
const fullAutoSession = {
  autopilotEnabled: true as boolean | null,
  autoMergeEnabled: true as boolean | null,
  baseBranch: "main",
};
// cfg with both enabled and draftMode OFF (standard full-auto repo)
const fullAutoCfg = { autopilotEnabled: true, autoMergeEnabled: true, draftMode: false };

test("isFullAuto: both on, draftMode off → true", () => {
  expect(isFullAuto(fullAutoSession, fullAutoCfg)).toBe(true);
});

test("isFullAuto: draftMode on → false even when session overrides autoMergeEnabled true", () => {
  const draftCfg = { ...fullAutoCfg, draftMode: true };
  expect(isFullAuto(fullAutoSession, draftCfg)).toBe(false);
});

test("isFullAuto: draftMode on → false even when repo autoMergeEnabled true and session inherits (null)", () => {
  const sessionInherits = {
    autopilotEnabled: true as boolean | null,
    autoMergeEnabled: null as boolean | null,
    baseBranch: "main",
  };
  const draftCfg = { autopilotEnabled: true, autoMergeEnabled: true, draftMode: true };
  expect(isFullAuto(sessionInherits, draftCfg)).toBe(false);
});

test("isFullAuto: draftMode off, session autoMerge null → inherits repo default (true)", () => {
  const sessionInherits = {
    autopilotEnabled: true as boolean | null,
    autoMergeEnabled: null as boolean | null,
    baseBranch: "main",
  };
  expect(isFullAuto(sessionInherits, fullAutoCfg)).toBe(true);
});

test("isFullAuto: draftMode off, session autoMerge off → false (unchanged behavior)", () => {
  const session = {
    autopilotEnabled: true as boolean | null,
    autoMergeEnabled: false as boolean | null,
    baseBranch: "main",
  };
  const cfg = { autopilotEnabled: true, autoMergeEnabled: false, draftMode: false };
  expect(isFullAuto(session, cfg)).toBe(false);
});

test("isFullAuto: draftMode off, autopilot off → false (unchanged behavior)", () => {
  const session = {
    autopilotEnabled: false as boolean | null,
    autoMergeEnabled: true as boolean | null,
    baseBranch: "main",
  };
  expect(isFullAuto(session, fullAutoCfg)).toBe(false);
});

test("isFullAuto: epic-child base (epic/9-x) → false even when autopilot + auto-merge both on", () => {
  const epicChild = {
    autopilotEnabled: true as boolean | null,
    autoMergeEnabled: true as boolean | null,
    baseBranch: "epic/9-x",
  };
  // Epic children are squash-merged into their integration branch by the drain's retire
  // path — never carried by the merge train, so isFullAuto must read false.
  expect(isFullAuto(epicChild, fullAutoCfg)).toBe(false);
});

test("isFullAuto: bare epic base (epic/9) → false too", () => {
  const epicChild = {
    autopilotEnabled: true as boolean | null,
    autoMergeEnabled: true as boolean | null,
    baseBranch: "epic/9",
  };
  expect(isFullAuto(epicChild, fullAutoCfg)).toBe(false);
});
