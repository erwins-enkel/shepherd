import { describe, expect, test } from "bun:test";
import { drainMachinePort, type DrainMachineDeps } from "../src/drain-machines";
import type { MachineRoute, MirroredSession } from "../src/remote-instances/sessions";

// #3016: the drain's settle requests to the machine that ran an integrated epic child.

const MAC = "a2222222-2222-4222-8222-222222222222";
const mac = { instanceId: MAC, name: "macbook", platform: "macos" };

function port(opts: {
  online?: boolean;
  answer?: () => Response | Promise<Response>;
  mirrored?: MirroredSession[];
}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const routes: MachineRoute[] = [
    {
      host: mac,
      target: opts.online === false ? null : { url: "https://mac.example:7330", token: "tok" },
    },
  ];
  const deps = {
    store: {} as DrainMachineDeps["store"],
    decide: {} as DrainMachineDeps["decide"],
    instances: { list: () => [] },
    sessions: { list: () => opts.mirrored ?? [], machines: () => routes },
    dispatcher: { submit: async () => ({ kind: "failed" }) },
    resolveForge: () => null,
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return (opts.answer ?? (() => Response.json({ settled: true })))();
    },
  } as unknown as DrainMachineDeps;
  return { port: drainMachinePort(deps), calls };
}

describe("drainMachinePort settle (#3016)", () => {
  test("POSTs the integrated PR to the machine's settle route with its token", async () => {
    const { port: p, calls } = port({});
    expect(await p.settle!(MAC, "s-1", 3955)).toEqual({ kind: "settled" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://mac.example:7330/api/sessions/s-1/settle-integrated");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ prNumber: 3955 });
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  test("without a recorded PR it sends none: the machine checks its session's own", async () => {
    const { port: p, calls } = port({});
    await p.settle!(MAC, "s-1", null);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({});
  });

  test("maps the machine's answers", async () => {
    const answers: [() => Response, unknown][] = [
      [() => Response.json({ settled: true, already: true }), { kind: "gone" }],
      [() => Response.json({ code: "session_not_found" }, { status: 404 }), { kind: "gone" }],
      [() => Response.json({ error: "not found" }, { status: 404 }), { kind: "unsupported" }],
      [() => Response.json({ code: "busy" }, { status: 409 }), { kind: "refused", code: "busy" }],
      [() => new Response("boom", { status: 500 }), { kind: "failed" }],
    ];
    for (const [answer, outcome] of answers)
      expect(await port({ answer }).port.settle!(MAC, "s-1", 1)).toEqual(outcome as never);
  });

  test("a transport failure, or a machine whose link is closed, is a failed request", async () => {
    const thrown = port({
      answer: () => {
        throw new Error("ECONNRESET");
      },
    });
    expect(await thrown.port.settle!(MAC, "s-1", 1)).toEqual({ kind: "failed" });
    const offline = port({ online: false });
    expect(await offline.port.settle!(MAC, "s-1", 1)).toEqual({ kind: "failed" });
    expect(offline.calls).toEqual([]);
  });

  test("machineOnline follows the open link; mirroredSession reads the mirror", () => {
    const m = { id: "s-1", status: "done", host: mac } as unknown as MirroredSession;
    const online = port({ mirrored: [m] }).port;
    expect(online.machineOnline!(MAC)).toBe(true);
    expect(online.machineOnline!("other")).toBe(false);
    expect(online.mirroredSession!("s-1")).toBe(m);
    expect(online.mirroredSession!("s-2")).toBeUndefined();
    expect(port({ online: false }).port.machineOnline!(MAC)).toBe(false);
  });
});
