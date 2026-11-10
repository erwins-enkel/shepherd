import { describe, it, expect } from "vitest";
import type { DrainRunSummary, DrainStatus, Epic, EpicChild } from "#lib/types.js";
import { epicIssueUrl, epicMenuModel } from "./epic-menu";

const child = (number: number, url = ""): EpicChild => ({
  number,
  title: `child ${number}`,
  url,
  order: number,
  body: "",
  blockedBy: [],
  state: "ready",
  sessionId: null,
  prNumber: null,
  issueClosed: false,
  claimed: false,
});

const epic = (run: Partial<Epic["run"]> = {}, children: EpicChild[] = [child(11)]): Epic => ({
  repoPath: "/repo/a",
  parentIssueNumber: 10,
  parentTitle: "Epic 10",
  source: "native",
  children,
  warnings: [],
  run: { repoPath: "/repo/a", parentIssueNumber: 10, mode: "auto", status: "running", ...run },
});

const summary = (over: Partial<DrainRunSummary> = {}): DrainRunSummary => ({
  leadingEpic: 10,
  windingDown: [],
  slots: { used: 0, max: 1, holders: [] },
  next: [],
  after: [],
  ...over,
});

const drain = (over: Partial<DrainStatus> = {}): DrainStatus => ({
  repoPath: "/repo/a",
  enabled: true,
  paused: false,
  reason: null,
  detail: null,
  queued: 0,
  inFlight: 0,
  max: 1,
  epicParent: 10,
  runSummary: summary(),
  ...over,
});

describe("epicMenuModel", () => {
  it("running: pause and end, no start, no approve", () => {
    const model = epicMenuModel(epic(), drain());
    expect(model).toMatchObject({
      approve: false,
      pause: true,
      start: null,
      unqueue: false,
      end: { promotes: null },
      attended: false,
    });
  });

  it("offers approve only while an attended run waits for the operator", () => {
    const waiting = drain({ reason: "awaiting_approval" });
    expect(epicMenuModel(epic({ mode: "attended" }), waiting).approve).toBe(true);
    expect(epicMenuModel(epic({ mode: "attended" }), drain()).approve).toBe(false);
    expect(epicMenuModel(epic({ mode: "attended" }), drain()).attended).toBe(true);
  });

  it("paused: resume and end", () => {
    const model = epicMenuModel(epic({ status: "paused" }), drain());
    expect(model.pause).toBe(false);
    expect(model.start).toBe("resume");
    expect(model.end).toEqual({ promotes: null });
  });

  it("stopped with nothing leading: start, no end", () => {
    const model = epicMenuModel(
      epic({ status: "idle" }),
      drain({ epicParent: null, runSummary: summary({ leadingEpic: null }) }),
    );
    expect(model.start).toBe("start");
    expect(model.end).toBeNull();
  });

  it("never offers a start that would supersede another epic or rests on an unknown run", () => {
    const otherLeads = drain({ epicParent: 20, runSummary: summary({ leadingEpic: 20 }) });
    expect(epicMenuModel(epic({ status: "idle" }), otherLeads).start).toBeNull();
    expect(epicMenuModel(epic({ status: "paused" }), drain({ runSummary: undefined })).start).toBe(
      null,
    );
    expect(epicMenuModel(epic({ status: "paused" }), undefined).start).toBeNull();
  });

  it("queued: unqueue instead of start", () => {
    const queued = drain({
      epicParent: 20,
      runSummary: summary({ leadingEpic: 20, queued: [10] }),
    });
    const model = epicMenuModel(epic({ status: "idle" }), queued);
    expect(model.unqueue).toBe(true);
    expect(model.start).toBeNull();
    expect(model.end).toBeNull();
  });

  it("names the queued epic that starts once the leader ends", () => {
    const withQueue = drain({ runSummary: summary({ queued: [30, 40] }) });
    expect(epicMenuModel(epic(), withQueue).end).toEqual({ promotes: 30 });
  });
});

describe("epicIssueUrl", () => {
  it("derives the parent issue's URL from a child's", () => {
    const e = epic({}, [child(11, ""), child(12, "https://github.com/o/r/issues/12")]);
    expect(epicIssueUrl(e)).toBe("https://github.com/o/r/issues/10");
  });

  it("is null without a usable child URL", () => {
    expect(epicIssueUrl(epic({}, [child(11, "")]))).toBeNull();
    expect(epicIssueUrl(epic({}, [child(11, "https://github.com/o/r/pull/11")]))).toBeNull();
    expect(epicIssueUrl(epic({}, [child(11, "javascript:alert(1)//issues/11")]))).toBeNull();
    expect(epicIssueUrl(epic({}, []))).toBeNull();
  });
});
