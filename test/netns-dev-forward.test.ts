import { describe, expect, test } from "bun:test";
import { endianness } from "node:os";
import { NetnsDevForwarder, netnsListening, type SlirpCall } from "../src/netns-dev-forward";
import type { Session } from "../src/types";

const HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid";

function v4Hex(ip: string): string {
  const b = ip.split(".").map((n) => Number(n).toString(16).padStart(2, "0"));
  return (endianness() === "LE" ? b.reverse() : b).join("").toUpperCase();
}
function tcpLine(addrHex: string, port: number, state = "0A"): string {
  const p = port.toString(16).toUpperCase().padStart(4, "0");
  return `   0: ${addrHex}:${p} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  1000 0 123 1`;
}
const v4 = (ip: string, port: number, state?: string) =>
  [HEADER, tcpLine(v4Hex(ip), port, state)].join("\n");

describe("netnsListening", () => {
  test("accepts LISTEN on any, loopback and the tap address", () => {
    for (const ip of ["0.0.0.0", "127.0.0.1", "10.0.2.100"])
      expect(netnsListening({ v4: v4(ip, 5173), v6: null }, 5173)).toBe(true);
  });
  test("rejects other ports, non-LISTEN states and other addresses", () => {
    expect(netnsListening({ v4: v4("0.0.0.0", 5174), v6: null }, 5173)).toBe(false);
    expect(netnsListening({ v4: v4("0.0.0.0", 5173, "01"), v6: null }, 5173)).toBe(false);
    expect(netnsListening({ v4: v4("10.0.2.101", 5173), v6: null }, 5173)).toBe(false);
  });
  test("v6: `::` counts, `::1` does not", () => {
    const any = [HEADER, tcpLine("0".repeat(32), 5173)].join("\n");
    const lo = [HEADER, tcpLine("00000000000000000000000001000000", 5173)].join("\n");
    expect(netnsListening({ v4: null, v6: any }, 5173)).toBe(true);
    expect(netnsListening({ v4: null, v6: lo }, 5173)).toBe(false);
  });
});

const SID = "s1";

function harness(over: Partial<Session> = {}) {
  const session = {
    id: SID,
    status: "running",
    egressApplied: true,
    isolated: true,
    worktreePath: "/wt",
    ...over,
  } as Session;
  const state = {
    hint: 5173 as number | null,
    pid: "4242\n" as string | null,
    tcp: v4("127.0.0.1", 5173) as string | null,
    nextPort: 40000,
    nextId: 1,
    failAdds: 0,
    ns: "net:[2]" as string | null,
  };
  const calls: { execute: string; arguments?: Record<string, unknown> }[] = [];
  const slirpCall: SlirpCall = async (path, req) => {
    expect(path).toBe(`/rt/${SID}/slirp.sock`);
    const r = req as { execute: string; arguments?: Record<string, unknown> };
    calls.push(r);
    if (r.execute === "add_hostfwd") {
      if (state.failAdds > 0) {
        state.failAdds--;
        return { error: { desc: "bad request: add_hostfwd: cannot bind" } };
      }
      return { return: { id: state.nextId++ } };
    }
    return { return: {} };
  };
  const fwd = new NetnsDevForwarder({
    store: { get: (id: string) => (id === SID ? session : null) } as never,
    readHint: async (dir) => (dir === "/wt" ? state.hint : null),
    readText: async (path) => {
      if (path === `/rt/${SID}/netns.pid`) return state.pid;
      const pid = state.pid?.trim();
      if (path === `/proc/${pid}/net/tcp`) return state.tcp;
      return null;
    },
    netnsOf: async (pid) => (pid === "self" ? "net:[1]" : state.ns),
    allocPort: async () => state.nextPort++,
    slirpCall,
    apiSocketPath: (id) => `/rt/${id}/slirp.sock`,
    netnsPidPath: (id) => `/rt/${id}/netns.pid`,
    log: () => {},
  });
  const adds = () => calls.filter((c) => c.execute === "add_hostfwd");
  return { fwd, state, calls, adds, session };
}

describe("NetnsDevForwarder", () => {
  test("first CONNECT adds a hostfwd for the dev port; later ones hit the cache", async () => {
    const h = harness();
    expect(await h.fwd.forward(SID, 5173)).toBe(40000);
    expect(h.adds()).toEqual([
      {
        execute: "add_hostfwd",
        arguments: { proto: "tcp", host_addr: "127.0.0.1", host_port: 40000, guest_port: 5173 },
      },
    ]);
    expect(await h.fwd.forward(SID, 5173)).toBe(40000);
    expect(h.calls).toHaveLength(1);
    expect(await h.fwd.devPort(SID)).toBe(5173);
  });

  test("any port other than the verified dev port gets nothing", async () => {
    const h = harness();
    expect(await h.fwd.forward(SID, 7330)).toBeNull();
    expect(h.calls).toHaveLength(0);
  });

  test("null without hint, pid, or an in-netns listener", async () => {
    for (const patch of [
      { hint: null },
      { pid: null },
      { pid: "x" },
      { tcp: v4("0.0.0.0", 1) },
      { ns: null },
      { ns: "net:[1]" }, // stale pid now in Shepherd's own (host) netns
    ]) {
      const h = harness();
      Object.assign(h.state, patch);
      expect(await h.fwd.forward(SID, 5173)).toBeNull();
      expect(await h.fwd.devPort(SID)).toBeNull();
      expect(h.calls).toHaveLength(0);
    }
  });

  test("null for sessions without an egress netns, archived or non-isolated", async () => {
    for (const over of [
      { egressApplied: false },
      { status: "archived" as const },
      { isolated: false },
    ]) {
      const h = harness(over);
      expect(await h.fwd.forward(SID, 5173)).toBeNull();
      expect(h.calls).toHaveLength(0);
    }
  });

  test("dev port change removes the old forward and adds a new one", async () => {
    const h = harness();
    await h.fwd.forward(SID, 5173);
    h.state.hint = 3000;
    h.state.tcp = v4("0.0.0.0", 3000);
    expect(await h.fwd.forward(SID, 3000)).toBe(40001);
    expect(h.calls.map((c) => c.execute)).toEqual(["add_hostfwd", "remove_hostfwd", "add_hostfwd"]);
    expect(h.calls[1]!.arguments).toEqual({ id: 1 });
  });

  test("a respawned netns (new pid) gets a fresh forward without touching the dead one", async () => {
    const h = harness();
    await h.fwd.forward(SID, 5173);
    h.state.pid = "5555";
    expect(await h.fwd.forward(SID, 5173)).toBe(40001);
    expect(h.calls.map((c) => c.execute)).toEqual(["add_hostfwd", "add_hostfwd"]);
  });

  test("retries a failed add, then gives up with null", async () => {
    const h = harness();
    h.state.failAdds = 2;
    expect(await h.fwd.forward(SID, 5173)).toBe(40002);
    const g = harness();
    g.state.failAdds = 3;
    expect(await g.fwd.forward(SID, 5173)).toBeNull();
    expect(g.adds()).toHaveLength(3);
  });

  test("concurrent CONNECTs share one forward", async () => {
    const h = harness();
    const ports = await Promise.all([1, 2, 3].map(() => h.fwd.forward(SID, 5173)));
    expect(ports).toEqual([40000, 40000, 40000]);
    expect(h.adds()).toHaveLength(1);
  });

  test("drop forgets the forward", async () => {
    const h = harness();
    await h.fwd.forward(SID, 5173);
    h.fwd.drop(SID);
    expect(await h.fwd.forward(SID, 5173)).toBe(40001);
    expect(h.calls.map((c) => c.execute)).toEqual(["add_hostfwd", "add_hostfwd"]);
  });
});
