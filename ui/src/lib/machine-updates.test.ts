import { describe, expect, it } from "vitest";
import { machinesBehind, updateBadge } from "./machine-updates";
import type { MachineUpdate, UpdateStatus } from "./types";
import { m } from "#lib/paraglide/messages.js";

const status = (behind: number): UpdateStatus => ({
  behind,
  current: "aaaaaaa",
  latest: "bbbbbbb",
  commits: [],
  checkedAt: 0,
});

const machine = (name: string, behind: number | null, over: Partial<MachineUpdate> = {}) =>
  ({
    instanceId: name,
    name,
    platform: "macos",
    status: "connected",
    update: behind === null ? null : status(behind),
    ...over,
  }) satisfies MachineUpdate;

describe("machinesBehind", () => {
  it("keeps machines that answered and are behind — incompatible ones included", () => {
    const list = [
      machine("mac", 3),
      machine("vps", 0),
      machine("old", 2, { status: "incompatible" }),
      machine("gone", 5, { status: "unreachable" }),
      machine("silent", null),
    ];
    expect(machinesBehind(list).map((mc) => mc.name)).toEqual(["mac", "old"]);
  });
});

describe("updateBadge", () => {
  it("shows nothing while nothing is behind", () => {
    expect(updateBadge(null, [])).toBeNull();
    expect(
      updateBadge(status(0), [machine("vps", 0), machine("gone", 4, { status: "unreachable" })]),
    ).toBeNull();
  });

  it("counts commits while only this Shepherd is behind, as it always did", () => {
    expect(updateBadge(status(4), [machine("vps", 0)])).toEqual({
      count: 4,
      machines: false,
      label: `4 ${m.updatemodal_commits_other()}`,
      explanation: null,
    });
  });

  it("counts machines once another one is behind, and names what each needs", () => {
    const badge = updateBadge(status(3), [machine("MacBook", 11), machine("vps", 0)]);
    expect(badge).toMatchObject({ count: 2, machines: true, label: "Update for 2 machines" });
    expect(badge!.explanation!.sections[0]!.rows).toEqual([
      { text: "This machine", aside: "3 commits" },
      { text: "MacBook", aside: "11 commits" },
    ]);
  });

  it("shows the badge for another machine even when this one is up to date", () => {
    const badge = updateBadge(status(0), [machine("MacBook", 1)]);
    expect(badge).toMatchObject({ count: 1, machines: true, label: "Update for 1 machine" });
    expect(badge!.explanation!.sections[0]!.rows).toEqual([{ text: "MacBook", aside: "1 commit" }]);
  });
});
