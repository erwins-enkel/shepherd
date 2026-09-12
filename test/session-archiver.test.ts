// test/session-archiver.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionArchiver, type SessionArchiverDeps } from "../src/session-archiver";
import { SESSION_AUTO_ARCHIVE_MS, config } from "../src/config";
import { maintenance } from "../src/maintenance";
import type { GitForge, PrStatus } from "../src/forge/types";
import type { LivenessState, Session } from "../src/types";

const NOW = 1_800_000_000_000;
/** Settled well past the grace window. */
const SETTLED = NOW - SESSION_AUTO_ARCHIVE_MS - 1000;

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: ENV, stdio: "pipe" }).toString();

const tmpDirs: string[] = [];

/**
 * A worktree whose branch is committed and pushed to a real (local, bare) remote — the "nothing
 * unsynced" baseline. Callers dirty it or add commits to exercise the unsynced gate against real
 * git behaviour rather than a stubbed string.
 */
function mkWorktree(): string {
  const remote = mkdtempSync(join(tmpdir(), "shepherd-sa-remote-"));
  const wt = mkdtempSync(join(tmpdir(), "shepherd-sa-wt-"));
  tmpDirs.push(remote, wt);
  git(remote, "init", "-q", "--bare", "-b", "main");
  git(wt, "init", "-q", "-b", "main");
  writeFileSync(join(wt, "f.txt"), "hello\n");
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", "init");
  git(wt, "remote", "add", "origin", remote);
  git(wt, "push", "-q", "-u", "origin", "main");
  return wt;
}

function session(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    desig: "TASK-01",
    name: "task",
    prompt: "",
    repoPath: "/repo",
    baseBranch: "main",
    branch: "main",
    worktreePath: "/nonexistent-worktree",
    isolated: false,
    herdrSession: "h",
    herdrAgentId: "a",
    claudeSessionId: "claude-1",
    agentProvider: "claude",
    model: null,
    effort: null,
    readyToMerge: false,
    mergingSince: null,
    mergingTrainId: null,
    mergeTrainPrs: null,
    mergingPrNumber: null,
    autopilotEnabled: null,
    autopilotStepCount: 0,
    autopilotPaused: false,
    autopilotComplete: false,
    autopilotQuestion: null,
    completionRepromptCount: 0,
    planGateEnabled: null,
    planPhase: null,
    research: false,
    epicAuthoring: false,
    landingRepair: false,
    autoMergeEnabled: null,
    autoMergeRebaseCount: 0,
    auto: false,
    issueNumber: null,
    sandboxApplied: null,
    sandboxDegraded: false,
    egressApplied: false,
    egressDegraded: false,
    terminal: false,
    terminalTabId: null,
    terminalPaneId: null,
    status: "idle",
    lastState: "idle",
    createdAt: SETTLED - 1000,
    updatedAt: NOW,
    settledAt: SETTLED,
    archivedAt: null,
    haltReason: null,
    haltedAt: null,
    manualSteps: [],
    manualStepsAckedAt: null,
    experimentId: null,
    experimentRole: null,
    spawnTerminalId: null,
    spawnAccountDir: null,
    ...over,
  } as Session;
}

const forgeWith = (state: PrStatus["state"]): GitForge =>
  ({
    prStatus: async () => ({ state, checks: "none", deployConfigured: false }) as PrStatus,
  }) as unknown as GitForge;

interface Harness {
  archiver: SessionArchiver;
  archived: string[];
  claimed: string[];
  dropped: string[];
  emitted: string[];
  order: string[];
}

function harness(
  sessions: Session[],
  over: Partial<SessionArchiverDeps> & { liveness?: Record<string, LivenessState> } = {},
): Harness {
  const { liveness, ...deps } = over;
  const archived: string[] = [];
  const claimed: string[] = [];
  const dropped: string[] = [];
  const emitted: string[] = [];
  const order: string[] = [];
  const archiver = new SessionArchiver({
    store: {
      list: () => sessions,
      hasInflightReviewerSpawn: () => false,
    } as unknown as SessionArchiverDeps["store"],
    resolveForge: () => forgeWith("closed"),
    // Default: every session reads as a husk, so each test opts INTO the blocking case it means
    // to exercise rather than re-stating the happy path.
    livenessOf: (id) => liveness?.[id] ?? "husk",
    livenessFreshAt: () => NOW,
    hasConversation: (s) =>
      (s.agentProvider ?? "claude") === "claude"
        ? !!s.claudeSessionId
        : !!s.codexLaunchId && !!s.providerSessionId,
    retainClaim: (id) => {
      claimed.push(id);
      order.push(`claim:${id}`);
    },
    archive: async (id) => {
      archived.push(id);
      order.push(`archive:${id}`);
    },
    dropPrCache: (id) => {
      dropped.push(id);
      order.push(`drop:${id}`);
    },
    emitArchived: (id) => {
      emitted.push(id);
      order.push(`emit:${id}`);
    },
    now: () => NOW,
    ...deps,
  });
  return { archiver, archived, claimed, dropped, emitted, order };
}

beforeEach(() => {
  config.sessionAutoArchiveEnabled = true;
});

afterEach(() => {
  config.sessionAutoArchiveEnabled = true;
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ── the happy path ────────────────────────────────────────────────────────────

test("archives a settled idle husk, claiming after the archive and before the emit", async () => {
  const h = harness([session()]);
  await h.archiver.tick();
  expect(h.archived).toEqual(["s1"]);
  // The claim stamp sits between the two: AFTER the archive resolves (a one-shot flag stamped for
  // a teardown that then threw would arm the next, genuine abandon into a retire) and BEFORE the
  // emit (DrainService.onArchived consumes it synchronously; without it the sweep would release
  // the issue's claim label and re-queue it for the drain).
  expect(h.order).toEqual(["archive:s1", "claim:s1", "drop:s1", "emit:s1"]);
});

test("a settled DONE session is archived too (both settled statuses are eligible)", async () => {
  const h = harness([session({ status: "done", lastState: "done" })]);
  await h.archiver.tick();
  expect(h.archived).toEqual(["s1"]);
});

// ── eligibility ───────────────────────────────────────────────────────────────

test("not yet past the grace window → untouched", async () => {
  const h = harness([session({ settledAt: NOW - SESSION_AUTO_ARCHIVE_MS + 60_000 })]);
  await h.archiver.tick();
  expect(h.archived).toEqual([]);
});

test("null settledAt is never eligible, however old the row", async () => {
  const h = harness([session({ settledAt: null, createdAt: 0, updatedAt: 0 })]);
  await h.archiver.tick();
  expect(h.archived).toEqual([]);
});

test("running, blocked and terminal sessions are out of scope", async () => {
  const h = harness([
    session({ id: "run", status: "running" }),
    session({ id: "blocked", status: "blocked" }),
    session({ id: "term", terminal: true }),
  ]);
  await h.archiver.tick();
  expect(h.archived).toEqual([]);
});

test("a herdr update in progress pauses the sweep", async () => {
  const h = harness([session()]);
  maintenance.begin();
  try {
    await h.archiver.tick();
  } finally {
    maintenance.end();
  }
  expect(h.archived).toEqual([]);
  // …and the very next tick, once herdr is back, proceeds.
  await h.archiver.tick();
  expect(h.archived).toEqual(["s1"]);
});

test("the freshness bound follows the sweep cadence, so a slowed sweep still authorizes", async () => {
  // A fixed minute would silently disable auto-archive on a host that raised
  // SHEPHERD_PREVIEW_SWEEP_MS past it — every verdict would read as stale, forever.
  const slow = harness([session()], { livenessFreshAt: () => NOW - 90_000 });
  const previous = config.previewSweepMs;
  config.previewSweepMs = 40_000; // bound becomes 120s → a 90s-old verdict is still fresh
  try {
    await slow.archiver.tick();
  } finally {
    config.previewSweepMs = previous;
  }
  expect(slow.archived).toEqual(["s1"]);
});

test("disabled → tick is a no-op", async () => {
  config.sessionAutoArchiveEnabled = false;
  const h = harness([session()]);
  await h.archiver.tick();
  expect(h.archived).toEqual([]);
});

// ── the liveness gate ─────────────────────────────────────────────────────────

test("alive, stranded, and unknown liveness all spare the session", async () => {
  for (const state of ["alive", "stranded", undefined] as (LivenessState | undefined)[]) {
    const h = harness([session()], {
      livenessOf: () => state,
    });
    await h.archiver.tick();
    expect(h.archived).toEqual([]);
  }
});

test("a stale liveness sweep spares every session", async () => {
  const h = harness([session()], { livenessFreshAt: () => NOW - 120_000 });
  await h.archiver.tick();
  expect(h.archived).toEqual([]);
});

// ── work in flight ────────────────────────────────────────────────────────────

test("merge train, open plan round and in-flight reviewer each block", async () => {
  const merging = harness([session({ mergingSince: NOW - 1000 })]);
  await merging.archiver.tick();
  expect(merging.archived).toEqual([]);

  const planning = harness([session({ planPhase: "planning" })]);
  await planning.archiver.tick();
  expect(planning.archived).toEqual([]);

  const reviewing = harness([session()], {
    store: {
      list: () => [session()],
      hasInflightReviewerSpawn: () => true,
    } as unknown as SessionArchiverDeps["store"],
  });
  await reviewing.archiver.tick();
  expect(reviewing.archived).toEqual([]);
});

// ── restorability ─────────────────────────────────────────────────────────────

test("a session restore() could not bring back is never archived", async () => {
  const noClaudeId = harness([session({ claudeSessionId: "" })]);
  await noClaudeId.archiver.tick();
  expect(noClaudeId.archived).toEqual([]);

  // Codex restorability is a captured rollout, NOT isolation: an isolated session whose rollout id
  // was never captured would archive here and then fail `restore()` with cannot_restore — exactly
  // the one-way teardown this gate exists to prevent.
  const codexNoRollout = harness([
    session({
      agentProvider: "codex",
      isolated: true,
      claudeSessionId: "",
      worktreePath: "/gone",
      branch: null,
    }),
  ]);
  await codexNoRollout.archiver.tick();
  expect(codexNoRollout.archived).toEqual([]);

  const codexWithRollout = harness([
    session({
      agentProvider: "codex",
      isolated: true,
      claudeSessionId: "",
      codexLaunchId: "launch-1",
      providerSessionId: "rollout-1",
      worktreePath: "/gone",
      branch: null,
    }),
  ]);
  await codexWithRollout.archiver.tick();
  expect(codexWithRollout.archived).toEqual(["s1"]);
});

test("restorability is asked of the service, not re-derived", async () => {
  // The predicate restore() gates on has already changed once under this file; the gate must
  // follow it rather than keep its own copy.
  const asked: string[] = [];
  const h = harness([session()], {
    hasConversation: (s) => {
      asked.push(s.id);
      return false;
    },
  });
  await h.archiver.tick();
  expect(asked).toEqual(["s1"]);
  expect(h.archived).toEqual([]);
});

// ── unsynced work (real git) ──────────────────────────────────────────────────

test("a clean, pushed worktree passes the unsynced gate", async () => {
  const wt = mkWorktree();
  const h = harness([session({ isolated: true, worktreePath: wt, branch: "main" })]);
  await h.archiver.tick();
  expect(h.archived).toEqual(["s1"]);
});

test("uncommitted edits block", async () => {
  const wt = mkWorktree();
  writeFileSync(join(wt, "f.txt"), "edited\n");
  const h = harness([session({ isolated: true, worktreePath: wt, branch: "main" })]);
  await h.archiver.tick();
  expect(h.archived).toEqual([]);
});

test("an untracked file blocks", async () => {
  const wt = mkWorktree();
  writeFileSync(join(wt, "scratch.txt"), "notes\n");
  const h = harness([session({ isolated: true, worktreePath: wt, branch: "main" })]);
  await h.archiver.tick();
  expect(h.archived).toEqual([]);
});

test("unpushed commits block", async () => {
  const wt = mkWorktree();
  writeFileSync(join(wt, "f.txt"), "more\n");
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", "local only");
  const h = harness([session({ isolated: true, worktreePath: wt, branch: "main" })]);
  await h.archiver.tick();
  expect(h.archived).toEqual([]);
});

test("a branch that was never pushed blocks", async () => {
  const wt = mkWorktree();
  git(wt, "checkout", "-q", "-b", "shepherd/never-pushed");
  writeFileSync(join(wt, "f.txt"), "unshared\n");
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", "no upstream");
  const h = harness([
    session({ isolated: true, worktreePath: wt, branch: "shepherd/never-pushed" }),
  ]);
  await h.archiver.tick();
  expect(h.archived).toEqual([]);
});

test("a vanished worktree has nothing left to lose", async () => {
  const h = harness([session({ isolated: true, worktreePath: "/definitely/not/here" })]);
  await h.archiver.tick();
  expect(h.archived).toEqual(["s1"]);
});

// ── the PR gate ───────────────────────────────────────────────────────────────

test("an open PR blocks; merged/closed/none pass", async () => {
  const open = harness([session()], { resolveForge: () => forgeWith("open") });
  await open.archiver.tick();
  expect(open.archived).toEqual([]);

  for (const state of ["merged", "closed", "none"] as PrStatus["state"][]) {
    const h = harness([session()], { resolveForge: () => forgeWith(state) });
    await h.archiver.tick();
    expect(h.archived).toEqual(["s1"]);
  }
});

test("a throwing forge, and a repo with no forge, both spare the session", async () => {
  const throwing = harness([session()], {
    resolveForge: () =>
      ({
        prStatus: async () => {
          throw new Error("gh exploded");
        },
      }) as unknown as GitForge,
  });
  await throwing.archiver.tick();
  expect(throwing.archived).toEqual([]);

  const none = harness([session()], { resolveForge: () => null });
  await none.archiver.tick();
  expect(none.archived).toEqual([]);
});

test("a session with no branch never opened a PR, so no forge lookup is needed", async () => {
  let looked = 0;
  const h = harness([session({ branch: null })], {
    resolveForge: () => {
      looked++;
      return forgeWith("open");
    },
  });
  await h.archiver.tick();
  expect(h.archived).toEqual(["s1"]);
  expect(looked).toBe(0);
});

// ── batching ──────────────────────────────────────────────────────────────────

test("caps archives per tick and takes the oldest settle first", async () => {
  const sessions = [
    session({ id: "newest", settledAt: SETTLED + 300 }),
    session({ id: "oldest", settledAt: SETTLED }),
    session({ id: "middle", settledAt: SETTLED + 100 }),
  ];
  const h = harness(sessions, { maxArchivesPerTick: 2 });
  await h.archiver.tick();
  expect(h.archived).toEqual(["oldest", "middle"]);
});

test("one failing archive does not abort the sweep, and leaves no claim behind", async () => {
  const sessions = [session({ id: "boom" }), session({ id: "ok" })];
  const archived: string[] = [];
  const h = harness(sessions, {
    archive: async (id) => {
      if (id === "boom") throw new Error("teardown failed");
      archived.push(id);
    },
  });
  await h.archiver.tick();
  expect(archived).toEqual(["ok"]);
  // retainClaimOnArchive is a ONE-SHOT flag consumed by the next session:archived for that id.
  // Stamping it for a session that did not archive would leave it armed on a live session, and
  // the operator's own later close — a real abandon — would be converted into a retire: the
  // issue would keep its claim label and never be re-queued.
  expect(h.claimed).toEqual(["ok"]);
  expect(h.emitted).toEqual(["ok"]);
});

test("the in-flight reviewer gate only counts RECENT unfinished spawns", async () => {
  // Several spawn kinds have no completion sweep, so a crash-orphaned row stays unfinished
  // forever; an unbounded gate would bar its session from ever archiving.
  const seen: number[] = [];
  const h = harness([session()], {
    store: {
      list: () => [session()],
      hasInflightReviewerSpawn: (_id: string, since: number) => {
        seen.push(since);
        return false;
      },
    } as unknown as SessionArchiverDeps["store"],
  });
  await h.archiver.tick();
  expect(h.archived).toEqual(["s1"]);
  // Six hours back: past any real reviewer (the critic caps its own wait at 1800s), and these
  // candidates have been settled a week.
  expect(seen).toEqual([NOW - 6 * 60 * 60 * 1000]);
});

test("no upstream and no base to measure against reads as unsynced", async () => {
  const wt = mkWorktree();
  git(wt, "checkout", "-q", "-b", "shepherd/orphan");
  const h = harness([
    session({ isolated: true, worktreePath: wt, branch: "shepherd/orphan", baseBranch: "" }),
  ]);
  await h.archiver.tick();
  expect(h.archived).toEqual([]);
});
