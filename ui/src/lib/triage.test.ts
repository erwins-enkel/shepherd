import { describe, it, expect } from "vitest";
import { sortBlocked } from "./triage";
import type { Session, BlockReason } from "./types";

const sess = (id: string): Session => ({ id, desig: id, name: id, status: "blocked" }) as Session;
const reason: BlockReason = { shape: "yes-no", options: [], tail: ["?"] };

describe("sortBlocked", () => {
  it("keeps only blocked-with-reason sessions, oldest-blocked first", () => {
    const sessions = [sess("a"), sess("b"), sess("c")];
    const blocks = {
      a: { reason, since: 300 },
      c: { reason, since: 100 },
    };
    const out = sortBlocked(sessions, blocks);
    expect(out.map((e) => e.session.id)).toEqual(["c", "a"]);
    expect(out[0]!.reason).toBe(reason);
  });

  it("returns empty when nothing is blocked", () => {
    expect(sortBlocked([sess("a")], {})).toEqual([]);
  });
});
