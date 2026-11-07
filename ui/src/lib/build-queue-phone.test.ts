import { describe, expect, it } from "vitest";
import { focusStep, panelVisible } from "./build-queue-phone";
import type { BuildStep, BuildStepStatus } from "./types";

const step = (id: string, status: BuildStepStatus, position = 0): BuildStep => ({
  id,
  title: id,
  status,
  position,
});

describe("focusStep", () => {
  it("prefers the active step", () => {
    expect(focusStep([step("a", "done"), step("b", "pending"), step("c", "active")])?.id).toBe("c");
  });
  it("falls back to the first pending step", () => {
    expect(focusStep([step("a", "skipped"), step("b", "pending"), step("c", "pending")])?.id).toBe(
      "b",
    );
  });
  it("returns null when everything is resolved or the queue is empty", () => {
    expect(focusStep([step("a", "done"), step("b", "skipped")])).toBeNull();
    expect(focusStep([])).toBeNull();
  });
});

describe("panelVisible", () => {
  const base = {
    phone: false,
    enabled: true,
    stepCount: 2,
    folded: false,
    actionable: false,
    acting: false,
  };
  it("matches the desktop fold rule", () => {
    expect(panelVisible(base)).toBe(true);
    expect(panelVisible({ ...base, folded: true })).toBe(false);
    expect(panelVisible({ ...base, folded: true, actionable: true })).toBe(true);
    expect(panelVisible({ ...base, folded: true, acting: true })).toBe(true);
  });
  it("hides a disabled empty queue everywhere", () => {
    for (const phone of [false, true])
      expect(panelVisible({ ...base, phone, enabled: false, stepCount: 0 })).toBe(false);
  });
  it("shows a disabled queue that still has steps", () => {
    expect(panelVisible({ ...base, enabled: false })).toBe(true);
  });
  it("keeps a phone queue with steps visible under folded details", () => {
    expect(panelVisible({ ...base, phone: true, folded: true })).toBe(true);
  });
  it("keeps the fold rule for an empty phone queue", () => {
    expect(panelVisible({ ...base, phone: true, stepCount: 0, folded: true })).toBe(false);
    expect(panelVisible({ ...base, phone: true, stepCount: 0 })).toBe(true);
  });
});
