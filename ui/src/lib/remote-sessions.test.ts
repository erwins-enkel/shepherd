import { describe, expect, test } from "vitest";
import {
  byMachine,
  lastKnownLabel,
  machineColorVar,
  machineDisplayNames,
  mirroredNeedsYou,
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

  test("a machine's PR state frame lands on its session (#3055)", () => {
    const git = { state: "open", checks: "success", deployConfigured: false } as const;
    const next = reduceRemoteSessions([s("a"), s("b")], {
      event: "session:git",
      data: { id: "a", git, host: HOST, connection: LIVE },
    });
    expect(next?.map((x) => [x.id, x.git])).toEqual([
      ["a", git],
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

describe("machine filter, names and colors (#3055)", () => {
  const STUDIO = { instanceId: "m2", name: "Studio", platform: "linux" };
  const machine = (instanceId: string, name: string, createdAt: number) => ({
    instanceId,
    name,
    createdAt,
  });

  test("the filter keeps everything, this Shepherd's own, or one machine's", () => {
    const local = { id: "l" } as Session;
    const items = [local, s("a"), s("b", { host: STUDIO })];
    expect(byMachine(items, "all").map((x) => x.id)).toEqual(["l", "a", "b"]);
    expect(byMachine(items, "local").map((x) => x.id)).toEqual(["l"]);
    expect(byMachine(items, "m2").map((x) => x.id)).toEqual(["b"]);
    expect(byMachine(items, "gone").map((x) => x.id)).toEqual([]);
  });

  test("names match the server's: a shared name gets the ID's first four characters", () => {
    const names = machineDisplayNames([
      machine("abcd1234", "Mac", 1),
      machine("ef015678", "Mac", 2),
      machine("m3", "Studio", 3),
    ]);
    expect([...names.values()]).toEqual(["Mac (abcd)", "Mac (ef01)", "Studio"]);
  });

  test("a machine keeps its color by connection order, whatever order the list comes in", () => {
    const list = [machine("m2", "B", 20), machine("m1", "A", 10), machine("m3", "C", 30)];
    expect(machineColorVar("m1", list)).toBe("var(--color-data-1)");
    expect(machineColorVar("m2", list)).toBe("var(--color-data-2)");
    expect(machineColorVar("m3", [...list].reverse())).toBe("var(--color-data-3)");
    const seven = Array.from({ length: 7 }, (_, i) => machine(`m${i}`, `M${i}`, i));
    expect(machineColorVar("m6", seven)).toBe("var(--color-data-1)");
    expect(machineColorVar("unknown", list)).toBeNull();
  });

  test("the jump reaches blocked sessions on live machines, longest unchanged first", () => {
    const DOWN = { state: "disconnected" as const, since: 1 };
    const ids = mirroredNeedsYou([
      s("late", { status: "blocked", updatedAt: 30 }),
      s("early", { status: "blocked", updatedAt: 10 }),
      s("idle", { status: "idle", updatedAt: 5 }),
      s("down", { status: "blocked", updatedAt: 1, connection: DOWN }),
      { id: "local", status: "blocked", updatedAt: 0 } as Session,
    ]);
    expect(ids).toEqual(["early", "late"]);
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
