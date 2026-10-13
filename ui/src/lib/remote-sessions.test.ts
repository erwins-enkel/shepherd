import { describe, expect, test } from "vitest";
import {
  lastKnownLabel,
  machineGroups,
  mirroredPreviewChange,
  platformName,
  qualifiedDesig,
  reduceRemoteSessions,
  remoteActionMessage,
} from "./remote-sessions";
import { m } from "#lib/paraglide/messages.js";
import type { Session } from "./types";

const HOST = { instanceId: "m1", name: "MacBook", platform: "macos" };
const LIVE = { state: "connected" as const, since: 1 };
const s = (id: string, over: Partial<Session> = {}) =>
  ({ id, desig: "TASK-07", status: "running", host: HOST, connection: LIVE, ...over }) as Session;

describe("remote sessions (#2762)", () => {
  test("a mirrored label names its machine, a local one stays bare", () => {
    expect(qualifiedDesig({ desig: "TASK-07", host: HOST })).toBe("MacBook · TASK-07");
    expect(qualifiedDesig({ desig: "TASK-07" })).toBe("TASK-07");
    const other = { ...HOST, instanceId: "m2", name: "MacBook (1c7f)" };
    expect(qualifiedDesig({ desig: "TASK-07", host: other })).not.toBe(
      qualifiedDesig({ desig: "TASK-07", host: HOST }),
    );
  });

  test("platforms read as proper names, unknown ones pass through", () => {
    expect(platformName("macos")).toBe("macOS");
    expect(platformName("linux")).toBe("Linux");
    expect(platformName("freebsd")).toBe("freebsd");
  });

  test("the last-known time is a clock time today and carries the date before", () => {
    const now = new Date(2026, 9, 11, 18, 0).getTime();
    const today = lastKnownLabel(new Date(2026, 9, 11, 14, 32).getTime(), now);
    expect(today).toContain("32");
    const earlier = lastKnownLabel(new Date(2026, 9, 9, 14, 32).getTime(), now);
    expect(earlier).not.toBe(today);
    expect(earlier.length).toBeGreaterThan(today.length);
  });

  test("groups follow the machines in order of first appearance", () => {
    const other = { instanceId: "m2", name: "Studio", platform: "linux" };
    const groups = machineGroups([s("a"), s("b", { host: other }), s("c"), { id: "x" } as Session]);
    expect(groups.map((g) => [g.host.name, g.sessions.map((x) => x.id)])).toEqual([
      ["MacBook", ["a", "c"]],
      ["Studio", ["b"]],
    ]);
  });

  test("a machine's preview frames name the session, never pass on its port (#2767)", () => {
    const frame = { id: "a", previewPort: 4100, host: HOST, connection: LIVE };
    expect(mirroredPreviewChange({ event: "session:preview", data: frame })).toBe("a");
    expect(
      mirroredPreviewChange({
        event: "session:preview-serve",
        data: { id: "a", serve: "ok", host: HOST },
      }),
    ).toBe("a");
    // A local frame and any other mirrored frame are not preview changes of a machine.
    expect(
      mirroredPreviewChange({ event: "session:preview", data: { id: "l", previewPort: 1 } }),
    ).toBeNull();
    expect(mirroredPreviewChange({ event: "session:status", data: s("a") })).toBeNull();
  });

  test("tasks a machine has not confirmed lead its group; a machine with only those gets one", () => {
    const studio = { ...HOST, instanceId: "m2", name: "Studio" };
    const dispatch = (id: string, host = HOST) =>
      ({ id, state: "unknown", host, summary: "x", createdAt: 1, updatedAt: 1 }) as const;
    const groups = machineGroups([s("a")], [dispatch("d1"), dispatch("d2", studio)]);
    expect(
      groups.map((g) => [
        g.host.name,
        g.connection,
        g.dispatches.map((x) => x.id),
        g.sessions.map((x) => x.id),
      ]),
    ).toEqual([
      ["MacBook", LIVE, ["d1"], ["a"]],
      ["Studio", null, ["d2"], []],
    ]);
  });

  test("frames without host are left to the local store", () => {
    expect(reduceRemoteSessions([], { event: "session:new", data: { id: "l" } })).toBeNull();
    expect(reduceRemoteSessions([], { event: "usage:limits", data: { host: HOST } })).toBeNull();
  });

  test("a new frame for a known mirrored session replaces it in place", () => {
    const list = [s("a"), s("b")];
    const next = reduceRemoteSessions(list, { event: "session:new", data: s("a", { name: "n" }) });
    expect(next?.map((x) => [x.id, x.name])).toEqual([
      ["a", "n"],
      ["b", undefined],
    ]);
  });

  test("a status for an unknown mirrored session is consumed without adding it", () => {
    const next = reduceRemoteSessions([], {
      event: "session:status",
      data: { id: "z", status: "idle", host: HOST, connection: LIVE },
    });
    expect(next).toEqual([]);
  });
});

describe("remoteActionMessage (#2765)", () => {
  const machine = "MacBook";
  test.each([
    ["machine_unreachable", m.remote_action_unreachable({ machine })],
    ["machine_timeout", m.remote_action_timeout({ machine })],
    ["machine_unauthorized", m.remote_action_unauthorized({ machine })],
    ["remote_unsupported", m.remote_action_unsupported({ machine })],
  ])("explains %s", (code, text) => {
    expect(remoteActionMessage({ code }, machine)).toBe(text);
  });

  test("leaves the machine's own answers and other failures to the caller", () => {
    expect(remoteActionMessage({ code: "in_progress" }, machine)).toBeNull();
    expect(remoteActionMessage(new Error("boom"), machine)).toBeNull();
    expect(remoteActionMessage(null, machine)).toBeNull();
  });
});
