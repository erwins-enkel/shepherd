import { afterEach, describe, expect, test } from "bun:test";
import {
  HEAVY_SCOPE_SLICE,
  __resetHeavyScope,
  heavyScopeEnabled,
  heavyScopeOutcome,
  heavyScopeUnit,
  reapHeavyScopes,
  refreshHeavyScope,
  startHeavyScope,
  startTransientArgv,
} from "../src/heavy-scope";

const JOB = "0b5f6c1e-1d2a-4c3b-9e8f-7a6b5c4d3e2f";
const UNIT = `shepherd-heavy-${JOB}.scope`;
const GIB = 1024 ** 3;

/** A fake `run` that records every call and succeeds with empty stdout. */
function record(calls: string[][]) {
  return async (bin: string, args: string[]) => {
    calls.push([bin, ...args]);
    return "";
  };
}

/** A fake clock that `sleep` advances, so poll deadlines run instantly. */
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

describe("heavyScopeUnit", () => {
  test("UUID job id ⇒ its scope unit", () => {
    expect(heavyScopeUnit(JOB)).toBe(UNIT);
  });
  test("anything that could escape the unit name ⇒ null", () => {
    for (const bad of ["", "a/b", "a b", "x.scope", "*", "a".repeat(65)])
      expect(heavyScopeUnit(bad)).toBeNull();
  });
});

describe("startTransientArgv", () => {
  test("the exact busctl call: PIDs, nested slice, hard limit, no swap, stop on OOM", () => {
    expect(startTransientArgv(UNIT, [41, 42], 8 * GIB)).toEqual([
      "--user",
      "call",
      "org.freedesktop.systemd1",
      "/org/freedesktop/systemd1",
      "org.freedesktop.systemd1.Manager",
      "StartTransientUnit",
      "ssa(sv)a(sa(sv))",
      UNIT,
      "fail",
      "6",
      "PIDs",
      "au",
      "2",
      "41",
      "42",
      "Slice",
      "s",
      HEAVY_SCOPE_SLICE,
      "Description",
      "s",
      "Shepherd heavy check (#3555)",
      "MemoryMax",
      "t",
      String(8 * GIB),
      "MemorySwapMax",
      "t",
      "0",
      "OOMPolicy",
      "s",
      "stop",
      "0",
    ]);
    expect(HEAVY_SCOPE_SLICE).toBe("shepherd_agents-heavy.slice");
  });
});

describe("startHeavyScope", () => {
  test("busctl ok and the pid shows up in the unit's cgroup ⇒ true", async () => {
    const calls: string[][] = [];
    let reads = 0;
    const ok = await startHeavyScope(JOB, [41], GIB, {
      ...clock(),
      run: record(calls),
      readCgroup: async () =>
        ++reads < 3
          ? "0::/user.slice/shepherd_agents.slice/run-x.scope\n"
          : `0::/user.slice/shepherd_agents.slice/${HEAVY_SCOPE_SLICE}/${UNIT}\n`,
    });
    expect(ok).toBe(true);
    expect(calls).toEqual([["busctl", ...startTransientArgv(UNIT, [41], GIB)]]);
    expect(reads).toBe(3);
  });

  test("the move never lands within the wait ⇒ false", async () => {
    const ok = await startHeavyScope(JOB, [41], GIB, {
      ...clock(),
      run: async () => "",
      readCgroup: async () => "0::/user.slice/shepherd_agents.slice/run-x.scope\n",
    });
    expect(ok).toBe(false);
  });

  test("busctl fails, the process is gone, or the input is bad ⇒ false, without polling", async () => {
    const fail = { ...clock(), run: async () => Promise.reject(new Error("no bus")) };
    expect(await startHeavyScope(JOB, [41], GIB, fail)).toBe(false);
    const gone = {
      ...clock(),
      run: async () => "",
      readCgroup: async () => Promise.reject(new Error("ENOENT")),
    };
    expect(await startHeavyScope(JOB, [41], GIB, gone)).toBe(false);
    const never = { run: async () => Promise.reject(new Error("must not run")) };
    expect(await startHeavyScope("../x", [41], GIB, never)).toBe(false);
    expect(await startHeavyScope(JOB, [], GIB, never)).toBe(false);
    expect(await startHeavyScope(JOB, [0], GIB, never)).toBe(false);
    expect(await startHeavyScope(JOB, [41], 0, never)).toBe(false);
  });
});

describe("heavyScopeOutcome", () => {
  function host(states: string[], calls: string[][] = []) {
    let i = 0;
    return {
      ...clock(),
      run: async (bin: string, args: string[]) => {
        calls.push([bin, ...args]);
        if (args[1] === "show") return states[Math.min(i++, states.length - 1)]!;
        return "";
      },
    };
  }

  test("Result=oom-kill ⇒ oom, then the failed unit is reset", async () => {
    const calls: string[][] = [];
    const deps = host(["Result=oom-kill\nActiveState=failed\nLoadState=loaded\n"], calls);
    expect(await heavyScopeOutcome(JOB, deps)).toBe("oom");
    expect(calls).toEqual([
      ["systemctl", "--user", "show", "-p", "Result,ActiveState,LoadState", UNIT],
      ["systemctl", "--user", "reset-failed", UNIT],
    ]);
  });

  test("still stopping when the runner reports ⇒ waits for the settled result", async () => {
    const deps = host([
      "Result=success\nActiveState=deactivating\nLoadState=loaded\n",
      "Result=oom-kill\nActiveState=failed\nLoadState=loaded\n",
    ]);
    expect(await heavyScopeOutcome(JOB, deps)).toBe("oom");
  });

  test("ended cleanly ⇒ ok; collected or unreadable ⇒ unknown", async () => {
    expect(
      await heavyScopeOutcome(
        JOB,
        host(["Result=success\nActiveState=inactive\nLoadState=loaded"]),
      ),
    ).toBe("ok");
    expect(
      await heavyScopeOutcome(
        JOB,
        host(["Result=success\nActiveState=inactive\nLoadState=not-found"]),
      ),
    ).toBe("unknown");
    expect(await heavyScopeOutcome(JOB, host([""]))).toBe("unknown");
  });

  test("lingering processes keep it active ⇒ unknown after the bounded wait", async () => {
    expect(
      await heavyScopeOutcome(JOB, host(["Result=success\nActiveState=active\nLoadState=loaded"])),
    ).toBe("unknown");
  });
});

test("reapHeavyScopes resets every failed heavy scope", async () => {
  const calls: string[][] = [];
  await reapHeavyScopes({ run: record(calls) });
  expect(calls).toEqual([["systemctl", "--user", "reset-failed", "shepherd-heavy-*.scope"]]);
});

describe("refreshHeavyScope", () => {
  afterEach(() => __resetHeavyScope());
  const busctl = async () => "systemd 262\n";

  test("Linux + agent scopes + busctl ⇒ open", async () => {
    expect(
      await refreshHeavyScope({ platform: "linux", agentScopes: () => true, run: busctl }),
    ).toBe(true);
    expect(heavyScopeEnabled()).toBe(true);
  });

  test("macOS, agent scopes off, or no busctl ⇒ closed", async () => {
    expect(
      await refreshHeavyScope({ platform: "darwin", agentScopes: () => true, run: busctl }),
    ).toBe(false);
    expect(
      await refreshHeavyScope({ platform: "linux", agentScopes: () => false, run: busctl }),
    ).toBe(false);
    expect(
      await refreshHeavyScope({
        platform: "linux",
        agentScopes: () => true,
        run: async () => Promise.reject(new Error("ENOENT")),
      }),
    ).toBe(false);
    expect(heavyScopeEnabled()).toBe(false);
  });
});
