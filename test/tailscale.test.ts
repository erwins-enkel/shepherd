import { test, expect, describe } from "bun:test";
import { resolveNodeHost, serveRange } from "../src/tailscale";

// ── resolveNodeHost ───────────────────────────────────────────────────────────

const REALISTIC_STATUS = JSON.stringify({
  Self: {
    HostName: "backontop",
    DNSName: "backontop.chicken-beardie.ts.net.",
    OS: "linux",
    TailscaleIPs: ["100.64.0.1"],
    Online: true,
  },
  Peers: {},
  MagicDNSSuffix: "chicken-beardie.ts.net",
  CurrentTailnet: {},
});

describe("resolveNodeHost", () => {
  test("parses Self.DNSName and strips trailing dot", async () => {
    const run = async () => ({ stdout: REALISTIC_STATUS });
    const result = await resolveNodeHost(run);
    expect(result).toBe("backontop.chicken-beardie.ts.net");
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
      stdout: JSON.stringify({ Self: { HostName: "backontop" } }),
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

// ── serveRange: argv ──────────────────────────────────────────────────────────

describe("serveRange argv", () => {
  test("issues correct argv for each port in range — no --yes, bare 127.0.0.1:<port> target", async () => {
    const calls: Array<string[]> = [];
    const run = async (args: string[]) => {
      calls.push(args);
      return { stdout: "" };
    };

    await serveRange(8001, 3, run);

    expect(calls).toHaveLength(3);

    expect(calls[0]).toEqual(["serve", "--bg", "--https=8001", "127.0.0.1:8001"]);
    expect(calls[1]).toEqual(["serve", "--bg", "--https=8002", "127.0.0.1:8002"]);
    expect(calls[2]).toEqual(["serve", "--bg", "--https=8003", "127.0.0.1:8003"]);

    // Explicit guard: no --yes anywhere
    for (const args of calls) {
      expect(args).not.toContain("--yes");
    }
    // Explicit guard: target is bare 127.0.0.1:<port>, no http:// prefix
    for (const args of calls) {
      const target = args[args.length - 1]!;
      expect(target).toMatch(/^127\.0\.0\.1:\d+$/);
      expect(target).not.toContain("http://");
    }
  });
});

// ── serveRange: sequential execution ─────────────────────────────────────────
//
// Recording order alone would also pass a broken concurrent impl. We gate on
// resolution: the fake runner returns a deferred promise per port that we resolve
// manually, then assert that run(N+1) has NOT been called until run(N) resolves.

/** Drain the microtask queue several times to let `await` chains advance. */
async function flushMicrotasks(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

describe("serveRange sequential execution", () => {
  test("does NOT invoke port N+1 until port N's promise resolves", async () => {
    type Resolver = (value: { stdout: string }) => void;
    const resolvers: Resolver[] = [];
    const invocationOrder: number[] = [];

    const run = async (args: string[]): Promise<{ stdout: string }> => {
      // Extract port number from --https=<port>
      const httpsArg = args.find((a) => a.startsWith("--https="));
      const port = Number(httpsArg?.slice("--https=".length));
      invocationOrder.push(port);
      return new Promise<{ stdout: string }>((resolve) => {
        resolvers.push(resolve);
      });
    };

    // Start serveRange — do NOT await yet
    const done = serveRange(8001, 3, run);

    // Port 8001 should be invoked immediately; drain the queue to let the loop start
    await flushMicrotasks();

    expect(invocationOrder).toEqual([8001]);

    // Resolve port 8001; drain so the loop resumes and invokes 8002
    resolvers[0]!({ stdout: "" });
    await flushMicrotasks();

    expect(invocationOrder).toEqual([8001, 8002]);

    // Resolve port 8002; drain so the loop resumes and invokes 8003
    resolvers[1]!({ stdout: "" });
    await flushMicrotasks();

    expect(invocationOrder).toEqual([8001, 8002, 8003]);

    // Resolve port 8003; loop ends, serveRange resolves
    resolvers[2]!({ stdout: "" });
    await done;

    expect(invocationOrder).toEqual([8001, 8002, 8003]);
  });
});

// ── serveRange: best-effort (one failure doesn't abort) ──────────────────────

describe("serveRange best-effort", () => {
  test("continues after a failing port and attempts all ports", async () => {
    const calls: number[] = [];

    const run = async (args: string[]): Promise<{ stdout: string }> => {
      const httpsArg = args.find((a) => a.startsWith("--https="));
      const port = Number(httpsArg?.slice("--https=".length));
      calls.push(port);
      if (port === 8002) throw new Error("serve config write failed");
      return { stdout: "" };
    };

    // serveRange must resolve (not reject) even when one port throws
    await expect(serveRange(8001, 3, run)).resolves.toBeUndefined();

    // All three ports were attempted despite port 8002 failing
    expect(calls).toHaveLength(3);
    expect(calls).toEqual([8001, 8002, 8003]);
  });
});
