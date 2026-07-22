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
}) {
  const store = new SessionStore(":memory:");
  const s = store.create({
    ...base,
    sandboxApplied: opts?.sandboxApplied === undefined ? "standard" : opts.sandboxApplied,
    sandboxDegraded: opts?.sandboxDegraded ?? false,
  });
  const pushes: { paneId: string; agentName: string; state: string }[] = [];
  let clock = 1_700_000_000_000;
  const visible = opts?.visible ?? (() => "Computing… (1s)");
  // herdr agent is PINNED to `working` for the whole run — the frozen sandboxed case.
  const herdr = {
    list: (): HerdrAgent[] => [
      {
        agent: "claude",
        agentStatus: "working",
        cwd: "/wt",
        paneId: "p",
        tabId: "t",
        name: "task-01",
        terminalId: "term_a",
        workspaceId: "w",
      } as HerdrAgent,
    ],
    listAsync: () => Promise.resolve(herdr.list()),
    read: () => visible(),
    readAsync: () => Promise.resolve(visible()),
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
  );
  return {
    poller,
    store,
    pushes,
    id: s.id,
    advance: (ms: number) => (clock += ms),
    now: () => clock,
  };
}

afterEach(() => {
  setDetectedHerdrVersion(null);
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
