import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  AGENT_SCOPE_DROPIN,
  AGENT_SLICE,
  __resetAgentScope,
  agentScopeEnabled,
  agentScopePrefix,
  refreshAgentScope,
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
