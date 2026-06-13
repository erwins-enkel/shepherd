import { describe, expect, it } from "bun:test";
import { DiagnosticsService, type DiagnosticsDeps } from "./diagnostics";
import { DIAGNOSTICS_TTL_MS } from "./config";
import type { DiagnosticCheck } from "./types";

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
    // served-status text that maps config.port (default 7330) → a public port.
    runServeStatus: async () =>
      "https://node.example.ts.net (tailnet only)\n|-- / proxy http://127.0.0.1:7330\n",
  };
}

function byId(checks: DiagnosticCheck[], id: string): DiagnosticCheck {
  const c = checks.find((x) => x.id === id);
  if (!c) throw new Error(`no check ${id}`);
  return c;
}

// Probe-payload purity: a check carries EXACTLY id/state/hintKey, nothing else.
function assertPure(check: DiagnosticCheck) {
  expect(Object.keys(check).sort()).toEqual(["hintKey", "id", "state"]);
  expect(typeof check.hintKey).toBe("string");
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
  it("gh: error when not authenticated (non-zero exit)", async () => {
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
    expect(c.hintKey).toBe("diagnostics_hint_tailscale_not_serving");
  });
  it("tailscale: error when not serving the port", async () => {
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      runServeStatus: async () => "https://node.example.ts.net (tailnet only)\n",
    });
    const c = byId((await svc.check(0)).checks, "tailscale");
    expect(c.state).toBe("error");
    expect(c.hintKey).toBe("diagnostics_hint_tailscale_not_serving");
  });
  it("tailscale: never forwards raw serve-status text", async () => {
    const secret = "SECRET-SERVE-LINE-127.0.0.1";
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      runServeStatus: async () => `${secret}\n`,
    });
    const c = byId((await svc.check(0)).checks, "tailscale");
    expect(JSON.stringify(c)).not.toContain("SECRET-SERVE-LINE");
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
