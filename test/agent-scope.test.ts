import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  AGENT_SCOPE_DROPIN,
  AGENT_SLICE,
  __resetAgentScope,
  agentScopeEnabled,
  agentScopePrefix,
  refreshAgentScope,
  stopAgentScopes,
} from "../src/agent-scope";

const FRAGMENT = `/home/op/.config/systemd/user/${AGENT_SLICE}`;
const DROPIN = `/home/op/.config/systemd/user/herdr.service.d/${AGENT_SCOPE_DROPIN}`;

interface Host {
  fragment?: string;
  dropIns?: string;
  probeFails?: boolean;
}

/** Fake `systemctl show` / `systemd-run` host; records every call. */
function fakeRun(host: Host, calls: string[][] = []) {
  return async (bin: string, args: string[]): Promise<string> => {
    calls.push([bin, ...args]);
    if (bin === "systemctl" && args.includes("FragmentPath")) return `${host.fragment ?? ""}\n`;
    if (bin === "systemctl" && args.includes("DropInPaths")) return `${host.dropIns ?? ""}\n`;
    if (bin === "systemd-run") {
      if (host.probeFails) throw new Error("Unknown assignment: OOMPolicy=continue");
      return "";
    }
    throw new Error(`unexpected ${bin}`);
  };
}

const PROVISIONED: Host = {
  fragment: FRAGMENT,
  dropIns: `/home/op/.config/systemd/user/herdr.service.d/20-resource-guardrails.conf ${DROPIN}`,
};

describe("refreshAgentScope (#3128)", () => {
  afterEach(() => __resetAgentScope());

  test("provisioned Linux host ⇒ open", async () => {
    expect(await refreshAgentScope({ platform: "linux", run: fakeRun(PROVISIONED) })).toBe(true);
    expect(agentScopeEnabled()).toBe(true);
  });

  test("the probe runs EXACTLY the spawn prefix + `true`, after the unit-file checks", async () => {
    const calls: string[][] = [];
    await refreshAgentScope({ platform: "linux", run: fakeRun(PROVISIONED, calls) });
    expect(calls.at(-1)).toEqual([...agentScopePrefix(), "true"]);
    expect(calls.slice(0, -1).every((c) => c[0] === "systemctl")).toBe(true);
  });

  test("prefix disables systemd-run's ${VAR} argument expansion", () => {
    const prefix = agentScopePrefix();
    expect(prefix.indexOf("--expand-environment=no")).toBeGreaterThan(0);
    expect(prefix.indexOf("--expand-environment=no")).toBeLessThan(prefix.indexOf("--"));
  });

  test("non-Linux ⇒ closed, nothing probed", async () => {
    const calls: string[][] = [];
    expect(await refreshAgentScope({ platform: "darwin", run: fakeRun(PROVISIONED, calls) })).toBe(
      false,
    );
    expect(calls).toEqual([]);
  });

  test("slice loaded but no unit file (empty FragmentPath) ⇒ closed, no scope started", async () => {
    const calls: string[][] = [];
    const host = { ...PROVISIONED, fragment: "" };
    expect(await refreshAgentScope({ platform: "linux", run: fakeRun(host, calls) })).toBe(false);
    expect(calls.some((c) => c[0] === "systemd-run")).toBe(false);
  });

  test("herdr drop-in missing ⇒ closed", async () => {
    const host = { ...PROVISIONED, dropIns: "/x/herdr.service.d/20-resource-guardrails.conf" };
    expect(await refreshAgentScope({ platform: "linux", run: fakeRun(host) })).toBe(false);
  });

  test("probe rejected (e.g. systemd < 253 refuses scope OOMPolicy=) ⇒ closed", async () => {
    const host = { ...PROVISIONED, probeFails: true };
    expect(await refreshAgentScope({ platform: "linux", run: fakeRun(host) })).toBe(false);
  });

  test("a later failed refresh closes a previously open gate", async () => {
    await refreshAgentScope({ platform: "linux", run: fakeRun(PROVISIONED) });
    await refreshAgentScope({ platform: "linux", run: fakeRun({ ...PROVISIONED, fragment: "" }) });
    expect(agentScopeEnabled()).toBe(false);
  });
});

describe("shipped units (#3128)", () => {
  const slice = readFileSync(`deploy/${AGENT_SLICE}`, "utf8");
  const dropIn = readFileSync(`deploy/herdr.service.d/${AGENT_SCOPE_DROPIN}`, "utf8");
  const herdrUnit = readFileSync("deploy/herdr.service", "utf8");
  const value = (unit: string, key: string) =>
    unit.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1] ?? null;

  test("slice carries the versioned limits", () => {
    expect(value(slice, "MemoryHigh")).toBe("60%");
    expect(value(slice, "MemoryMax")).toBe("80%");
    expect(value(slice, "TasksMax")).toBe(value(herdrUnit, "TasksMax"));
  });

  test("drop-in never lowers herdr's TasksMax, survives OOM kills and stops the agents slice", () => {
    expect(value(dropIn, "TasksMax")).toBe(value(herdrUnit, "TasksMax"));
    expect(value(dropIn, "OOMPolicy")).toBe("continue");
    expect(value(dropIn, "ExecStopPost")).toBe(`-systemctl --user stop ${AGENT_SLICE}`);
  });
});

describe("stopAgentScopes (#4039)", () => {
  const CG = `/user.slice/user-1000.slice/user@1000.service/${AGENT_SLICE}`;
  const DIR = `/sys/fs/cgroup${CG}`;
  const SID = "208b6fd5-418d-468f-b29b-3e72474a65f9";

  interface ScopeHost {
    controlGroup?: string;
    /** dirent name → cgroup.procs pids */
    scopes: Record<string, number[]>;
    /** pid → environ entries */
    environ?: Record<number, string[]>;
    stopFails?: boolean;
  }

  function fakeHost(host: ScopeHost) {
    const calls: string[][] = [];
    const deps = {
      platform: "linux" as const,
      run: async (bin: string, args: string[]) => {
        calls.push([bin, ...args]);
        if (args.includes("ControlGroup")) return `${host.controlGroup ?? CG}\n`;
        if (args[1] === "stop" && host.stopFails) throw new Error("bus down");
        return "";
      },
      readDir: async (path: string) => {
        if (path !== DIR) throw new Error(`ENOENT ${path}`);
        return [...Object.keys(host.scopes), "cgroup.procs", "memory.max"];
      },
      readFile: async (path: string) => {
        const procs = path.match(/^.+\/([^/]+)\/cgroup\.procs$/);
        if (procs && path.startsWith(DIR)) {
          const pids = host.scopes[procs[1]!];
          if (!pids) throw new Error("ENOENT");
          return pids.map((p) => `${p}\n`).join("");
        }
        const env = path.match(/^\/proc\/(\d+)\/environ$/);
        const entries = env ? host.environ?.[Number(env[1])] : undefined;
        if (!entries) throw new Error("EACCES");
        return entries.join("\0") + "\0";
      },
    };
    const stops = () => calls.filter((c) => c[0] === "systemctl" && c[2] === "stop");
    return { deps, calls, stops };
  }

  test("stops a scope whose main pid is gone, spares one whose main pid is alive", async () => {
    const h = fakeHost({
      scopes: {
        "run-p100-i1.scope": [200, 201], // main 100 dead, leftovers remain
        "run-p300-i2.scope": [300, 301], // main alive
      },
    });
    expect(await stopAgentScopes({}, h.deps)).toEqual(["run-p100-i1.scope"]);
    expect(h.stops()).toEqual([
      ["systemctl", "--user", "stop", "--no-block", "--", "run-p100-i1.scope"],
    ]);
  });

  test("skips empty scopes, the heavy slice and non-auto-named entries", async () => {
    const h = fakeHost({
      scopes: {
        "run-p100-i1.scope": [],
        "shepherd_agents-heavy.slice": [999],
        "shepherd-heavy-abc.scope": [999],
        "my-run-p5-i1.scope": [999],
      },
    });
    expect(await stopAgentScopes({}, h.deps)).toEqual([]);
    expect(h.stops()).toEqual([]);
  });

  test("with a sessionId, also stops a live scope carrying that exact marker", async () => {
    const h = fakeHost({
      scopes: {
        "run-p300-i2.scope": [300, 301],
        "run-p400-i3.scope": [400],
        "run-p500-i4.scope": [500],
      },
      environ: {
        300: ["PATH=/usr/bin"], // main lacks the marker, a child carries it
        301: [`SHEPHERD_SESSION_ID=${SID}`],
        400: [`SHEPHERD_SESSION_ID=${SID}x`], // near miss
        500: ["SHEPHERD_SESSION_ID=other"],
      },
    });
    expect(await stopAgentScopes({ sessionId: SID }, h.deps)).toEqual(["run-p300-i2.scope"]);
  });

  test("without a sessionId, a marker never stops a live scope", async () => {
    const h = fakeHost({
      scopes: { "run-p300-i2.scope": [300] },
      environ: { 300: [`SHEPHERD_SESSION_ID=${SID}`] },
    });
    expect(await stopAgentScopes({}, h.deps)).toEqual([]);
  });

  test("no slice cgroup (empty ControlGroup) ⇒ no reads, no stop", async () => {
    const h = fakeHost({ controlGroup: "", scopes: { "run-p100-i1.scope": [200] } });
    expect(await stopAgentScopes({}, h.deps)).toEqual([]);
    expect(h.stops()).toEqual([]);
  });

  test("non-Linux ⇒ nothing run", async () => {
    const h = fakeHost({ scopes: { "run-p100-i1.scope": [200] } });
    expect(await stopAgentScopes({}, { ...h.deps, platform: "darwin" })).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  test("never throws: a failing stop or unreadable slice dir resolves []", async () => {
    const failing = fakeHost({ scopes: { "run-p100-i1.scope": [200] }, stopFails: true });
    expect(await stopAgentScopes({}, failing.deps)).toEqual([]);
    const gone = fakeHost({ controlGroup: "/elsewhere", scopes: {} });
    expect(await stopAgentScopes({}, gone.deps)).toEqual([]);
  });
});
