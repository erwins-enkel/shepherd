import { describe, expect, test } from "bun:test";
import {
  START_GRACE_MS,
  dispatchedElsewhereOf,
  drainDispatchKey,
  issueOfDrainKey,
  remoteRetireView,
  remoteWorkOf,
} from "../src/drain-remote";
import type { PrStatus } from "../src/forge/types";
import type { RemoteDispatchRow } from "../src/remote-instances/dispatch";
import type { MirroredSession } from "../src/remote-instances/sessions";
import type { PrReview } from "../src/types";

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

describe("dispatchedElsewhereOf (#3957)", () => {
  test("names the machine of every issue whose newest drain dispatch started there", () => {
    // The mirror plays no part: a started dispatch counts whether or not its session is shown.
    const sent = dispatchedElsewhereOf([row(1), row(2, { updatedAt: 0 })], hostOf);
    expect([...sent]).toEqual([
      [1, mac],
      [2, mac],
    ]);
  });

  test("an unconfirmed, held or rejected start, a removed machine and other keys do not", () => {
    const sent = dispatchedElsewhereOf(
      [
        row(1, { state: "sending", sessionId: null }),
        row(2, { state: "held", sessionId: null }),
        row(3, { state: "rejected", sessionId: null }),
        row(4, { instanceId: "other" }),
        row(5, { clientKey: "3c0ffee0-0000-4000-8000-000000000000" }),
      ],
      hostOf,
    );
    expect(sent.size).toBe(0);
  });

  test("the newest dispatch per issue decides", () => {
    const newer = row(1, { id: "new", state: "sending", clientKey: drainDispatchKey(1, "b") });
    const older = row(1, { id: "old", clientKey: drainDispatchKey(1, "a") });
    expect(dispatchedElsewhereOf([newer, older], hostOf).has(1)).toBe(false);
  });
});

describe("remoteRetireView (#3957)", () => {
  const pr: PrStatus = {
    state: "open",
    number: 3955,
    checks: "success",
    mergeable: true,
    headSha: "h2",
    baseRefName: "epic/1-x",
    deployConfigured: false,
  };
  const review = (over: Partial<PrReview> = {}): PrReview => ({
    repoPath: "/repo",
    prNumber: 3955,
    headSha: "h2",
    patchId: "p",
    decision: "commented",
    reviewedPatchIds: [],
    updatedAt: 1,
    ...over,
  });

  test("carries the forge's PR as a GitHub git state and the epic host's verdict for its head", () => {
    const view = remoteRetireView(pr, review());
    expect(view.git).toMatchObject({ kind: "github", number: 3955, headSha: "h2" });
    expect(view).toMatchObject({
      reviewDecision: "commented",
      reviewHeadSha: "h2",
      findings: [],
      humanApproved: false,
    });
  });

  test("no verdict yet, or a row without one, reads as no verdict", () => {
    expect(remoteRetireView(pr, null)).toMatchObject({ reviewDecision: null, reviewHeadSha: null });
    expect(remoteRetireView(pr, review({ decision: "" }))).toMatchObject({
      reviewDecision: null,
      reviewHeadSha: null,
    });
  });

  test("a human approval on the PR counts as one", () => {
    const approved = { ...pr, latestReview: { state: "approved", author: "k", submittedAt: 1 } };
    expect(remoteRetireView(approved as PrStatus, null).humanApproved).toBe(true);
  });
});
