import { describe, expect, it } from "vitest";
import { buildAssistantViewReport, scopeViewReport } from "./operator-assistant-view";

const BASE: Parameters<typeof buildAssistantViewReport>[0] = {
  client: { kind: "browser", platform: "macos" },
  repoFilter: new Set(["/p/shepherd"]),
  mobile: false,
  assistantReturnScreen: "list",
  doneLens: false,
  selected: { id: "live-1" },
  doneSelected: null,
  selectedRemote: null,
  sessionTab: "diff",
};

describe("buildAssistantViewReport", () => {
  it("desktop: the selected session with its tab, the filter and the client", () => {
    expect(buildAssistantViewReport(BASE)).toEqual({
      v: 1,
      client: { kind: "browser", platform: "macos" },
      repoFilter: ["/p/shepherd"],
      focus: { kind: "session", id: "live-1", tab: "diff" },
    });
  });

  it("no filter and nothing selected say so", () => {
    const r = buildAssistantViewReport({ ...BASE, repoFilter: new Set(), selected: null });
    expect(r.repoFilter).toEqual([]);
    expect(r.focus).toEqual({ kind: "none" });
  });

  it("a mirrored session is reported by desig and machine", () => {
    const r = buildAssistantViewReport({
      ...BASE,
      selected: null,
      selectedRemote: {
        desig: "TASK-12",
        host: { instanceId: "i", name: "Kai's MacBook", platform: "macos" },
      },
    });
    expect(r.focus).toEqual({ kind: "remote", desig: "TASK-12", host: "Kai's MacBook" });
  });

  it("the Done lens reports its picked row without a tab, never the live selection", () => {
    expect(
      buildAssistantViewReport({ ...BASE, doneLens: true, doneSelected: { id: "done-1" } }).focus,
    ).toEqual({ kind: "session", id: "done-1", tab: null });
    expect(buildAssistantViewReport({ ...BASE, doneLens: true }).focus).toEqual({ kind: "none" });
  });

  it("phone: the session counts only when the assistant was opened from its detail", () => {
    const phone = { ...BASE, mobile: true, client: { kind: "pwa", platform: "ios" } as const };
    expect(buildAssistantViewReport({ ...phone, assistantReturnScreen: "detail" }).focus).toEqual({
      kind: "session",
      id: "live-1",
      tab: "diff",
    });
    expect(buildAssistantViewReport({ ...phone, assistantReturnScreen: "list" }).focus).toEqual({
      kind: "none",
    });
  });
});

describe("scopeViewReport", () => {
  const report = buildAssistantViewReport(BASE);
  const herd = [
    { id: "live-1", repoPath: "/p/shepherd" },
    { id: "live-2", repoPath: "/p/calendar" },
  ];

  it("hands the global assistant the report as it is", () => {
    expect(scopeViewReport(report, null, herd)).toBe(report);
  });

  it("a repo assistant sees its repo as the filter and its own session in view", () => {
    expect(scopeViewReport(report, "/p/shepherd", herd)).toEqual({
      ...report,
      repoFilter: ["/p/shepherd"],
    });
  });

  it("a session from another repo, or a mirrored one, is not in a repo assistant's view", () => {
    expect(scopeViewReport(report, "/p/calendar", herd).focus).toEqual({ kind: "none" });
    const remote = { ...report, focus: { kind: "remote" as const, desig: "TASK-1", host: "mac" } };
    expect(scopeViewReport(remote, "/p/shepherd", herd).focus).toEqual({ kind: "none" });
  });
});
