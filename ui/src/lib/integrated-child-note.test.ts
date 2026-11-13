import { describe, expect, test } from "vitest";
import {
  integratedNoteExplanation,
  integratedNoteLabel,
  integratedNoteTone,
  pendingSettles,
  settleNoteFor,
  unlistedSettles,
} from "./integrated-child-note";
import { groupSessionsByEpic } from "./components/epic-grouping";
import type { DrainStatus, RemoteSettleReason, Session } from "#lib/types.js";

// #3016: the herd's note on integrated work — what happened, how a settle elsewhere stands.

const MAC = { instanceId: "mac-1", name: "macbook", platform: "macos" };
const REASONS: RemoteSettleReason[] = [
  "requested",
  "offline",
  "busy",
  "held",
  "not_merged_there",
  "rejected",
  "unsupported",
  "failed",
];

describe("integrated note", () => {
  test("a local session says only that its epic integrated it", () => {
    const note = { parentIssueNumber: 3016, host: null, settle: null };
    expect(integratedNoteLabel(note)).toBe("Integrated into epic #3016");
    expect(integratedNoteTone(note)).toBe("quiet");
    const tip = integratedNoteExplanation(note);
    expect(tip.title).toBe("Integrated into epic #3016");
    expect(tip.sections.map((s) => s.label)).toEqual(["What happens", "What you can do"]);
  });

  test("one on another machine names the machine and the open reason, with a distinct text each", () => {
    const texts = new Set<string>();
    for (const settle of REASONS) {
      const note = { parentIssueNumber: 3016, host: MAC, settle };
      const label = integratedNoteLabel(note);
      expect(label).toContain("#3016");
      expect(label).toContain("macbook");
      const tip = integratedNoteExplanation(note);
      expect(tip.summary).toContain("macbook");
      expect(tip.sections).toHaveLength(2);
      for (const section of tip.sections) expect(section.text).not.toBe("");
      texts.add(`${label}|${tip.sections[0]!.text}|${tip.sections[1]!.text}`);
    }
    expect(texts.size).toBe(REASONS.length);
  });

  test("only reasons that wait on the operator take the warn tone", () => {
    const tone = (settle: RemoteSettleReason) =>
      integratedNoteTone({ parentIssueNumber: 1, host: MAC, settle });
    expect(REASONS.filter((r) => tone(r) === "warn")).toEqual([
      "held",
      "not_merged_there",
      "rejected",
      "unsupported",
    ]);
  });

  test("an unknown reason from a newer server reads as an ongoing settle", () => {
    const unknown = { parentIssueNumber: 1, host: MAC, settle: "later" as RemoteSettleReason };
    const requested = { parentIssueNumber: 1, host: MAC, settle: "requested" as const };
    expect(integratedNoteLabel(unknown)).toBe(integratedNoteLabel(requested));
    expect(integratedNoteLabel({ ...requested, settle: null })).toBe(
      integratedNoteLabel(requested),
    );
  });
});

describe("open settles from the drain status (#3016)", () => {
  const status = (repoPath: string, sessionId: string, reason: RemoteSettleReason): DrainStatus =>
    ({
      repoPath,
      enabled: false,
      paused: false,
      reason: null,
      detail: null,
      queued: 0,
      inFlight: 0,
      max: 2,
      epicParent: null,
      remoteSettle: [{ issueNumber: 3013, parentIssueNumber: 3016, host: MAC, sessionId, reason }],
    }) as DrainStatus;

  test("are read off every repo's status, by the session there", () => {
    const settles = pendingSettles({
      "/r": status("/r", "mac-145", "offline"),
      "/q": { ...status("/q", "x", "busy"), remoteSettle: undefined },
    });
    expect([...settles.keys()]).toEqual(["mac-145"]);
    expect(settles.get("mac-145")).toMatchObject({ repoPath: "/r", reason: "offline" });
  });

  test("survive the epic's record: a merged mirrored child with no epic left still gets its note", () => {
    const mac145 = {
      id: "mac-145",
      repoPath: "/Users/x/repo",
      issueNumber: 3013,
      host: MAC,
      git: { kind: "github", state: "merged", number: 3955, checks: "success" },
    } as unknown as Session;
    // Every child integrated: the run went idle and the herd dropped the epic — no epic to group by.
    const grouped = groupSessionsByEpic(
      [],
      {},
      new Set(),
      {},
      () => false,
      () => false,
      0,
      [mac145],
    );
    expect(grouped.mirroredRest.map((s) => s.id)).toEqual(["mac-145"]);
    const settles = pendingSettles({ "/r": status("/r", "mac-145", "unsupported") });
    expect(settleNoteFor("mac-145", grouped.integrated.get("mac-145"), settles)).toEqual({
      parentIssueNumber: 3016,
      host: MAC,
      settle: "unsupported",
    });
  });

  test("fill in the reason an epic's note lacks, and leave other sessions alone", () => {
    const settles = pendingSettles({ "/r": status("/r", "mac-145", "busy") });
    const fromEpic = { parentIssueNumber: 3016, host: MAC, settle: null };
    expect(settleNoteFor("mac-145", fromEpic, settles)?.settle).toBe("busy");
    expect(settleNoteFor("local-1", undefined, settles)).toBeUndefined();
    const local = { parentIssueNumber: 3016, host: null, settle: null };
    expect(settleNoteFor("local-1", local, settles)).toBe(local);
  });

  test("one whose session the mirror does not show is listed on its own, within the repo filter", () => {
    const settles = pendingSettles({
      "/r": status("/r", "missing", "offline"),
      "/q": status("/q", "listed", "busy"),
    });
    expect(
      unlistedSettles(settles, new Set(["listed"]), new Set()).map((p) => p.sessionId),
    ).toEqual(["missing"]);
    expect(unlistedSettles(settles, new Set(), new Set(["/q"])).map((p) => p.sessionId)).toEqual([
      "listed",
    ]);
  });
});
