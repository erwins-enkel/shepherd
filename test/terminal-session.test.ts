// Clean-terminal sessions (pane-direct bare shell in the main checkout): create contract,
// singleton lease, agent-verb fences (the herdr.send invariant), teardown, hydration, and the
// poller's fail-closed pane-liveness state machine.
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, TERMINAL_CLAIM_TTL_MS } from "../src/store";
import {
  SessionService,
  TerminalExistsError,
  TerminalSessionError,
  TerminalUnsupportedError,
} from "../src/service";
import { setDetectedHerdrVersion } from "../src/herdr-capabilities";
import { StatusPoller } from "../src/poller";
import type { Session } from "../src/types";

// The create preflight fails CLOSED on an unknown herdr version — pin a capable one per test
// and always restore the un-probed state so no other suite inherits it.
afterEach(() => setDetectedHerdrVersion(null));

type ShellReply = { tabId: string; paneId: string; terminalId: string; cwd: string };

function makeSvc(over: { shell?: Partial<ShellReply>; parkSpawn?: Promise<void> } = {}) {
  setDetectedHerdrVersion("0.7.5");
  const store = new SessionStore(":memory:");
  const calls = {
    shellTabs: [] as { cwd: string; label: string; env?: Record<string, string> }[],
    closedTabs: [] as string[],
    sends: [] as { target: string; text: string }[],
    stops: [] as string[],
    wtCreates: 0,
    wtRemoves: 0,
  };
  const service = new SessionService({
    store,
    namer: async () => "unused-by-terminal",
    worktree: {
      ensureBaseRef: async () => {},
      branchExists: () => false,
      create: () => {
        calls.wtCreates++;
        throw new Error("worktree must never be created for a terminal session");
      },
      remove: () => {
        calls.wtRemoves++;
      },
    } as any,
    herdr: {
      list: () => [],
      send: async (target: string, text: string) => {
        calls.sends.push({ target, text });
      },
      stop: async (target: string) => {
        calls.stops.push(target);
      },
      startShellTab: async (cwd: string, label: string, env?: Record<string, string>) => {
        calls.shellTabs.push({ cwd, label, env });
        if (over.parkSpawn) await over.parkSpawn;
        return {
          tabId: "w1:t9",
          paneId: "w1:p9",
          terminalId: "term_shell9",
          cwd,
          ...over.shell,
        };
      },
      closeTab: async (id: string) => {
        calls.closedTabs.push(id);
      },
    } as any,
  });
  return { store, service, calls };
}

const TERM_INPUT = { repoPath: "/repo", terminal: true as const };

test("terminal create: shell tab at the MAIN checkout, no worktree, fenced-inert row shape", async () => {
  const { store, service, calls } = makeSvc();
  const s = await service.create(TERM_INPUT);

  expect(calls.wtCreates).toBe(0);
  expect(calls.shellTabs).toHaveLength(1);
  expect(calls.shellTabs[0]!.cwd).toBe("/repo");
  // SESSION_MARKER_ENV rides tab create --env for runaway-reaper attribution.
  expect(Object.values(calls.shellTabs[0]!.env ?? {})).toContain(s.id);

  const row = store.get(s.id)!;
  expect(row.terminal).toBe(true);
  expect(row.terminalTabId).toBe("w1:t9");
  expect(row.terminalPaneId).toBe("w1:p9");
  expect(row.herdrAgentId).toBe("term_shell9");
  expect(row.worktreePath).toBe("/repo");
  expect(row.isolated).toBe(false);
  expect(row.branch).toBeNull();
  expect(row.baseBranch).toBe("");
  expect(row.prompt).toBe("");
  expect(row.planGateEnabled).toBe(false);
  expect(row.autopilotEnabled).toBe(false);
  expect(row.planPhase).toBeNull();
});

test("terminal create: preflight fails closed on an old or unknown herdr — no tab is spawned", async () => {
  const { service, calls } = makeSvc();
  setDetectedHerdrVersion("0.7.2");
  await expect(service.create(TERM_INPUT)).rejects.toBeInstanceOf(TerminalUnsupportedError);
  setDetectedHerdrVersion(null); // un-probed process → also refused
  await expect(service.create(TERM_INPUT)).rejects.toBeInstanceOf(TerminalUnsupportedError);
  expect(calls.shellTabs).toHaveLength(0);
});

test("terminal singleton: second create refuses with the live session's id, without spawning", async () => {
  const { service, calls } = makeSvc();
  const first = await service.create(TERM_INPUT);
  const err = await service.create(TERM_INPUT).catch((e) => e);
  expect(err).toBeInstanceOf(TerminalExistsError);
  expect((err as TerminalExistsError).existingId).toBe(first.id);
  expect(calls.shellTabs).toHaveLength(1); // the loser never reached herdr
});

test("terminal singleton: concurrent creates — the claim is taken BEFORE the spawn", async () => {
  let release!: () => void;
  const parked = new Promise<void>((r) => (release = r));
  const { service, calls } = makeSvc({ parkSpawn: parked });
  const a = service.create(TERM_INPUT);
  const b = service.create(TERM_INPUT).catch((e) => e);
  // Loser is refused while the winner's spawn is still parked (lease, not row, arbitrates).
  const loser = await b;
  expect(loser).toBeInstanceOf(TerminalExistsError);
  release();
  const winner = await a;
  expect(winner.terminal).toBe(true);
  expect(calls.shellTabs).toHaveLength(1);
});

test("terminal create: cwd-mismatch contract violation closes the tab and frees the slot", async () => {
  const { service, calls } = makeSvc({ shell: { cwd: "/somewhere/else" } });
  await expect(service.create(TERM_INPUT)).rejects.toThrow(/expected \/repo/);
  expect(calls.closedTabs).toEqual(["w1:t9"]); // rollback — no orphan shell tab
  // Claim released in finally → a corrected retry succeeds immediately.
  const retry = makeSvc();
  await expect(retry.service.create(TERM_INPUT)).resolves.toBeTruthy();
});

test("agent-verb fences: every input/lifecycle verb refuses a terminal session with 409-typed errors", async () => {
  const { service } = makeSvc();
  const s = await service.create(TERM_INPUT);

  await expect(service.operatorReply(s.id, "hi")).rejects.toBeInstanceOf(TerminalSessionError);
  await expect(service.startPreview(s.id, "bun dev")).rejects.toBeInstanceOf(TerminalSessionError);
  await expect(service.interrupt(s.id)).rejects.toBeInstanceOf(TerminalSessionError);
  await expect(service.relaunch(s.id)).rejects.toBeInstanceOf(TerminalSessionError);
  await expect(service.replaceAgent(s.id, { model: null })).rejects.toBeInstanceOf(
    TerminalSessionError,
  );
});

test("restore fence: an archived terminal cannot be restored — even when a newer live terminal exists", async () => {
  const { service, store } = makeSvc();
  const first = await service.create(TERM_INPUT);
  await service.archive(first.id);
  const second = await service.create(TERM_INPUT); // slot freed by the archive
  await expect(service.restore(first.id)).rejects.toBeInstanceOf(TerminalSessionError);
  // The live terminal is untouched and still the singleton holder.
  expect(store.get(second.id)?.status).not.toBe("archived");
  expect(store.getLiveTerminalSession("/repo")?.id).toBe(second.id);
});

test("herdr.send invariant: broadcast skips terminals (additive count), retryHalted skips, haltAll filters — zero sends", async () => {
  const { service, calls } = makeSvc();
  const s = await service.create(TERM_INPUT);

  const res = await service.broadcast([s.id, "ghost"], "run tests");
  expect(res).toEqual({ delivered: 0, queued: 0, offline: 1, skipped: 1, total: 2 });

  const retry = await service.retryHalted([s.id], "continue");
  expect(retry).toEqual({ resumed: 0, steered: 0, total: 1 });

  await service.haltAll();

  expect(calls.sends).toHaveLength(0); // the invariant itself
});

test("terminal teardown: archive closes the persisted tab — no agent stop, no worktree reap", async () => {
  const { service, calls, store } = makeSvc();
  const s = await service.create(TERM_INPUT);
  await service.archive(s.id);
  expect(calls.closedTabs).toEqual(["w1:t9"]);
  expect(calls.stops).toHaveLength(0);
  expect(calls.wtRemoves).toBe(0);
  expect(store.get(s.id)?.status).toBe("archived");
});

test("store lease: TTL reclaim only after the heartbeat goes silent; renewal keeps a slow create alive", () => {
  const store = new SessionStore(":memory:");
  const t0 = 1_000_000;
  expect(store.claimTerminalRepo("/r", "a", t0)).toEqual({ ok: true });
  // Within the lease, a rival is refused (no live session yet → existingId null).
  expect(store.claimTerminalRepo("/r", "b", t0 + TERMINAL_CLAIM_TTL_MS - 1)).toEqual({
    ok: false,
    existingId: null,
  });
  // Heartbeat renewal moves the staleness horizon — still refused past the original TTL.
  store.renewTerminalClaim("/r", "a", t0 + TERMINAL_CLAIM_TTL_MS - 1);
  expect(store.claimTerminalRepo("/r", "b", t0 + TERMINAL_CLAIM_TTL_MS + 1)).toEqual({
    ok: false,
    existingId: null,
  });
  // Silent past the TTL → reclaimable.
  expect(store.claimTerminalRepo("/r", "b", t0 + 2 * TERMINAL_CLAIM_TTL_MS)).toEqual({ ok: true });
  // Release is sessionId-matched: the evicted "a" cannot delete b's claim.
  store.releaseTerminalClaim("/r", "a");
  expect(store.claimTerminalRepo("/r", "c", t0 + 2 * TERMINAL_CLAIM_TTL_MS + 1)).toEqual({
    ok: false,
    existingId: null,
  });
  store.releaseTerminalClaim("/r", "b");
  expect(store.claimTerminalRepo("/r", "c", t0 + 2 * TERMINAL_CLAIM_TTL_MS + 2)).toEqual({
    ok: true,
  });
});

test("store: the partial unique index blocks a bypass second live terminal per repo", async () => {
  const { service, store } = makeSvc();
  const s = await service.create(TERM_INPUT);
  expect(() =>
    store.create({
      ...(store.get(s.id) as any),
      id: crypto.randomUUID(),
      name: "bypass",
    }),
  ).toThrow(); // sessions_terminal_singleton
});

test("store hydration: terminal pane target survives a restart-shaped re-read", () => {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-terminal-hydrate-"));
  const dbPath = join(dir, "s.db");
  try {
    const w = new SessionStore(dbPath);
    const s = w.create({
      id: crypto.randomUUID(),
      name: "terminal-repo",
      prompt: "",
      repoPath: "/repo",
      baseBranch: "",
      branch: null,
      worktreePath: "/repo",
      isolated: false,
      herdrSession: "h",
      herdrAgentId: "term_x",
      claudeSessionId: "",
      terminal: true,
      terminalTabId: "w1:t3",
      terminalPaneId: "w1:p3",
      model: null,
    } as any);
    const r = new SessionStore(dbPath); // fresh store over the same file = restart
    const row = r.get(s.id)!;
    expect(row.terminal).toBe(true);
    expect(row.terminalTabId).toBe("w1:t3");
    expect(row.terminalPaneId).toBe("w1:p3");
    expect(r.getLiveTerminalSession("/repo")?.id).toBe(s.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── poller pane-liveness state machine (fail-closed, 2-sweep debounce) ────────

function makeSweeper(panesImpl: () => Promise<{ paneId: string }[]>) {
  const store = new SessionStore(":memory:");
  const archived: string[] = [];
  const poller = new StatusPoller(
    store,
    { listAsync: async () => [], panesAsync: panesImpl } as any,
    () => {},
    () => {},
  );
  (poller as any).archiveTerminal = (id: string) => archived.push(id);
  const session = {
    id: "t1",
    terminal: true,
    terminalPaneId: "w1:p7",
  } as unknown as Session;
  // Bypass the throttle per invocation: each call below models one due sweep.
  const sweep = async () => {
    (poller as any).lastTerminalSweepAt = 0;
    await (poller as any).maybeSweepTerminalPanes([session]);
  };
  return { archived, sweep };
}

test("pane sweep: live pane → no archive, counter resets between misses", async () => {
  let panes = [{ paneId: "w1:p7" }];
  const { archived, sweep } = makeSweeper(async () => panes);
  await sweep();
  expect(archived).toHaveLength(0);
  panes = []; // one miss…
  await sweep();
  expect(archived).toHaveLength(0); // debounced — not archived yet
  panes = [{ paneId: "w1:p7" }]; // …pane is back → counter resets
  await sweep();
  panes = [];
  await sweep();
  expect(archived).toHaveLength(0); // a single miss after a reset never archives
});

test("pane sweep: two consecutive confirmed-gone sweeps archive exactly once", async () => {
  const { archived, sweep } = makeSweeper(async () => []);
  await sweep();
  expect(archived).toHaveLength(0);
  await sweep();
  expect(archived).toEqual(["t1"]);
  await sweep(); // counter was cleared on archive; a fresh double-miss would be a new episode
  expect(archived).toEqual(["t1", "t1"].slice(0, archived.length)); // no throw either way
});

test("pane sweep: a FAILED pane listing freezes state — no archive, no counter movement", async () => {
  let fail = true;
  const panes: { paneId: string }[] = [];
  const { archived, sweep } = makeSweeper(async () => {
    if (fail) throw new Error("herdr unreachable");
    return panes;
  });
  await sweep(); // gone? unknown — listing failed
  await sweep();
  await sweep();
  expect(archived).toHaveLength(0); // fail-closed: three failures, zero destructive actions
  fail = false;
  await sweep(); // first CONFIRMED miss
  expect(archived).toHaveLength(0);
  await sweep(); // second confirmed miss → archive
  expect(archived).toEqual(["t1"]);
});
