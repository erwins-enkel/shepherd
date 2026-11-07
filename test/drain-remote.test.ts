import { describe, expect, test } from "bun:test";
import {
  START_GRACE_MS,
  drainDispatchKey,
  issueOfDrainKey,
  remoteWorkOf,
} from "../src/drain-remote";
import type { RemoteDispatchRow } from "../src/remote-instances/dispatch";
import type { MirroredSession } from "../src/remote-instances/sessions";

// Which drain spawns on other machines still count: keyed by issue, newest dispatch first.

const MAC = "a2222222-2222-4222-8222-222222222222";
const mac = { instanceId: MAC, name: "macbook", platform: "macos" };
const hostOf = (id: string) => (id === MAC ? mac : null);
const NOW = 10_000_000;

function row(issue: number, over: Partial<RemoteDispatchRow> = {}): RemoteDispatchRow {
  return {
    id: `d-${issue}`,
    clientKey: drainDispatchKey(issue, `k${issue}`),
    instanceId: MAC,
    payloadHash: "h",
    wireBody: "{}",
    state: "started",
    sessionId: `s-${issue}`,
    heldId: null,
    reason: null,
    code: null,
    httpStatus: null,
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000,
    uploads: null,
    project: "o/r",
    ...over,
  };
}

function mirrored(id: string, over: Record<string, unknown> = {}): MirroredSession {
  return {
    id,
    status: "running",
    desig: "TASK-3",
    host: mac,
    connection: { state: "connected", since: 0 },
    ...over,
  } as MirroredSession;
}

describe("drain dispatch keys", () => {
  test("name their issue; other keys name none", () => {
    expect(issueOfDrainKey(drainDispatchKey(3731))).toBe(3731);
    expect(issueOfDrainKey("3c0ffee0-0000-4000-8000-000000000000")).toBeNull();
  });
});

describe("remoteWorkOf", () => {
  test("an unconfirmed or held start counts, without a session yet", () => {
    const work = remoteWorkOf(
      [row(1, { state: "sending", sessionId: null }), row(2, { state: "held", sessionId: null })],
      [],
      hostOf,
      NOW,
    );
    expect(work.get(1)).toEqual({ host: mac, sessionId: null, desig: null, prNumber: null });
    expect(work.has(2)).toBe(true);
  });

  test("a started one counts while its mirrored session lives, with its PR once open", () => {
    const work = remoteWorkOf(
      [row(1), row(2)],
      [mirrored("s-1"), mirrored("s-2", { git: { state: "open", number: 77 } })],
      hostOf,
      NOW,
    );
    expect(work.get(1)).toEqual({ host: mac, sessionId: "s-1", desig: "TASK-3", prNumber: null });
    expect(work.get(2)!.prNumber).toBe(77);
  });

  test("an archived session there no longer counts", () => {
    const work = remoteWorkOf([row(1)], [mirrored("s-1", { status: "archived" })], hostOf, NOW);
    expect(work.size).toBe(0);
  });

  test("a fresh start counts before the mirror shows it, an old one does not", () => {
    expect(remoteWorkOf([row(1)], [], hostOf, NOW).has(1)).toBe(true);
    const old = row(1, { updatedAt: NOW - START_GRACE_MS - 1 });
    expect(remoteWorkOf([old], [], hostOf, NOW).has(1)).toBe(false);
  });

  test("the newest dispatch per issue decides; a removed machine's rows do not count", () => {
    const newer = row(1, { id: "new", sessionId: "s-new", clientKey: drainDispatchKey(1, "b") });
    const older = row(1, { id: "old", sessionId: "s-old", clientKey: drainDispatchKey(1, "a") });
    const work = remoteWorkOf([newer, older], [mirrored("s-old")], hostOf, NOW);
    // The newest start has no mirrored session yet but is fresh: it, not the older one, counts.
    expect(work.get(1)!.sessionId).toBe("s-new");
    const gone = remoteWorkOf([row(2, { instanceId: "other" })], [], hostOf, NOW);
    expect(gone.size).toBe(0);
  });
});
