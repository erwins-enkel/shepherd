import { test, expect } from "bun:test";
import { isFullAuto } from "../src/full-auto";

// session with autopilot+autoMerge both on (per-session overrides)
const fullAutoSession = {
  autopilotEnabled: true as boolean | null,
  autoMergeEnabled: true as boolean | null,
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
  };
  const draftCfg = { autopilotEnabled: true, autoMergeEnabled: true, draftMode: true };
  expect(isFullAuto(sessionInherits, draftCfg)).toBe(false);
});

test("isFullAuto: draftMode off, session autoMerge null → inherits repo default (true)", () => {
  const sessionInherits = {
    autopilotEnabled: true as boolean | null,
    autoMergeEnabled: null as boolean | null,
  };
  expect(isFullAuto(sessionInherits, fullAutoCfg)).toBe(true);
});

test("isFullAuto: draftMode off, session autoMerge off → false (unchanged behavior)", () => {
  const session = {
    autopilotEnabled: true as boolean | null,
    autoMergeEnabled: false as boolean | null,
  };
  const cfg = { autopilotEnabled: true, autoMergeEnabled: false, draftMode: false };
  expect(isFullAuto(session, cfg)).toBe(false);
});

test("isFullAuto: draftMode off, autopilot off → false (unchanged behavior)", () => {
  const session = {
    autopilotEnabled: false as boolean | null,
    autoMergeEnabled: true as boolean | null,
  };
  expect(isFullAuto(session, fullAutoCfg)).toBe(false);
});
