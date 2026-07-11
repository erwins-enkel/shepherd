import { test, expect, describe } from "bun:test";
import {
  resolveNodeHost,
  TailscaleServeService,
  type TailscaleRunner,
  type TailscaleRunnerSync,
} from "../src/tailscale";

// ── resolveNodeHost ───────────────────────────────────────────────────────────

const REALISTIC_STATUS = JSON.stringify({
  Self: {
    HostName: "agentnode",
    DNSName: "agentnode.example.ts.net.",
    OS: "linux",
    TailscaleIPs: ["100.64.0.1"],
    Online: true,
  },
  Peers: {},
  MagicDNSSuffix: "example.ts.net",
  CurrentTailnet: {},
});

describe("resolveNodeHost", () => {
  test("parses Self.DNSName and strips trailing dot", async () => {
    const run = async () => ({ stdout: REALISTIC_STATUS });
    const result = await resolveNodeHost(run);
    expect(result).toBe("agentnode.example.ts.net");
  });

  test("returns null when runner rejects (tailscale absent / not running)", async () => {
    const run = async (): Promise<{ stdout: string }> => {
      throw new Error("spawn tailscale ENOENT");
    };
    const result = await resolveNodeHost(run);
    expect(result).toBeNull();
  });

  test("returns null when stdout is not valid JSON", async () => {
    const run = async () => ({ stdout: "not json at all" });
    const result = await resolveNodeHost(run);
    expect(result).toBeNull();
  });

  test("returns null when Self is missing", async () => {
    const run = async () => ({ stdout: JSON.stringify({ MagicDNSSuffix: "ts.net" }) });
    const result = await resolveNodeHost(run);
    expect(result).toBeNull();
  });

  test("returns null when Self.DNSName is missing", async () => {
    const run = async () => ({
      stdout: JSON.stringify({ Self: { HostName: "agentnode" } }),
    });
    const result = await resolveNodeHost(run);
    expect(result).toBeNull();
  });

  test("returns null when Self.DNSName is empty string", async () => {
    const run = async () => ({ stdout: JSON.stringify({ Self: { DNSName: "" } }) });
    const result = await resolveNodeHost(run);
    expect(result).toBeNull();
  });
});

// ── TailscaleServeService helpers ─────────────────────────────────────────────

/** Drain microtask queue N times to let `await` chains advance. */
async function flushMicrotasks(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

function makeRun(rejectPorts: Set<number> = new Set()): {
  calls: string[][];
  run: TailscaleRunner;
} {
  const calls: string[][] = [];
  const run: TailscaleRunner = async (args) => {
    calls.push(args);
    const portArg = args.find((a) => a.startsWith("--https="));
    const port = portArg ? parseInt(portArg.split("=")[1]!, 10) : NaN;
    if (rejectPorts.has(port)) throw new Error(`fake run failure on port ${port}`);
    return { stdout: "" };
  };
  return { calls, run };
}

function makeRunSync(rejectPorts: Set<number> = new Set()): {
  calls: string[][];
  runSync: TailscaleRunnerSync;
} {
  const calls: string[][] = [];
  const runSync: TailscaleRunnerSync = (args) => {
    calls.push(args);
    const portArg = args.find((a) => a.startsWith("--https="));
    const port = portArg ? parseInt(portArg.split("=")[1]!, 10) : NaN;
    if (rejectPorts.has(port)) throw new Error(`fake runSync failure on port ${port}`);
  };
  return { calls, runSync };
}

function makeDeferred(): { resolve: () => void; promise: Promise<void> } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { resolve, promise };
}

// ── TailscaleServeService ─────────────────────────────────────────────────────

describe("TailscaleServeService", () => {
  // 1. register-ok: correct argv, onChange("ok"), snapshot
  test("register: argv correct, onChange ok, snapshot", async () => {
    const changes: Array<[string, number | null, string | null]> = [];
    const { calls, run } = makeRun();
    const svc = new TailscaleServeService({
      base: 8001,
      count: 5,
      enabled: true,
      onChange: (id, port, serve) => changes.push([id, port, serve]),
      run,
    });

    await svc.register("s1", 8001);

    expect(calls).toEqual([["serve", "--bg", "--https=8001", "127.0.0.1:8001"]]);
    // No --yes anywhere
    expect(calls[0]).not.toContain("--yes");
    expect(changes).toEqual([["s1", 8001, "ok"]]);
    expect(svc.snapshot()).toEqual({ s1: "ok" });
  });

  // 2. unregister after register: correct argv, onChange(null,null), snapshot empty
  test("unregister after register: argv correct, onChange null, snapshot empty", async () => {
    const changes: Array<[string, number | null, string | null]> = [];
    const { calls, run } = makeRun();
    const svc = new TailscaleServeService({
      base: 8001,
      count: 5,
      enabled: true,
      onChange: (id, port, serve) => changes.push([id, port, serve]),
      run,
    });

    await svc.register("s1", 8001);
    await svc.unregister("s1");

    expect(calls[1]).toEqual(["serve", "--https=8001", "off"]);
    expect(changes[1]).toEqual(["s1", null, null]);
    expect(svc.snapshot()).toEqual({});
  });

  // 3. register failure: onChange("failed"), snapshot "failed", no throw
  test("register failure: onChange failed, snapshot failed, no throw", async () => {
    const changes: Array<[string, number | null, string | null]> = [];
    const { run } = makeRun(new Set([8001]));
    const svc = new TailscaleServeService({
      base: 8001,
      count: 5,
      enabled: true,
      onChange: (id, port, serve) => changes.push([id, port, serve]),
      run,
    });

    await expect(svc.register("s1", 8001)).resolves.toBeUndefined();

    expect(changes).toEqual([["s1", 8001, "failed"]]);
    expect(svc.snapshot()).toEqual({ s1: "failed" });
  });

  // 4. unregister unknown id: no exec, no onChange
  test("unregister unknown id: no exec, no onChange", async () => {
    const changes: Array<unknown> = [];
    const { calls, run } = makeRun();
    const svc = new TailscaleServeService({
      base: 8001,
      count: 5,
      enabled: true,
      onChange: (...args) => changes.push(args),
      run,
    });

    await svc.unregister("s1");

    expect(calls).toEqual([]);
    expect(changes).toEqual([]);
  });

  // 5. disabled: all no-op, snapshot {}
  test("disabled: all ops no-op, snapshot empty", async () => {
    const changes: Array<unknown> = [];
    const { calls: asyncCalls, run } = makeRun();
    const { calls: syncCalls, runSync } = makeRunSync();
    const svc = new TailscaleServeService({
      base: 8001,
      count: 3,
      enabled: false,
      onChange: (...args) => changes.push(args),
      run,
      runSync,
    });

    await svc.register("s1", 8001);
    await svc.unregister("s1");
    await svc.reconcileStartup();
    svc.stopAll();

    expect(asyncCalls).toEqual([]);
    expect(syncCalls).toEqual([]);
    expect(changes).toEqual([]);
    expect(svc.snapshot()).toEqual({});
  });

  // 6. reconcileStartup: offs entire range sequentially, tolerates a throwing port
  test("reconcileStartup: offs each port in range; sequential; tolerates failure", async () => {
    // sequentiality: port 8002 rejects — but all 3 ports should be attempted
    const { calls, run } = makeRun(new Set([8002]));
    const svc = new TailscaleServeService({ base: 8001, count: 3, enabled: true, run });

    await expect(svc.reconcileStartup()).resolves.toBeUndefined();

    const offCalls = calls.filter((a) => a.includes("off"));
    const ports = offCalls.map((a) => {
      const arg = a.find((x) => x.startsWith("--https="))!;
      return parseInt(arg.split("=")[1]!, 10);
    });
    expect(ports.sort((a, b) => a - b)).toEqual([8001, 8002, 8003]);
  });

  // 6b. reconcileStartup sequential: port N+1 not called until port N resolves
  test("reconcileStartup sequential: N+1 not called until N resolves", async () => {
    type Resolver = () => void;
    const resolvers: Resolver[] = [];
    const invocationOrder: number[] = [];

    const run: TailscaleRunner = async (args) => {
      const httpsArg = args.find((a) => a.startsWith("--https="));
      const port = Number(httpsArg?.slice("--https=".length));
      invocationOrder.push(port);
      return new Promise<{ stdout: string }>((resolve) => {
        resolvers.push(() => resolve({ stdout: "" }));
      });
    };

    const svc = new TailscaleServeService({ base: 8001, count: 3, enabled: true, run });
    const done = svc.reconcileStartup();

    await flushMicrotasks();
    expect(invocationOrder).toEqual([8001]);

    resolvers[0]!();
    await flushMicrotasks();
    expect(invocationOrder).toEqual([8001, 8002]);

    resolvers[1]!();
    await flushMicrotasks();
    expect(invocationOrder).toEqual([8001, 8002, 8003]);

    resolvers[2]!();
    await done;
    expect(invocationOrder).toEqual([8001, 8002, 8003]);
  });

  // 7. stopAll: runSync off per registered port; throwing runSync doesn't stop rest; cleared; idempotent
  test("stopAll: runSync per port, throws tolerated, clears, idempotent", async () => {
    const { run } = makeRun();
    const { calls: syncCalls, runSync } = makeRunSync(new Set([8002]));
    const svc = new TailscaleServeService({
      base: 8001,
      count: 5,
      enabled: true,
      run,
      runSync,
    });

    await svc.register("s1", 8001);
    await svc.register("s2", 8002);
    await svc.register("s3", 8003);

    expect(() => svc.stopAll()).not.toThrow();

    const syncPorts = syncCalls.map((a) => {
      const arg = a.find((x) => x.startsWith("--https="))!;
      return parseInt(arg.split("=")[1]!, 10);
    });
    expect(syncPorts.sort((a, b) => a - b)).toEqual([8001, 8002, 8003]);
    expect(svc.snapshot()).toEqual({});

    // Second call is a no-op
    const countBefore = syncCalls.length;
    svc.stopAll();
    expect(syncCalls.length).toBe(countBefore);
  });

  // 8. global serialization: two registers back-to-back must not run concurrently
  test("global serialization: s2 run not called until s1 run resolves", async () => {
    const order: string[] = [];
    const deferred = makeDeferred();

    const run: TailscaleRunner = async (args) => {
      const isRegister = args.includes("--bg");
      const httpsArg = args.find((a) => a.startsWith("--https="));
      const port = httpsArg?.slice("--https=".length) ?? "?";
      if (isRegister && port === "8001") {
        order.push("s1-exec-start");
        await deferred.promise;
        order.push("s1-exec-done");
      } else if (isRegister && port === "8002") {
        order.push("s2-exec");
      }
      return { stdout: "" };
    };

    const svc = new TailscaleServeService({ base: 8001, count: 5, enabled: true, run });

    const p1 = svc.register("s1", 8001);
    const p2 = svc.register("s2", 8002);

    // Yield so queue starts; s1 is blocked, s2 must not have started yet
    await flushMicrotasks();
    expect(order).toEqual(["s1-exec-start"]);

    deferred.resolve();
    await p1;
    await p2;

    expect(order).toEqual(["s1-exec-start", "s1-exec-done", "s2-exec"]);
  });
});
