import { afterEach, expect, test } from "bun:test";
import { StatusPoller } from "../src/poller";
import { SessionStore } from "../src/store";
import type { HerdrAgent } from "../src/herdr";
import { classifyBlocked } from "../src/blocked";
import { setDetectedHerdrVersion } from "../src/herdr-capabilities";
import type { SandboxProfile } from "../src/sandbox";
import { config } from "../src/config";

// Issue #1891: for an externally-registered SANDBOXED 0.7.5 agent, herdr freezes `agent_status` at
// `working` (its pane/PID view is `bwrap`). These tests drive a session whose herdr agent stays
// `working` for the whole run — proving the state Shepherd pushes comes from ITS OWN classifier
// (maybeProbe activity + the hook awaiting-input block path), NOT from herdr advancing, and NOT from
// the herdr-`blocked`→`maybeClassify` route (which never fires on the frozen-`working` route).

const base = {
  name: "task-01",
  prompt: "x",
  repoPath: "/r",
  baseBranch: "main",
  branch: "shepherd/x",
  worktreePath: "/wt",
  isolated: true,
  herdrSession: "default",
  herdrAgentId: "term_a",
};

/** Let the fire-and-forget push chain (`.catch`/`.finally`, which clears `pushInFlight` and
 *  re-evaluates) settle before the next tick/assertion. */
const flush = () => new Promise((r) => setTimeout(r, 0));

function harness(opts?: {
  sandboxApplied?: SandboxProfile | null;
  sandboxDegraded?: boolean;
  visible?: () => string;
  /** herdr's list `name` field for the agent. Real herdr leaves this EMPTY for externally-registered
   *  agents (it stores the label in `agent`), so default to "" to mirror production. */
  herdrListName?: string;
  /** Is the registered agent still in herdr's list? (default: always) */
  present?: () => boolean;
  /** herdr's reported `agentStatus` (default: pinned `working`, the frozen 0.7.5 case). */
  agentStatus?: () => string;
  /** Model herdr ≥0.8 honouring the push: the status follows the last pushed state, and a pushed
   *  `idle` reads back as `done` (docs/herdr-compat/0.9.5.md L7). Overrides `agentStatus`. */
  herdrFollowsPush?: boolean;
  /** A visible-buffer read that fails (pane unreadable). */
  readFails?: boolean;
  /** Start the clock this long after the session's `createdAt` (default: the fixed 2023 clock,
   *  i.e. before `createdAt`, so the spawn grace always applies). */
  ageMs?: number;
  /** herdr's status before any push under `herdrFollowsPush` (default: the registered `working`). */
  initialStatus?: string;
}) {
  const store = new SessionStore(":memory:");
  const s = store.create({
    ...base,
    sandboxApplied: opts?.sandboxApplied === undefined ? "standard" : opts.sandboxApplied,
    sandboxDegraded: opts?.sandboxDegraded ?? false,
  });
  const pushes: { paneId: string; agentName: string; state: string }[] = [];
  let clock = opts?.ageMs === undefined ? 1_700_000_000_000 : s.createdAt + opts.ageMs;
  const visible = opts?.visible ?? (() => "Computing… (1s)");
  let reads = 0;
  const agentStatus = (): string => {
    if (opts?.herdrFollowsPush) {
      const last = pushes.at(-1)?.state ?? opts.initialStatus ?? "working";
      return last === "idle" ? "done" : last;
    }
    return opts?.agentStatus?.() ?? "working";
  };
  // herdr agent is PINNED to `working` for the whole run by default — the frozen sandboxed case.
  const herdr = {
    list: (): HerdrAgent[] =>
      opts?.present && !opts.present()
        ? []
        : [
            {
              agent: "claude",
              agentStatus: agentStatus(),
              cwd: "/wt",
              paneId: "p",
              tabId: "t",
              name: opts?.herdrListName ?? "",
              terminalId: "term_a",
              workspaceId: "w",
            } as HerdrAgent,
          ],
    listAsync: () => Promise.resolve(herdr.list()),
    readAsync: () => {
      reads++;
      return opts?.readFails
        ? Promise.reject(new Error("pane unreadable"))
        : Promise.resolve(visible());
    },
    reportAgentState: (paneId: string, agentName: string, state: string) => {
      pushes.push({ paneId, agentName, state });
      return Promise.resolve();
    },
  };
  const poller = new StatusPoller(
    store,
    herdr as never,
    () => {},
    () => {},
    1000,
    3000,
    classifyBlocked,
    () => clock,
    () => ({ snapshot: null, activity: null }),
    // Realistic stall windows so a quiet-but-static terminal reads idle, not a spurious stall block.
    { stallMs: 8 * 60_000, pendingStallMs: 20 * 60_000 },
    7000, // probeCheckMs
    undefined, // onReady
    undefined, // onActivity
    undefined, // preview (disabled)
    // The agent's process is alive (a sandboxed claude is visible to the host /proc scan), so the
    // resting pane read runs — the default real scan would find no claude under "/wt".
    { scan: (worktrees) => new Map(worktrees.map((w) => [w, true])) },
  );
  return {
    poller,
    store,
    pushes,
    id: s.id,
    advance: (ms: number) => (clock += ms),
    now: () => clock,
    reads: () => reads,
    /** Tick once per simulated second for `ms`, settling each tick's async reads and pushes. */
    runFor: async (ms: number) => {
      for (let t = 0; t < ms; t += 1000) {
        clock += 1000;
        await poller.tick();
        await flush();
      }
    },
  };
}

/** A live Claude Code turn: a glyph-anchored spinner whose elapsed counter ticks on every read
 *  (what `hasActiveSpinner` matches and the frozen-screen guard expects to move). */
function liveSpinner(): () => string {
  let s = 60;
  return () => `✻ Thinking… (${Math.floor(s / 60)}m ${s++ % 60}s · ↓ 3.1k tokens)\n\n❯ \n`;
}

/** The at-rest prompt: no spinner line. */
const restingScreen = () => "● Done.\n\n❯ \n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n";

afterEach(() => {
  setDetectedHerdrVersion(null);
});

test("label: pushes under the session-derived name even when herdr's list `name` is empty (#1891 bug)", async () => {
  // Real herdr leaves the list `name` EMPTY for externally-registered agents (the label lives in the
  // `agent` field). The push must use the session name, sanitized to the registered label — NOT the
  // empty `agent.name` (which made every `report-agent --agent ` fail, so #1891 never advanced state).
  setDetectedHerdrVersion("0.7.5");
  const h = harness({ herdrListName: "" });
  await h.poller.tick();
  await flush();
  expect(h.pushes.at(0)?.agentName).toBe("task-01"); // sanitizeHerdrAgentName(session.name)
  expect(h.pushes.every((p) => p.agentName.length > 0)).toBe(true); // never an empty --agent
});

test("pushes working (baseline) then idle when the turn goes quiet — herdr status stays working", async () => {
  setDetectedHerdrVersion("0.7.5");
  const h = harness();

  // First tick populates the match; a never-observed turn reads working (registration baseline).
  await h.poller.tick();
  await flush();
  expect(h.pushes).toEqual([{ paneId: "p", agentName: "task-01", state: "working" }]);

  // A live turn: hook activity refreshes the working stamp; still working → deduped, no re-push.
  const orig = config.hooksSignals;
  config.hooksSignals = true;
  try {
    h.poller.ingestActivity(h.id, { toolName: "Edit", status: "ok", ts: h.now() });
    await flush();
    expect(h.pushes).toHaveLength(1);

    // Turn goes quiet past 2× probeCheckMs → derived idle → pushed on the same tick it is derived.
    h.advance(15_000);
    await h.poller.tick();
    await flush();
    expect(h.pushes.at(-1)).toEqual({ paneId: "p", agentName: "task-01", state: "idle" });
  } finally {
    config.hooksSignals = orig;
  }
});

test("pushes blocked on the awaiting-input early-return, same tick, without herdr reporting blocked", async () => {
  setDetectedHerdrVersion("0.7.5");
  const orig = config.hooksSignals;
  config.hooksSignals = true;
  try {
    // TUI shows a menu, but herdr status stays `working` (frozen) — the push notification, not
    // herdr's latch, must surface the block.
    const h = harness({ visible: () => "❯ 1. Yes\n  2. No" });
    await h.poller.tick(); // baseline working
    await flush();
    expect(h.pushes.at(-1)?.state).toBe("working");

    h.poller.ingestNotification(h.id, "permission_prompt");
    h.advance(5000);
    await h.poller.tick(); // tryHookAwaitingBlock → maybeClassify → emitBlock → push, then early-return
    await flush();
    expect(h.pushes.at(-1)).toEqual({ paneId: "p", agentName: "task-01", state: "blocked" });
    // Confirm herdr never advanced the agent itself — the push is Shepherd's own derivation.
    expect(h.store.get(h.id)?.status).toBe("running"); // mapState("working")
  } finally {
    config.hooksSignals = orig;
  }
});

test("push-on-change dedup: an unchanged derived state is pushed only once", async () => {
  setDetectedHerdrVersion("0.7.5");
  const h = harness();
  await h.poller.tick();
  await flush();
  await h.poller.tick(); // still working, still quiet-but-unobserved → no state change
  await flush();
  await h.poller.tick();
  await flush();
  expect(h.pushes).toEqual([{ paneId: "p", agentName: "task-01", state: "working" }]);
});

test("gate: no push on herdr ≤ 0.7.4 (non-external-registration path)", async () => {
  setDetectedHerdrVersion("0.7.4");
  const h = harness();
  await h.poller.tick();
  await h.advance(15_000);
  await h.poller.tick();
  await flush();
  expect(h.pushes).toEqual([]);
});

test("gate: no push for a trusted (non-sandboxed) 0.7.5 session", async () => {
  setDetectedHerdrVersion("0.7.5");
  const h = harness({ sandboxApplied: "trusted" });
  await h.poller.tick();
  await flush();
  expect(h.pushes).toEqual([]);
});

test("gate: no push for a degraded sandbox (requested but ran unconfined)", async () => {
  setDetectedHerdrVersion("0.7.5");
  const h = harness({ sandboxApplied: "standard", sandboxDegraded: true });
  await h.poller.tick();
  await flush();
  expect(h.pushes).toEqual([]);
});

test("herdr 0.9.2 (#4687): a sandboxed agent dropped after its exit is reaped to done and never pushed again", async () => {
  // 0.9.2 drops a self-reported agent once its pane's shell is idle again — i.e. as soon as the
  // sandboxed claude exits. The session then reads like any gone agent: status `done`, and with no
  // matched pane there is nothing to push state to (a push would re-register a dead agent).
  setDetectedHerdrVersion("0.7.5");
  let present = true;
  const h = harness({ present: () => present });
  await h.poller.tick();
  await flush();
  expect(h.pushes).toHaveLength(1); // the registration baseline, while the agent is listed

  present = false;
  h.advance(15_000); // long past the quiet window that would otherwise derive (and push) idle
  await h.poller.tick();
  await flush();
  expect(h.store.get(h.id)?.status).toBe("done");
  expect(h.pushes).toHaveLength(1);

  h.advance(15_000);
  await h.poller.tick();
  await flush();
  expect(h.pushes).toHaveLength(1);
});

// The idle down-edge of a Shepherd-owned (sandboxed) session must be confirmed by the terminal: a
// turn can think or run one tool for minutes with no hook and no transcript record, and herdr ≥0.8
// turns a pushed `idle` into `done` — the chat then shows the session as finished mid-turn.

test("mid-turn: a quiet stretch with a live spinner on screen is never pushed idle", async () => {
  setDetectedHerdrVersion("0.7.5");
  const h = harness({ visible: liveSpinner(), herdrFollowsPush: true });
  await h.poller.tick(); // registration baseline: working
  await flush();
  h.poller.ingestActivity(h.id, { toolName: "ToolSearch", status: "ok", ts: h.now() });

  await h.runFor(60_000); // four freshness windows of pure thinking, no hook
  expect(h.pushes.map((p) => p.state)).toEqual(["working"]);
  expect(h.store.get(h.id)?.status).toBe("running");
});

test("quiet stretch with no spinner on screen is pushed idle once the read confirms it", async () => {
  setDetectedHerdrVersion("0.7.5");
  const h = harness({ visible: restingScreen });
  await h.poller.tick();
  await flush();
  h.poller.ingestActivity(h.id, { toolName: "Edit", status: "ok", ts: h.now() });

  await h.runFor(15_000);
  expect(h.pushes.map((p) => p.state)).toEqual(["working", "idle"]);
});

test("a frozen spinner-shaped screen keeps working for one read, then is confirmed idle", async () => {
  setDetectedHerdrVersion("0.7.5");
  const frozen = "✻ Thinking… (1m 2s · ↓ 3.1k tokens)\n\n❯ \n";
  const h = harness({ visible: () => frozen, herdrFollowsPush: true });
  await h.poller.tick();
  await flush();
  h.poller.ingestActivity(h.id, { toolName: "Bash", status: "ok", ts: h.now() });

  await h.runFor(14_000); // freshness lapses: first sighting of the spinner → still working
  expect(h.pushes.map((p) => p.state)).toEqual(["working"]);

  await h.runFor(15_000); // the next confirm read sees the identical buffer → not a live turn
  expect(h.pushes.map((p) => p.state)).toEqual(["working", "idle"]);

  // At rest the same frozen screen is never mistaken for a new turn.
  await h.runFor(30_000);
  expect(h.pushes.map((p) => p.state)).toEqual(["working", "idle"]);
  expect(h.store.get(h.id)?.status).toBe("done");
});

test("an unreadable pane is never pushed idle, and the confirm read is throttled", async () => {
  setDetectedHerdrVersion("0.7.5");
  const h = harness({ readFails: true });
  await h.poller.tick();
  await flush();
  h.poller.ingestActivity(h.id, { toolName: "Bash", status: "ok", ts: h.now() });

  await h.runFor(14_000); // up to the freshness lapse
  const before = h.reads();
  await h.runFor(30_000); // 30 ticks past the lapse, every confirm read failing
  expect(h.pushes.map((p) => p.state)).toEqual(["working"]);
  // One confirm read per reclassifyMs (3 s) plus the running probe's interim read per 7 s — far
  // below one read per tick.
  expect(h.reads() - before).toBeLessThanOrEqual(16);
});

test("at rest: a new turn's live spinner is pushed working without waiting for a tool hook", async () => {
  setDetectedHerdrVersion("0.7.5");
  let screen: () => string = restingScreen;
  const h = harness({ visible: () => screen(), herdrFollowsPush: true });
  await h.poller.tick();
  await flush();
  h.poller.ingestActivity(h.id, { toolName: "Edit", status: "ok", ts: h.now() });
  await h.runFor(16_000);
  expect(h.pushes.at(-1)?.state).toBe("idle");
  expect(h.store.get(h.id)?.status).toBe("done");

  // The operator's chat message starts a turn that only thinks — no hook arrives.
  screen = liveSpinner();
  await h.runFor(5_000);
  expect(h.pushes.at(-1)?.state).toBe("working");
  expect(h.store.get(h.id)?.status).toBe("running");
});

test("a trusted session at rest is never pushed, even with a live spinner on screen", async () => {
  setDetectedHerdrVersion("0.7.5");
  const h = harness({
    sandboxApplied: "trusted",
    visible: liveSpinner(),
    agentStatus: () => "done",
  });
  await h.runFor(10_000);
  expect(h.pushes).toEqual([]);
});

// A session already at rest when the poller first sees it — Shepherd restarted (deploy) while it
// idled — must settle via the terminal confirm, not stay on the assumed `working` forever.

test("restart at rest: an old resting session is pushed idle, never working", async () => {
  setDetectedHerdrVersion("0.7.5");
  const h = harness({
    visible: restingScreen,
    herdrFollowsPush: true,
    initialStatus: "done",
    ageMs: 3_600_000,
  });
  await h.runFor(60_000);
  expect(h.pushes.map((p) => p.state)).toEqual(["idle"]);
  expect(h.store.get(h.id)?.status).toBe("done");
});

test("restart with herdr frozen working: a resting screen is confirmed idle", async () => {
  setDetectedHerdrVersion("0.7.5");
  const h = harness({ visible: restingScreen, herdrFollowsPush: true, ageMs: 3_600_000 });
  await h.runFor(60_000);
  expect(h.pushes.map((p) => p.state)).toEqual(["idle"]);
  expect(h.store.get(h.id)?.status).toBe("done");
});

test("restart mid-turn: a live spinner keeps an old session working", async () => {
  setDetectedHerdrVersion("0.7.5");
  const h = harness({ visible: liveSpinner(), herdrFollowsPush: true, ageMs: 3_600_000 });
  await h.runFor(60_000);
  expect(h.pushes.map((p) => p.state)).not.toContain("idle");
  expect(h.store.get(h.id)?.status).toBe("running");
});

test("fresh spawn: reads working through the boot grace, then is confirmed idle", async () => {
  setDetectedHerdrVersion("0.7.5");
  const h = harness({ visible: restingScreen, herdrFollowsPush: true, ageMs: 0 });
  await h.runFor(55_000);
  expect(h.pushes.map((p) => p.state)).toEqual(["working"]);
  await h.runFor(15_000);
  expect(h.pushes.map((p) => p.state)).toEqual(["working", "idle"]);
  expect(h.store.get(h.id)?.status).toBe("done");
});

test("idle compaction at rest: pushed working while compacting, then back to idle", async () => {
  setDetectedHerdrVersion("0.7.5");
  let screen: () => string = restingScreen;
  const h = harness({ visible: () => screen(), herdrFollowsPush: true });
  await h.poller.tick();
  await flush();
  h.poller.ingestActivity(h.id, { toolName: "Edit", status: "ok", ts: h.now() });
  await h.runFor(16_000);
  expect(h.pushes.at(-1)?.state).toBe("idle");

  let n = 1;
  screen = () => `✻ Compacting conversation… (${n++}s · ↓ 1k tokens)\n\n❯ \n`;
  await h.runFor(40_000);
  expect(h.pushes.at(-1)?.state).toBe("working");

  screen = () => "● Compacted while idle, before the prompt cache expired\n\n❯ \n";
  await h.runFor(60_000);
  expect(h.pushes.at(-1)?.state).toBe("idle");
  expect(h.store.get(h.id)?.status).toBe("done");
});
