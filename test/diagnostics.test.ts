import { describe, expect, it } from "bun:test";
import {
  DiagnosticsService,
  defaultRunRemediation,
  type DiagnosticsDeps,
} from "../src/diagnostics";
import { DIAGNOSTICS_TTL_MS } from "../src/config";
import { REMEDIATIONS } from "../src/remediations";
import type { DiagnosticCheck } from "../src/types";

// ── injected-runner helpers ────────────────────────────────────────────────────
// A runner that returns canned `--version` output per binary; throw to simulate a
// missing binary. The defaults model a fully-healthy machine well above the floors.
function versionRunner(map: Record<string, string | Error>): DiagnosticsDeps["runVersion"] {
  return async (bin) => {
    const v = map[bin];
    if (v === undefined) throw new Error(`unexpected bin ${bin}`);
    if (v instanceof Error) throw v;
    return v;
  };
}

const HEALTHY_VERSIONS: Record<string, string> = {
  herdr: "herdr 0.6.10",
  bun: "1.3.10",
  node: "v24.14.1",
  git: "git version 2.45.0",
  claude: "1.2.3 (Claude Code)",
};

// A fully-healthy deps bag; spread + override per test.
function healthyDeps(): DiagnosticsDeps {
  return {
    runVersion: versionRunner({ ...HEALTHY_VERSIONS }),
    runGhAuth: async () => {},
    resolveHost: async () => "node.example.ts.net",
    // served-status JSON (tailscale serve status --json) that maps config.port (default 7330) → port 443.
    runServeStatus: async () =>
      JSON.stringify({
        Web: {
          "node.example.ts.net:443": {
            Handlers: { "/": { Proxy: "http://127.0.0.1:7330" } },
          },
        },
      }),
  };
}

function byId(checks: DiagnosticCheck[], id: string): DiagnosticCheck {
  const c = checks.find((x) => x.id === id);
  if (!c) throw new Error(`no check ${id}`);
  return c;
}

// Probe-payload purity: a check carries id/state/hintKey + (optionally) the
// non-secret `remediation` command — and NOTHING else (no stdout/tokens/paths).
function assertPure(check: DiagnosticCheck) {
  const allowed = new Set(["hintKey", "id", "remediation", "state"]);
  for (const k of Object.keys(check)) expect(allowed.has(k)).toBe(true);
  expect(typeof check.id).toBe("string");
  expect(typeof check.state).toBe("string");
  expect(typeof check.hintKey).toBe("string");
  if ("remediation" in check) expect(typeof check.remediation).toBe("string");
}

describe("DiagnosticsService probes", () => {
  it("reports all-ok on a healthy machine", async () => {
    const svc = new DiagnosticsService(healthyDeps());
    const snap = await svc.check(1000);
    expect(snap.overall).toBe("ok");
    expect(snap.generatedAt).toBe(1000);
    expect(snap.checks).toHaveLength(7);
    expect(snap.checks.map((c) => c.id).sort()).toEqual([
      "bun",
      "claude",
      "gh",
      "git",
      "herdr",
      "node",
      "tailscale",
    ]);
    for (const c of snap.checks) {
      assertPure(c);
      expect(c.state).toBe("ok");
    }
  });

  // ── version probes: ok / outdated(warning) / missing(error) ──────────────────
  for (const [id, bin, okOut, oldOut, okKey, outKey, missKey] of [
    [
      "herdr",
      "herdr",
      "herdr 0.6.10",
      "herdr 0.5.0",
      "diagnostics_hint_herdr_ok",
      "diagnostics_hint_herdr_outdated",
      "diagnostics_hint_herdr_missing",
    ],
    [
      "bun",
      "bun",
      "1.3.10",
      "1.0.0",
      "diagnostics_hint_bun_ok",
      "diagnostics_hint_bun_outdated",
      "diagnostics_hint_bun_missing",
    ],
    [
      "node",
      "node",
      "v24.14.1",
      "v18.0.0",
      "diagnostics_hint_node_ok",
      "diagnostics_hint_node_outdated",
      "diagnostics_hint_node_missing",
    ],
  ] as const) {
    it(`${id}: ok when current`, async () => {
      const svc = new DiagnosticsService({
        ...healthyDeps(),
        runVersion: versionRunner({ ...HEALTHY_VERSIONS, [bin]: okOut }),
      });
      const c = byId((await svc.check(0)).checks, id);
      expect(c.state).toBe("ok");
      expect(c.hintKey).toBe(okKey);
    });
    it(`${id}: warning when below floor`, async () => {
      const svc = new DiagnosticsService({
        ...healthyDeps(),
        runVersion: versionRunner({ ...HEALTHY_VERSIONS, [bin]: oldOut }),
      });
      const c = byId((await svc.check(0)).checks, id);
      expect(c.state).toBe("warning");
      expect(c.hintKey).toBe(outKey);
    });
    it(`${id}: error when missing`, async () => {
      const svc = new DiagnosticsService({
        ...healthyDeps(),
        runVersion: versionRunner({ ...HEALTHY_VERSIONS, [bin]: new Error("ENOENT") }),
      });
      const c = byId((await svc.check(0)).checks, id);
      expect(c.state).toBe("error");
      expect(c.hintKey).toBe(missKey);
    });
  }

  // ── git: presence-only ───────────────────────────────────────────────────────
  it("git: ok when present", async () => {
    const svc = new DiagnosticsService(healthyDeps());
    const c = byId((await svc.check(0)).checks, "git");
    expect(c.state).toBe("ok");
    expect(c.hintKey).toBe("diagnostics_hint_git_ok");
  });
  it("git: error when missing", async () => {
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      runVersion: versionRunner({ ...HEALTHY_VERSIONS, git: new Error("ENOENT") }),
    });
    const c = byId((await svc.check(0)).checks, "git");
    expect(c.state).toBe("error");
    expect(c.hintKey).toBe("diagnostics_hint_git_missing");
  });

  // ── claude: presence-only ────────────────────────────────────────────────────
  it("claude: ok when present", async () => {
    const svc = new DiagnosticsService(healthyDeps());
    const c = byId((await svc.check(0)).checks, "claude");
    expect(c.state).toBe("ok");
    expect(c.hintKey).toBe("diagnostics_hint_claude_ok");
  });
  it("claude: error when missing", async () => {
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      runVersion: versionRunner({ ...HEALTHY_VERSIONS, claude: new Error("ENOENT") }),
    });
    const c = byId((await svc.check(0)).checks, "claude");
    expect(c.state).toBe("error");
    expect(c.hintKey).toBe("diagnostics_hint_claude_missing");
  });

  // ── gh: exit-code only, never stdout ─────────────────────────────────────────
  it("gh: ok when auth status exits zero", async () => {
    const svc = new DiagnosticsService(healthyDeps());
    const c = byId((await svc.check(0)).checks, "gh");
    expect(c.state).toBe("ok");
    expect(c.hintKey).toBe("diagnostics_hint_gh_ok");
  });
  it("gh: error + gh_missing when binary is absent (ENOENT)", async () => {
    const enoent = Object.assign(new Error("gh not found"), { code: "ENOENT" });
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      runGhAuth: async () => {
        throw enoent;
      },
    });
    const c = byId((await svc.check(0)).checks, "gh");
    expect(c.state).toBe("error");
    expect(c.hintKey).toBe("diagnostics_hint_gh_missing");
    assertPure(c);
  });
  it("gh: error + gh_not_authenticated when auth fails (non-zero exit)", async () => {
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      runGhAuth: async () => {
        // simulate a non-zero exit carrying account identity in the message — it
        // must NOT leak into the payload.
        throw new Error("You are not logged into any GitHub hosts. account: secret-user");
      },
    });
    const c = byId((await svc.check(0)).checks, "gh");
    expect(c.state).toBe("error");
    expect(c.hintKey).toBe("diagnostics_hint_gh_not_authenticated");
    // payload purity: no stdout / token / identity bleed.
    assertPure(c);
    expect(JSON.stringify(c)).not.toContain("secret-user");
  });

  // ── tailscale: logged-in + serving ───────────────────────────────────────────
  it("tailscale: ok when logged in and serving config.port", async () => {
    const svc = new DiagnosticsService(healthyDeps());
    const c = byId((await svc.check(0)).checks, "tailscale");
    expect(c.state).toBe("ok");
    expect(c.hintKey).toBe("diagnostics_hint_tailscale_ok");
  });
  it("tailscale: error when not logged in (no host)", async () => {
    const svc = new DiagnosticsService({ ...healthyDeps(), resolveHost: async () => null });
    const c = byId((await svc.check(0)).checks, "tailscale");
    expect(c.state).toBe("error");
    expect(c.hintKey).toBe("diagnostics_hint_tailscale_missing");
  });
  it("tailscale: warning when logged in but not serving the port", async () => {
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      // Valid JSON but no Proxy entry targeting port 7330
      runServeStatus: async () =>
        JSON.stringify({
          Web: {
            "node.example.ts.net:5191": {
              Handlers: { "/": { Proxy: "http://127.0.0.1:5190" } },
            },
          },
        }),
    });
    const c = byId((await svc.check(0)).checks, "tailscale");
    expect(c.state).toBe("warning");
    expect(c.hintKey).toBe("diagnostics_hint_tailscale_not_serving");
  });
  it("tailscale: never forwards raw serve-status text", async () => {
    const secret = "SECRET-SERVE-LINE-127.0.0.1";
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      // Embed the secret inside a JSON value (a Proxy URL path) to verify it never leaks out
      runServeStatus: async () =>
        JSON.stringify({
          Web: {
            "node.example.ts.net:5191": {
              Handlers: { "/": { Proxy: `http://127.0.0.1:5190/${secret}` } },
            },
          },
        }),
    });
    const c = byId((await svc.check(0)).checks, "tailscale");
    expect(JSON.stringify(c)).not.toContain("SECRET-SERVE-LINE");
    assertPure(c);
  });
  it("tailscale: ok when HUD is fronted by a Tailscale Service (Services → svc:shepherd → localhost:7330)", async () => {
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      runServeStatus: async () =>
        JSON.stringify({
          Services: {
            "svc:shepherd": {
              TCP: { "443": { HTTPS: true } },
              Web: {
                "shepherd.chicken-beardie.ts.net:443": {
                  Handlers: { "/": { Proxy: "http://localhost:7330" } },
                },
              },
            },
          },
        }),
    });
    const c = byId((await svc.check(0)).checks, "tailscale");
    expect(c.state).toBe("ok");
    expect(c.hintKey).toBe("diagnostics_hint_tailscale_ok");
    assertPure(c);
  });
});

describe("DiagnosticsService timeout discipline", () => {
  it("a never-resolving probe still settles the batch to its non-OK fallback", async () => {
    // herdr's runVersion hangs forever — simulate by rejecting after the wrapper
    // would have timed out. Here we reject to model the timeout's effect: the probe
    // resolves to its defined fallback, the batch is NOT rejected.
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      runVersion: async (bin, args) => {
        if (bin === "herdr") throw new Error("timed out");
        return versionRunner({ ...HEALTHY_VERSIONS })!(bin, args);
      },
    });
    const snap = await svc.check(0); // must resolve, not reject
    const herdr = byId(snap.checks, "herdr");
    expect(herdr.state).toBe("error");
    expect(herdr.hintKey).toBe("diagnostics_hint_herdr_missing");
    // the other probes are unaffected.
    expect(byId(snap.checks, "git").state).toBe("ok");
  });
});

describe("DiagnosticsService overall (worst-of)", () => {
  it("one error among warnings ⇒ error", async () => {
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      runVersion: versionRunner({
        ...HEALTHY_VERSIONS,
        bun: "1.0.0", // warning
        herdr: new Error("missing"), // error
      }),
    });
    const snap = await svc.check(0);
    expect(byId(snap.checks, "bun").state).toBe("warning");
    expect(byId(snap.checks, "herdr").state).toBe("error");
    expect(snap.overall).toBe("error");
  });
  it("warnings only ⇒ warning", async () => {
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      runVersion: versionRunner({ ...HEALTHY_VERSIONS, node: "v18.0.0" }),
    });
    const snap = await svc.check(0);
    expect(snap.overall).toBe("warning");
  });
  it("all ok ⇒ ok", async () => {
    const svc = new DiagnosticsService(healthyDeps());
    expect((await svc.check(0)).overall).toBe("ok");
  });
});

describe("DiagnosticsService TTL caching", () => {
  it("current() returns the cached snapshot inside the TTL window", async () => {
    let calls = 0;
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      runVersion: async (bin, args) => {
        if (bin === "git") calls++;
        return versionRunner({ ...HEALTHY_VERSIONS })!(bin, args);
      },
    });
    const first = await svc.current(1000);
    const cached = await svc.current(1000 + DIAGNOSTICS_TTL_MS - 1);
    expect(cached).toBe(first); // same object — not re-run
    expect(calls).toBe(1);
  });
  it("current() re-checks once the TTL expires", async () => {
    let calls = 0;
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      runVersion: async (bin, args) => {
        if (bin === "git") calls++;
        return versionRunner({ ...HEALTHY_VERSIONS })!(bin, args);
      },
    });
    await svc.current(1000);
    const fresh = await svc.current(1000 + DIAGNOSTICS_TTL_MS);
    expect(fresh.generatedAt).toBe(1000 + DIAGNOSTICS_TTL_MS);
    expect(calls).toBe(2);
  });
  it("check() always re-runs regardless of TTL", async () => {
    let calls = 0;
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      runVersion: async (bin, args) => {
        if (bin === "git") calls++;
        return versionRunner({ ...HEALTHY_VERSIONS })!(bin, args);
      },
    });
    await svc.check(1000);
    await svc.check(1000); // same `now`, still re-runs
    expect(calls).toBe(2);
  });
});

describe("DiagnosticsService remediation annotation", () => {
  it("check() sets remediation on a non-ok auto-fixable check, absent on ok checks", async () => {
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      runVersion: versionRunner({ ...HEALTHY_VERSIONS, bun: new Error("ENOENT") }),
    });
    const snap = await svc.check(0);
    const bun = byId(snap.checks, "bun");
    expect(bun.state).toBe("error");
    expect(bun.remediation).toBe(REMEDIATIONS.diagnostics_hint_bun_missing!);
    assertPure(bun);
    // every ok check stays bare (no remediation key)
    for (const c of snap.checks) {
      if (c.state === "ok") expect("remediation" in c).toBe(false);
    }
  });

  it("check() does NOT set remediation on guidance-only tailscale (even when error)", async () => {
    const svc = new DiagnosticsService({ ...healthyDeps(), resolveHost: async () => null });
    const c = byId((await svc.check(0)).checks, "tailscale");
    expect(c.state).toBe("error");
    expect(c.hintKey).toBe("diagnostics_hint_tailscale_missing");
    expect("remediation" in c).toBe(false);
    assertPure(c);
  });
});

describe("DiagnosticsService.fix", () => {
  it("happy path: runs the verbatim command, re-probes, returns the fresh snapshot", async () => {
    let installed = false;
    const calls: string[] = [];
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      // bun missing until the remediation "installs" it, then healthy.
      runVersion: async (bin, args) => {
        if (bin === "bun") {
          if (!installed) throw new Error("ENOENT");
          return "1.3.10";
        }
        return versionRunner({ ...HEALTHY_VERSIONS })!(bin, args);
      },
      runRemediation: async (cmd) => {
        calls.push(cmd);
        installed = true;
      },
    });
    const snap = await svc.fix("bun", 0);
    expect(calls).toEqual([REMEDIATIONS.diagnostics_hint_bun_missing!]);
    const bun = byId(snap.checks, "bun");
    expect(bun.state).toBe("ok");
  });

  it("throws for an unknown checkId (runner never called)", async () => {
    let called = false;
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      runRemediation: async () => {
        called = true;
      },
    });
    await expect(svc.fix("nope", 0)).rejects.toThrow("unknown check nope");
    expect(called).toBe(false);
  });

  it("throws for a guidance-only check (tailscale) — runner not called", async () => {
    let called = false;
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      resolveHost: async () => null, // tailscale → error, hintKey tailscale_missing
      runRemediation: async () => {
        called = true;
      },
    });
    await expect(svc.fix("tailscale", 0)).rejects.toThrow("no remediation for tailscale");
    expect(called).toBe(false);
  });

  it("propagates a runner rejection (fail-closed)", async () => {
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      runVersion: versionRunner({ ...HEALTHY_VERSIONS, bun: new Error("ENOENT") }),
      runRemediation: async () => {
        throw new Error("remediation exited 1");
      },
    });
    await expect(svc.fix("bun", 0)).rejects.toThrow("remediation exited 1");
  });
});

// The real spawn-based runner — the riskiest code (detached group, timeout SIGKILL,
// double-settle guard). Exercised here against actual short-lived `sh` commands; the
// timeout path uses an injected tiny budget so it doesn't wait the real 120s.
describe("defaultRunRemediation (real spawn)", () => {
  it("resolves when the command exits 0", async () => {
    await expect(defaultRunRemediation("exit 0")).resolves.toBeUndefined();
  });

  it("rejects with the exit code on non-zero exit", async () => {
    await expect(defaultRunRemediation("exit 3")).rejects.toThrow("remediation exited 3");
  });

  it("times out and group-kills a long-running command", async () => {
    // `sleep 30` would outlive the test; the 50ms budget fires the timeout path,
    // SIGKILLs the process group, and rejects — proving the budget is honored.
    await expect(defaultRunRemediation("sleep 30", 50)).rejects.toThrow("remediation timed out");
  });
});
