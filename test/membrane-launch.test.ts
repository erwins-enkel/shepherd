import { test, expect, describe, beforeEach } from "bun:test";
import {
  probeMembraneLaunch,
  readMembraneLaunchFacts,
  resetMembraneLaunchCache,
  membraneAgentOf,
  MembraneProbeUnwiredError,
  type CapturedRun,
  type MembraneLaunchEnv,
} from "../src/membrane-launch";
import { classifyMembraneLaunch } from "../src/diagnostics";

const ENV: MembraneLaunchEnv = {
  claudeDir: "/home/me/.claude",
  home: "/home/me",
  nodeBinReal: "/usr/bin/node",
};

/** A capture stub that records what it was asked to spawn. `throws` models a probe that cannot run
 *  at all (bwrap gone, timeout) as distinct from a launcher that ran and exited non-zero. */
function capture(result: CapturedRun, throws?: string) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const runCapture = async (cmd: string, args: string[]): Promise<CapturedRun> => {
    calls.push({ cmd, args });
    if (throws !== undefined) throw new Error(throws);
    return result;
  };
  return { calls, runCapture };
}

const OK: CapturedRun = { status: 0, output: "2.1.237 (Claude Code)\n" };
const EROFS: CapturedRun = {
  status: 1,
  output: "mise ERROR failed to rebuild shims\nmise ERROR Read-only file system (os error 30)\n",
};

beforeEach(() => resetMembraneLaunchCache());

describe("membraneAgentOf", () => {
  test("narrows the argv head to a known agent", () => {
    expect(membraneAgentOf(["claude", "-p", "x"])).toBe("claude");
    expect(membraneAgentOf(["codex", "exec"])).toBe("codex");
  });

  test("null for anything the probe cannot speak to", () => {
    expect(membraneAgentOf(["bash", "-c", "x"])).toBeNull();
    expect(membraneAgentOf([])).toBeNull();
  });
});

describe("probeMembraneLaunch", () => {
  test("exit 0 inside the membrane → ok", async () => {
    const c = capture(OK);
    expect(await probeMembraneLaunch("claude", "bwrap", ENV, c)).toEqual({ state: "ok" });
  });

  test("non-zero exit → broken, carrying the captured tail", async () => {
    const c = capture(EROFS);
    const r = await probeMembraneLaunch("claude", "bwrap", ENV, c);
    expect(r.state).toBe("broken");
    if (r.state !== "broken") throw new Error("unreachable");
    expect(r.detail).toContain("Read-only file system");
  });

  test("wraps `<agent> --version` in a REAL membrane (bwrap flags, then -- then the argv)", async () => {
    const c = capture(OK);
    await probeMembraneLaunch("claude", "bwrap", ENV, c);
    expect(c.calls).toHaveLength(1);
    const { cmd, args } = c.calls[0]!;
    expect(cmd).toBe("bwrap");
    const sep = args.indexOf("--");
    expect(sep).toBeGreaterThan(0); // real membrane flags precede the separator
    expect(args.slice(sep + 1)).toEqual(["claude", "--version"]);
    expect(args).toContain("--clearenv"); // the derived membrane, not a bare spawn
  });

  test("a codex argv gets the codex binds (membraneForArgv keys off argv[0])", async () => {
    const c = capture(OK);
    await probeMembraneLaunch("codex", "bwrap", ENV, c);
    const args = c.calls[0]!.args;
    expect(args.slice(args.indexOf("--") + 1)).toEqual(["codex", "--version"]);
  });

  test("FAIL-OPEN: a throwing spawn is uninspectable, never broken", async () => {
    const c = capture(OK, "bwrap vanished");
    expect(await probeMembraneLaunch("claude", "bwrap", ENV, c)).toEqual({
      state: "uninspectable",
    });
  });

  test("no backend → ok without spawning (nothing is wrapped, so nothing to prove)", async () => {
    const c = capture(EROFS);
    expect(await probeMembraneLaunch("claude", null, ENV, c)).toEqual({ state: "ok" });
    expect(c.calls).toHaveLength(0);
  });

  test("caches per agent inside the TTL", async () => {
    const c = capture(OK);
    await probeMembraneLaunch("claude", "bwrap", ENV, { ...c, now: () => 1000 });
    await probeMembraneLaunch("claude", "bwrap", ENV, { ...c, now: () => 1500 });
    expect(c.calls).toHaveLength(1);
    // a DIFFERENT agent is a separate cache entry
    await probeMembraneLaunch("codex", "bwrap", ENV, { ...c, now: () => 1500 });
    expect(c.calls).toHaveLength(2);
  });

  test("re-probes once the TTL expires, so a repaired host un-blocks without a restart", async () => {
    const c = capture(EROFS);
    const first = await probeMembraneLaunch("claude", "bwrap", ENV, {
      ...c,
      now: () => 1000,
      ttlMs: 100,
    });
    expect(first.state).toBe("broken");
    const healed = capture(OK);
    const second = await probeMembraneLaunch("claude", "bwrap", ENV, {
      ...healed,
      now: () => 1101,
      ttlMs: 100,
    });
    expect(second).toEqual({ state: "ok" });
  });

  test("resetMembraneLaunchCache forces a re-probe", async () => {
    const c = capture(OK);
    await probeMembraneLaunch("claude", "bwrap", ENV, c);
    resetMembraneLaunchCache();
    await probeMembraneLaunch("claude", "bwrap", ENV, c);
    expect(c.calls).toHaveLength(2);
  });

  // The tripwire (#2111): the default runCapture spawns bwrap for real. Under NODE_ENV=test it
  // throws instead, and that throw is EXEMPT from fail-open — otherwise an un-injected seam would
  // resolve to `uninspectable`, the spawn would proceed, and the test would stay green while
  // touching the host.
  test("un-injected runCapture throws under NODE_ENV=test instead of spawning bwrap", async () => {
    expect(process.env.NODE_ENV).toBe("test"); // the tripwire's precondition
    await expect(probeMembraneLaunch("claude", "bwrap", ENV)).rejects.toThrow(
      MembraneProbeUnwiredError,
    );
  });
});

describe("readMembraneLaunchFacts", () => {
  test("probes every agent binary present on PATH", async () => {
    const c = capture(OK);
    const facts = await readMembraneLaunchFacts(ENV, {
      ...c,
      detectBackend: () => "bwrap",
      which: () => "/bin/stub",
    });
    expect(facts.backend).toBe("bwrap");
    expect(facts.agents).toEqual([
      { agent: "claude", state: "ok" },
      { agent: "codex", state: "ok" },
    ]);
  });

  test("omits an agent that is not on PATH", async () => {
    const c = capture(OK);
    const facts = await readMembraneLaunchFacts(ENV, {
      ...c,
      detectBackend: () => "bwrap",
      which: (cmd) => (cmd === "claude" ? "/bin/claude" : null),
    });
    expect(facts.agents).toEqual([{ agent: "claude", state: "ok" }]);
  });

  // #2111 follow-up: `DiagnosticsService.check` promises a forced fresh run, so the DIAGNOSE read
  // must not answer from a verdict up to a minute old — an operator who repairs the toolchain and
  // hits Re-run has to see the row clear immediately.
  test("forces a fresh probe, ignoring a warm TTL cache", async () => {
    const stale = capture(EROFS);
    expect((await probeMembraneLaunch("claude", "bwrap", ENV, stale)).state).toBe("broken");
    const healed = capture(OK);
    const facts = await readMembraneLaunchFacts(ENV, {
      ...healed,
      detectBackend: () => "bwrap",
      which: (cmd) => (cmd === "claude" ? "/bin/claude" : null),
    });
    expect(facts.agents).toEqual([{ agent: "claude", state: "ok" }]);
    expect(healed.calls).toHaveLength(1); // re-probed rather than read the cached `broken`
  });

  test("refills the cache the spawn-refusal path reads, so the two cannot disagree", async () => {
    const stale = capture(EROFS);
    await probeMembraneLaunch("claude", "bwrap", ENV, stale);
    const healed = capture(OK);
    await readMembraneLaunchFacts(ENV, {
      ...healed,
      detectBackend: () => "bwrap",
      which: (cmd) => (cmd === "claude" ? "/bin/claude" : null),
    });
    // The spawn path now reads `ok` from the cache the DIAGNOSE read just refilled — no new spawn.
    const after = capture(EROFS);
    expect(await probeMembraneLaunch("claude", "bwrap", ENV, after)).toEqual({ state: "ok" });
    expect(after.calls).toHaveLength(0);
  });

  test("no backend → no agents probed at all", async () => {
    const c = capture(OK);
    const facts = await readMembraneLaunchFacts(ENV, {
      ...c,
      detectBackend: () => null,
      which: () => "/bin/stub",
    });
    expect(facts).toEqual({ backend: null, agents: [] });
    expect(c.calls).toHaveLength(0);
  });
});

describe("classifyMembraneLaunch", () => {
  test("no backend → no row (nothing is wrapped on this host)", () => {
    expect(classifyMembraneLaunch({ backend: null, agents: [] })).toBeNull();
  });

  test("no agent CLI → no row (the claude/codex rows already say so)", () => {
    expect(classifyMembraneLaunch({ backend: "bwrap", agents: [] })).toBeNull();
  });

  test("all agents launch → ok", () => {
    const c = classifyMembraneLaunch({
      backend: "bwrap",
      agents: [
        { agent: "claude", state: "ok" },
        { agent: "codex", state: "ok" },
      ],
    });
    expect(c).toEqual({
      id: "sandbox_membrane",
      state: "ok",
      hintKey: "diagnostics_hint_sandbox_membrane_ok",
    });
  });

  test("a broken agent → error naming it, and NOTHING else in the payload", () => {
    const c = classifyMembraneLaunch({
      backend: "bwrap",
      agents: [
        { agent: "claude", state: "broken" },
        { agent: "codex", state: "ok" },
      ],
    });
    expect(c?.state).toBe("error");
    expect(c?.hintKey).toBe("diagnostics_hint_sandbox_membrane_broken");
    // payload purity: the agent NAME only — never the captured tail, which carries host paths.
    expect(c?.hintParams).toEqual({ agent: "claude" });
    expect(c?.remediation).toBeUndefined(); // guidance-only, like claude_install
    expect(c?.fixActionKey).toBeUndefined();
  });

  test("broken outranks uninspectable", () => {
    const c = classifyMembraneLaunch({
      backend: "bwrap",
      agents: [
        { agent: "claude", state: "uninspectable" },
        { agent: "codex", state: "broken" },
      ],
    });
    expect(c?.state).toBe("error");
    expect(c?.hintParams).toEqual({ agent: "codex" });
  });

  test("uninspectable alone → optional, never a false ok and never a pip degrade", () => {
    const c = classifyMembraneLaunch({
      backend: "bwrap",
      agents: [{ agent: "claude", state: "uninspectable" }],
    });
    expect(c).toEqual({
      id: "sandbox_membrane",
      state: "optional",
      hintKey: "diagnostics_hint_sandbox_membrane_uninspectable",
    });
  });
});
