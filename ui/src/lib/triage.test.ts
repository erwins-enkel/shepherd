import { describe, it, expect } from "vitest";
import { sortBlocked } from "./triage";
import type { Session, BlockReason, HoldReason } from "./types";

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

  it("attaches hold reason when a holds map is passed", () => {
    const sessions = [sess("a"), sess("b")];
    const blocks = {
      a: { reason, since: 100 },
      b: { reason, since: 200 },
    };
    const hold: HoldReason = { code: "blocked-yes-no" };
    const holds = { a: hold };
    const out = sortBlocked(sessions, blocks, holds);
    expect(out[0]!.hold).toBe(hold);
    expect(out[1]!.hold).toBeUndefined();
  });
});
