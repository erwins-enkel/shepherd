import { test, expect } from "bun:test";
import {
  type HandoffPrepared,
  type MoveSourcePort,
  type MoveTargetPort,
  type TargetOutcome,
  continuationBody,
  moveKey,
  runMove,
} from "../src/remote-instances/move";

// The coordinator's half of a session move: prepare on the source, stage the carried files, create
// on the target, then archive the original — or bring its agent back when nothing moved.

const SRC = { instanceId: "src-id", name: "moes-tavern", platform: "linux" };
const DST = { instanceId: "dst-id", name: "macbook", platform: "macos" };
const HEAD = "e".repeat(40);

function handoff(over: Partial<HandoffPrepared> = {}): HandoffPrepared {
  return {
    branch: "shepherd/ios-paritaet",
    headCommit: HEAD,
    committed: true,
    repoPath: "/src/repo",
    baseBranch: "main",
    prompt: "port the PWA features",
    desig: "TASK-2887",
    agentProvider: "codex",
    planGateEnabled: false,
    autopilotEnabled: null,
    research: false,
    epicAuthoring: false,
    plain: false,
    amendments: ["also the widgets"],
    files: [".shepherd-plan.md", ".shepherd-uploads/shot.png"],
    issueRef: {
      number: 3731,
      title: "iOS parity",
      url: "https://github.com/o/r/issues/3731",
      body: "b",
    },
    ...over,
  };
}

function ports(opts: {
  prepared?: Awaited<ReturnType<MoveSourcePort["prepare"]>>;
  outcome?: TargetOutcome | Error;
  missing?: string[];
}) {
  const log: string[] = [];
  const created: { body: Record<string, unknown>; key: string }[] = [];
  const completed: boolean[] = [];
  const source: MoveSourcePort = {
    host: SRC,
    prepare: async (to) => {
      log.push(`prepare:${to.name}`);
      return opts.prepared ?? { ok: true, handoff: handoff() };
    },
    fetchFile: async (rel, dest) => {
      log.push(`fetch:${rel}->${dest}`);
      return !(opts.missing ?? []).includes(rel);
    },
    complete: async (carried) => {
      log.push("complete");
      completed.push(carried);
      return true;
    },
    abort: async () => {
      log.push("abort");
    },
  };
  const target: MoveTargetPort = {
    host: DST,
    create: async (body, key) => {
      log.push("create");
      created.push({ body, key });
      if (opts.outcome instanceof Error) throw opts.outcome;
      return opts.outcome ?? { kind: "started", session: { id: "new", host: DST } };
    },
  };
  let n = 0;
  const run = {
    sessionId: "orig",
    source,
    target,
    choice: {
      agentProvider: "claude" as const,
      model: "opus",
      effort: "high",
      handoffMode: "resume" as const,
    },
    repoPath: "/coord/repo",
    stagePath: () => `/staging/${++n}`,
  };
  return { run, log, created, completed };
}

test("a started move stages the files, creates the continuation and archives the original", async () => {
  const { run, log, created, completed } = ports({});
  const reply = await runMove(run);
  expect(reply).toEqual({
    status: 201,
    body: { session: { id: "new", host: DST }, archived: true },
  });
  expect(log).toEqual([
    "prepare:macbook",
    "fetch:.shepherd-plan.md->/staging/1",
    "fetch:.shepherd-uploads/shot.png->/staging/2",
    "create",
    "complete",
  ]);
  expect(completed).toEqual([true]);
  expect(created[0]!.key).toBe(moveKey("orig", HEAD));
  expect(created[0]!.body).toEqual({
    repoPath: "/coord/repo",
    baseBranch: "main",
    prompt: "port the PWA features",
    agentProvider: "claude",
    model: "opus",
    effort: "high",
    images: ["/staging/1", "/staging/2"],
    attachmentNames: [".shepherd-plan.md", "shot.png"],
    issueRef: handoff().issueRef,
    planGateEnabled: false,
    autopilotEnabled: null,
    continuation: {
      branch: "shepherd/ios-paritaet",
      headCommit: HEAD,
      handoffMode: "resume",
      from: { machine: "moes-tavern", desig: "TASK-2887", provider: "codex" },
      amendments: ["also the widgets"],
    },
  });
});

test("a file that does not come along is named to the new agent instead of failing the move", async () => {
  const { run, created } = ports({ missing: [".shepherd-uploads/shot.png"] });
  const reply = await runMove(run);
  expect(reply.status).toBe(201);
  const body = created[0]!.body as { images: string[]; continuation: { missingFiles: string[] } };
  expect(body.images).toEqual(["/staging/1"]);
  expect(body.continuation.missingFiles).toEqual(["shot.png"]);
});

test("a refused prepare is passed on and nothing else happens", async () => {
  const { run, log } = ports({
    prepared: { ok: false, status: 409, body: { error: "merging", code: "move_merging" } },
  });
  expect(await runMove(run)).toEqual({
    status: 409,
    body: { error: "merging", code: "move_merging" },
  });
  expect(log).toEqual(["prepare:macbook"]);
});

test("a failed create resumes the original and never archives it", async () => {
  const { run, log } = ports({
    outcome: { kind: "failed", status: 409, body: { error: "stale", code: "remote_rejected" } },
  });
  expect(await runMove(run)).toEqual({
    status: 409,
    body: { error: "stale", code: "remote_rejected" },
  });
  expect(log.slice(-2)).toEqual(["create", "abort"]);
});

test("a throwing create counts as failed", async () => {
  const { run, log } = ports({ outcome: new Error("boom") });
  const reply = await runMove(run);
  expect(reply.status).toBe(500);
  expect(reply.body.code).toBe("move_failed");
  expect(log.at(-1)).toBe("abort");
});

test("no answer from the target undoes nothing: neither resume nor archive", async () => {
  const { run, log } = ports({
    outcome: { kind: "unknown", body: { dispatchId: "d1", host: DST } },
  });
  const reply = await runMove(run);
  expect(reply.status).toBe(504);
  expect(reply.body).toMatchObject({
    code: "move_target_unknown",
    dispatchId: "d1",
    archived: false,
  });
  expect(log.at(-1)).toBe("create");
});

test("a task the target holds still moves: the original is archived", async () => {
  const { run, log } = ports({
    outcome: { kind: "held", body: { held: true, id: "h1", count: 1, host: DST } },
  });
  const reply = await runMove(run);
  expect(reply).toEqual({
    status: 200,
    body: { held: true, id: "h1", count: 1, host: DST, archived: true },
  });
  expect(log.at(-1)).toBe("complete");
});

test("continuationBody names only true task kinds and no issue when none was carried", () => {
  const body = continuationBody(
    handoff({ issueRef: null, research: true, amendments: [], files: [] }),
    { choice: { model: null, effort: null, handoffMode: "summarize" }, repoPath: "/r" },
    SRC,
    { images: [], names: [], missing: [] },
  );
  expect(body.research).toBe(true);
  expect("plain" in body).toBe(false);
  expect("issueRef" in body).toBe(false);
  expect("images" in body).toBe(false);
  expect("agentProvider" in body).toBe(false);
  expect(body.continuation).toEqual({
    branch: "shepherd/ios-paritaet",
    headCommit: HEAD,
    handoffMode: "summarize",
    from: { machine: "moes-tavern", desig: "TASK-2887", provider: "codex" },
  });
});
