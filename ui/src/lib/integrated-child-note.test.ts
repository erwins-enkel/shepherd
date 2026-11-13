import { describe, expect, test } from "vitest";
import {
  integratedNoteExplanation,
  integratedNoteLabel,
  integratedNoteTone,
} from "./integrated-child-note";
import type { RemoteSettleReason } from "#lib/types.js";

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
