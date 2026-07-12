import { describe, expect, it, spyOn } from "bun:test";
import {
  DiagnosticsService,
  defaultRunRemediation,
  nextDiagnosticsDelay,
  type DiagnosticsDeps,
} from "../src/diagnostics";
import {
  DIAGNOSTICS_TTL_MS,
  DIAGNOSTICS_INTERVAL_MS,
  DIAGNOSTICS_RECHECK_INTERVAL_MS,
  GH_PROBE_ATTEMPTS,
  config,
} from "../src/config";
import type { DiagnosticState } from "../src/types";
import { REMEDIATIONS } from "../src/remediations";
import type { DiagnosticCheck } from "../src/types";
import { SessionStore } from "../src/store";
import { listRepos } from "../src/repos";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  herdr: "herdr 0.7.0",
  bun: "1.3.10",
  node: "v24.14.1",
  git: "git version 2.45.0",
  claude: "1.2.3 (Claude Code)",
  codex: "@openai/codex 0.122.0",
};

// A fully-healthy deps bag; spread + override per test.
function healthyDeps(): DiagnosticsDeps {
  return {
    runVersion: versionRunner({ ...HEALTHY_VERSIONS }),
    // herdr daemon reachable (agent list exits 0). Override with a rejecting fn to
    // model an offline server. Without this default, the real `execFileAsync` probe
    // would shell out to an absent daemon and redden every herdr/overall-ok assertion.
    runHerdrLiveness: async () => {},
    runGhAuth: async () => {},
    // gh probe now retries transient failures; zero delay keeps the failure-path tests
    // (which reject synchronously) from accruing real wall-time.
    ghProbeRetryDelayMs: 0,
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
    // Pin the Codex auth mode so the codex_model_auth advisory is deterministically absent here
    // (it must not depend on the test host's real ~/.codex/auth.json).
    readCodexAuthMode: () => "unknown",
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
    expect(snap.checks).toHaveLength(8);
    expect(snap.checks.map((c) => c.id).sort()).toEqual([
      "bun",
      "claude",
      "codex",
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
      "herdr 0.7.0",
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

  // ── herdr: server liveness (issue #1559) ─────────────────────────────────────
  // A parseable `--version` proves only that the BINARY is present; the daemon must
  // also answer. A reachable binary with a dead server is `error` (offline), not `ok`.
  describe("herdr server liveness", () => {
    const offline = () => Promise.reject(new Error("connect ECONNREFUSED"));

    it("error/offline when the binary is present but the daemon is unreachable", async () => {
      const svc = new DiagnosticsService({ ...healthyDeps(), runHerdrLiveness: offline });
      const c = byId((await svc.check(0)).checks, "herdr");
      expect(c.state).toBe("error");
      expect(c.hintKey).toBe("diagnostics_hint_herdr_offline");
      assertPure(c);
    });

    it("ok when the binary is current AND the daemon answers", async () => {
      const svc = new DiagnosticsService({ ...healthyDeps(), runHerdrLiveness: async () => {} });
      const c = byId((await svc.check(0)).checks, "herdr");
      expect(c.state).toBe("ok");
      expect(c.hintKey).toBe("diagnostics_hint_herdr_ok");
    });

    it("offline outranks an outdated-version warning", async () => {
      const svc = new DiagnosticsService({
        ...healthyDeps(),
        runVersion: versionRunner({ ...HEALTHY_VERSIONS, herdr: "herdr 0.5.0" }),
        runHerdrLiveness: offline,
      });
      const c = byId((await svc.check(0)).checks, "herdr");
      expect(c.state).toBe("error");
      expect(c.hintKey).toBe("diagnostics_hint_herdr_offline");
    });

    it("skips the liveness probe when the binary is missing (stays _missing)", async () => {
      let pinged = false;
      const svc = new DiagnosticsService({
        ...healthyDeps(),
        runVersion: versionRunner({ ...HEALTHY_VERSIONS, herdr: new Error("ENOENT") }),
        runHerdrLiveness: async () => {
          pinged = true;
        },
      });
      const c = byId((await svc.check(0)).checks, "herdr");
      expect(c.state).toBe("error");
      expect(c.hintKey).toBe("diagnostics_hint_herdr_missing");
      expect(pinged).toBe(false);
    });

    it("an offline daemon drives the overall snapshot to error", async () => {
      const svc = new DiagnosticsService({ ...healthyDeps(), runHerdrLiveness: offline });
      const snap = await svc.check(0);
      expect(byId(snap.checks, "herdr").state).toBe("error");
      expect(snap.overall).toBe("error");
    });
  });

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

  // ── agent CLIs: Claude Code OR Codex is required; the other is optional ──────
  it("claude: ok when present", async () => {
    const svc = new DiagnosticsService(healthyDeps());
    const c = byId((await svc.check(0)).checks, "claude");
    expect(c.state).toBe("ok");
    expect(c.hintKey).toBe("diagnostics_hint_claude_ok");
  });
  it("codex: ok when present", async () => {
    const svc = new DiagnosticsService(healthyDeps());
    const c = byId((await svc.check(0)).checks, "codex");
    expect(c.state).toBe("ok");
    expect(c.hintKey).toBe("diagnostics_hint_codex_ok");
  });
  it("claude: optional when missing but Codex is present", async () => {
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      runVersion: versionRunner({ ...HEALTHY_VERSIONS, claude: new Error("ENOENT") }),
    });
    const c = byId((await svc.check(0)).checks, "claude");
    expect(c.state).toBe("optional");
    expect(c.hintKey).toBe("diagnostics_hint_claude_optional");
  });
  it("codex: optional when missing but Claude Code is present", async () => {
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      runVersion: versionRunner({ ...HEALTHY_VERSIONS, codex: new Error("ENOENT") }),
    });
    const c = byId((await svc.check(0)).checks, "codex");
    expect(c.state).toBe("optional");
    expect(c.hintKey).toBe("diagnostics_hint_codex_optional");
  });
  it("agent CLIs: both error when neither Claude Code nor Codex is present", async () => {
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      runVersion: versionRunner({
        ...HEALTHY_VERSIONS,
        claude: new Error("ENOENT"),
        codex: new Error("ENOENT"),
      }),
    });
    const snap = await svc.check(0);
    const claude = byId(snap.checks, "claude");
    const codex = byId(snap.checks, "codex");
    expect(claude.state).toBe("error");
    expect(claude.hintKey).toBe("diagnostics_hint_claude_missing");
    expect(codex.state).toBe("error");
    expect(codex.hintKey).toBe("diagnostics_hint_codex_missing");
    expect(snap.overall).toBe("error");
  });
  it("agent CLIs: optional missing peer keeps overall ok", async () => {
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      runVersion: versionRunner({ ...HEALTHY_VERSIONS, codex: new Error("ENOENT") }),
    });
    const snap = await svc.check(0);
    expect(byId(snap.checks, "codex").state).toBe("optional");
    expect(snap.overall).toBe("ok");
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
                "shepherd.example.ts.net:443": {
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

// ── gh probe: repo-mode-aware downgrade ──────────────────────────────────────
describe("DiagnosticsService gh probe repo-mode awareness", () => {
  it("gh failure + anyForgeRepo=false → warning + not_required hint", async () => {
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      runGhAuth: async () => {
        throw new Error("not authenticated");
      },
      anyForgeRepo: () => false,
    });
    const c = byId((await svc.check(0)).checks, "gh");
    expect(c.state).toBe("warning");
    expect(c.hintKey).toBe("diagnostics_hint_gh_not_required");
    assertPure(c);
  });

  it("gh ENOENT + anyForgeRepo=false → warning + not_required hint", async () => {
    const enoent = Object.assign(new Error("gh not found"), { code: "ENOENT" });
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      runGhAuth: async () => {
        throw enoent;
      },
      anyForgeRepo: () => false,
    });
    const c = byId((await svc.check(0)).checks, "gh");
    expect(c.state).toBe("warning");
    expect(c.hintKey).toBe("diagnostics_hint_gh_not_required");
    assertPure(c);
  });

  it("gh ENOENT + anyForgeRepo=true → error + gh_missing hint (unchanged)", async () => {
    const enoent = Object.assign(new Error("gh not found"), { code: "ENOENT" });
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      runGhAuth: async () => {
        throw enoent;
      },
      anyForgeRepo: () => true,
    });
    const c = byId((await svc.check(0)).checks, "gh");
    expect(c.state).toBe("error");
    expect(c.hintKey).toBe("diagnostics_hint_gh_missing");
    assertPure(c);
  });

  it("gh auth failure + anyForgeRepo=true → error (unchanged behavior)", async () => {
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      runGhAuth: async () => {
        throw new Error("not logged in");
      },
      anyForgeRepo: () => true,
    });
    const c = byId((await svc.check(0)).checks, "gh");
    expect(c.state).toBe("error");
    expect(c.hintKey).toBe("diagnostics_hint_gh_not_authenticated");
    assertPure(c);
  });
});

// ── gh probe: bounded retry + disposition-based classification (#623 follow-up) ──
// The reported bug: a transiently slow `gh auth status` (keyring/D-Bus stall, cold gh)
// timed out and was rendered as a hard "not logged in". These lock in that a KILLED
// (timed-out) probe retries and, if still stalling, reports the soft `gh_unverified`
// warning — while a real non-zero EXIT (logout / invalid token) still errors.
describe("DiagnosticsService gh probe retry + classification", () => {
  const timeoutErr = () =>
    Object.assign(new Error("gh auth status timed out"), { killed: true, signal: "SIGTERM" });

  it("timeout (killed) on every attempt → warning + gh_unverified (no false auth error)", async () => {
    let calls = 0;
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      runGhAuth: async () => {
        calls++;
        throw timeoutErr();
      },
    });
    const c = byId((await svc.check(0)).checks, "gh");
    expect(c.state).toBe("warning");
    expect(c.hintKey).toBe("diagnostics_hint_gh_unverified");
    expect(calls).toBe(GH_PROBE_ATTEMPTS); // retried the full budget before giving up
    assertPure(c);
  });

  it("retries a transient timeout and recovers → ok", async () => {
    let calls = 0;
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      runGhAuth: async () => {
        calls++;
        if (calls === 1) throw timeoutErr();
        // second attempt succeeds
      },
    });
    const c = byId((await svc.check(0)).checks, "gh");
    expect(c.state).toBe("ok");
    expect(c.hintKey).toBe("diagnostics_hint_gh_ok");
    expect(calls).toBe(2);
  });

  it("persistent non-zero EXIT (gh rendered a verdict) → error + gh_not_authenticated, not retried", async () => {
    let calls = 0;
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      runGhAuth: async () => {
        // a real logged-out / invalid-token `gh auth status` exits non-zero with NO kill
        // signal — the disposition that marks a genuine, actionable auth failure.
        calls++;
        throw Object.assign(new Error("exit 1"), { code: 1 });
      },
    });
    const c = byId((await svc.check(0)).checks, "gh");
    expect(c.state).toBe("error");
    expect(c.hintKey).toBe("diagnostics_hint_gh_not_authenticated");
    expect(calls).toBe(1); // deterministic verdict — probed once, no wasted retry
    assertPure(c);
  });

  it("timeout + anyForgeRepo=false → warning + not_required, no unverified log", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const svc = new DiagnosticsService({
        ...healthyDeps(),
        runGhAuth: async () => {
          throw timeoutErr();
        },
        anyForgeRepo: () => false,
      });
      const c = byId((await svc.check(0)).checks, "gh");
      expect(c.state).toBe("warning");
      expect(c.hintKey).toBe("diagnostics_hint_gh_not_required");
      // the warning never surfaces on a lightweight-only host → no scary log either.
      const logged = warn.mock.calls.flat().map(String).join(" ");
      expect(logged).not.toContain("could not be verified");
      assertPure(c);
    } finally {
      warn.mockRestore();
    }
  });

  it("unverified path logs only the disposition — never stderr / account identity", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const svc = new DiagnosticsService({
        ...healthyDeps(),
        runGhAuth: async () => {
          // pack identity-looking text into message + stderr; it must NOT reach the log.
          throw Object.assign(new Error("Logged in to github.com account secret-user"), {
            killed: true,
            signal: "SIGTERM",
            stderr: "Token: gho_secrettoken00000 account secret-user",
          });
        },
      });
      const c = byId((await svc.check(0)).checks, "gh");
      expect(c.hintKey).toBe("diagnostics_hint_gh_unverified");
      const logged = warn.mock.calls.flat().map(String).join(" ");
      expect(logged).toContain("could not be verified");
      expect(logged).not.toContain("secret-user");
      expect(logged).not.toContain("gho_secrettoken");
    } finally {
      warn.mockRestore();
    }
  });
});

// ── git_mergetree capability check ───────────────────────────────────────────
describe("DiagnosticsService git_mergetree capability check", () => {
  it("git_mergetree absent when no lightweight repos (default)", async () => {
    const svc = new DiagnosticsService(healthyDeps());
    const snap = await svc.check(0);
    expect(snap.checks.find((c) => c.id === "git_mergetree")).toBeUndefined();
  });

  it("git_mergetree absent when anyLightweightRepo=false", async () => {
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      anyLightweightRepo: () => false,
    });
    const snap = await svc.check(0);
    expect(snap.checks.find((c) => c.id === "git_mergetree")).toBeUndefined();
  });

  it("git_mergetree ok for git 2.40.0 with lightweight repo", async () => {
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      runVersion: versionRunner({ ...HEALTHY_VERSIONS, git: "git version 2.40.0" }),
      anyLightweightRepo: () => true,
    });
    const c = byId((await svc.check(0)).checks, "git_mergetree");
    expect(c.state).toBe("ok");
    expect(c.hintKey).toBe("diagnostics_hint_gitcap_ok");
    assertPure(c);
  });

  it("git_mergetree warning for git 2.37.0 with lightweight repo", async () => {
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      runVersion: versionRunner({ ...HEALTHY_VERSIONS, git: "git version 2.37.0" }),
      anyLightweightRepo: () => true,
    });
    const c = byId((await svc.check(0)).checks, "git_mergetree");
    expect(c.state).toBe("warning");
    expect(c.hintKey).toBe("diagnostics_hint_gitcap_old");
    assertPure(c);
  });

  it("git_mergetree ok at exactly git 2.38 (boundary)", async () => {
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      runVersion: versionRunner({ ...HEALTHY_VERSIONS, git: "git version 2.38.0" }),
      anyLightweightRepo: () => true,
    });
    const c = byId((await svc.check(0)).checks, "git_mergetree");
    expect(c.state).toBe("ok");
    expect(c.hintKey).toBe("diagnostics_hint_gitcap_ok");
  });

  it("git_mergetree check appears in overall snapshot with lightweight repos", async () => {
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      runVersion: versionRunner({ ...HEALTHY_VERSIONS, git: "git version 2.40.0" }),
      anyLightweightRepo: () => true,
    });
    const snap = await svc.check(0);
    expect(snap.checks).toHaveLength(9);
    expect(snap.checks.map((c) => c.id).sort()).toEqual([
      "bun",
      "claude",
      "codex",
      "gh",
      "git",
      "git_mergetree",
      "herdr",
      "node",
      "tailscale",
    ]);
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

  // #1578: the outdated remediation runs `herdr update --handoff`. Success is NOT the shell's
  // exit code (`herdr update` exits 0 even when it did nothing) — it is fix()'s RE-PROBE of
  // `herdr --version`. These pin that the re-probe is the real verifier, since the running
  // server's version is only exposed over the herdr socket, never a CLI verb the shell can read.
  it("herdr outdated: a no-op update leaves the binary old → re-probe still `warning` (no false ok, #1578)", async () => {
    const calls: string[] = [];
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      // Binary stays 0.5.0 across the fix (the remediation was a no-op / couldn't update).
      runVersion: versionRunner({ ...HEALTHY_VERSIONS, herdr: "herdr 0.5.0" }),
      runRemediation: async (cmd) => {
        calls.push(cmd);
      },
    });
    const snap = await svc.fix("herdr", 0);
    expect(calls).toEqual([REMEDIATIONS.diagnostics_hint_herdr_outdated!]);
    const herdr = byId(snap.checks, "herdr");
    expect(herdr.state).toBe("warning");
    expect(herdr.hintKey).toBe("diagnostics_hint_herdr_outdated");
  });

  it("herdr outdated: a successful update bumps the binary → re-probe `ok` (#1578)", async () => {
    let updated = false;
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      // Old until the remediation "updates" it, then above the floor.
      runVersion: async (bin, args) => {
        if (bin === "herdr") return updated ? "herdr 0.7.5" : "herdr 0.5.0";
        return versionRunner({ ...HEALTHY_VERSIONS })!(bin, args);
      },
      runRemediation: async () => {
        updated = true;
      },
    });
    const snap = await svc.fix("herdr", 0);
    const herdr = byId(snap.checks, "herdr");
    expect(herdr.state).toBe("ok");
    expect(herdr.hintKey).toBe("diagnostics_hint_herdr_ok");
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

// ── gh probe: the REAL anyForgeRepo closure over a real filesystem + store ────
// Regression guard for the onboarding-harness gh DETECTION GAP (#860): the gh
// scenarios seed a bare repo dir so anyForgeRepo()→true and the probe surfaces
// `error` (not the post-#819 no-repo `warning`). The stubbed `anyForgeRepo: () =>
// true/false` tests above never prove that a bare, never-configured directory
// actually resolves to forge — this exercises the exact closure src/index.ts wires
// (listRepos(repoRoot).some(r => store.getRepoConfig(r.path).repoMode === "forge"))
// against the real listRepos + SessionStore, the mechanism the harness fix relies on.
describe("DiagnosticsService gh probe — real anyForgeRepo closure (bare repo dir)", () => {
  // Build the literal index.ts closure over `root`, backed by a fresh in-memory store.
  function forgeClosure(root: string): () => boolean {
    const store = new SessionStore(":memory:");
    return () => listRepos(root).some((r) => store.getRepoConfig(r.path).repoMode === "forge");
  }

  function withRepoRoot(make: (root: string) => void): string {
    const root = mkdtempSync(join(tmpdir(), "shep-diag-gh-"));
    make(root);
    return root;
  }

  it("a bare non-git subdir (no DB row) resolves to forge → closure true", () => {
    const root = withRepoRoot((r) => mkdirSync(join(r, "forge-repo")));
    expect(forgeClosure(root)()).toBe(true);
  });

  it("an empty repoRoot resolves to no forge repo → closure false (pre-fix premise)", () => {
    const root = withRepoRoot(() => {});
    expect(forgeClosure(root)()).toBe(false);
  });

  it("gh auth failure + bare forge dir present → error (gh_not_authenticated)", async () => {
    const root = withRepoRoot((r) => mkdirSync(join(r, "forge-repo")));
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      runGhAuth: async () => {
        throw new Error("not authenticated");
      },
      anyForgeRepo: forgeClosure(root),
    });
    const c = byId((await svc.check(0)).checks, "gh");
    expect(c.state).toBe("error");
    expect(c.hintKey).toBe("diagnostics_hint_gh_not_authenticated");
    assertPure(c);
  });

  it("gh ENOENT + bare forge dir present → error (gh_missing)", async () => {
    const root = withRepoRoot((r) => mkdirSync(join(r, "forge-repo")));
    const enoent = Object.assign(new Error("gh not found"), { code: "ENOENT" });
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      runGhAuth: async () => {
        throw enoent;
      },
      anyForgeRepo: forgeClosure(root),
    });
    const c = byId((await svc.check(0)).checks, "gh");
    expect(c.state).toBe("error");
    expect(c.hintKey).toBe("diagnostics_hint_gh_missing");
    assertPure(c);
  });

  it("non-vacuity: same gh failure with an EMPTY repoRoot → warning (not_required)", async () => {
    const root = withRepoRoot(() => {}); // no repo → closure false → downgrade
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      runGhAuth: async () => {
        throw new Error("not authenticated");
      },
      anyForgeRepo: forgeClosure(root),
    });
    const c = byId((await svc.check(0)).checks, "gh");
    expect(c.state).toBe("warning");
    expect(c.hintKey).toBe("diagnostics_hint_gh_not_required");
    assertPure(c);
  });
});

// ── adaptive background re-check cadence (nextDiagnosticsDelay) ──────────────────
// The scheduler in src/index.ts re-arms itself with this delay after every snapshot.
// ONLY an `error` accelerates to the recheck interval so a transient hard error (herdr
// `offline`) self-corrects fast; `warning` must stay on the steady interval or a
// persistent-by-design warning (advisory version floors, gh-not-required) would fast-poll
// forever. The input domain is exactly {ok, warning, error}: `overall` is worstOf(checks),
// and worstOf ranks `optional` at 0 (== ok) upgrading only on a strict increase, so it can
// never surface `optional` — hence it is intentionally not part of the cases below.
describe("nextDiagnosticsDelay", () => {
  const cases: Array<[DiagnosticState, number]> = [
    ["error", DIAGNOSTICS_RECHECK_INTERVAL_MS],
    ["warning", DIAGNOSTICS_INTERVAL_MS],
    ["ok", DIAGNOSTICS_INTERVAL_MS],
  ];
  for (const [overall, expected] of cases) {
    it(`overall=${overall} → ${expected === DIAGNOSTICS_RECHECK_INTERVAL_MS ? "recheck" : "steady"} interval`, () => {
      expect(
        nextDiagnosticsDelay(overall, DIAGNOSTICS_INTERVAL_MS, DIAGNOSTICS_RECHECK_INTERVAL_MS),
      ).toBe(expected);
    });
  }

  it("only error accelerates: warning/ok are ≥ error's delay (no permanent fast poll)", () => {
    const err = nextDiagnosticsDelay(
      "error",
      DIAGNOSTICS_INTERVAL_MS,
      DIAGNOSTICS_RECHECK_INTERVAL_MS,
    );
    const warn = nextDiagnosticsDelay(
      "warning",
      DIAGNOSTICS_INTERVAL_MS,
      DIAGNOSTICS_RECHECK_INTERVAL_MS,
    );
    const ok = nextDiagnosticsDelay("ok", DIAGNOSTICS_INTERVAL_MS, DIAGNOSTICS_RECHECK_INTERVAL_MS);
    expect(err).toBeLessThan(warn);
    expect(warn).toBe(ok);
  });
});

describe("codex_model_auth advisory", () => {
  // Save/restore the live role config the check enumerates (see hold-gate/drain test precedent).
  function withRecap(
    cli: typeof config.recapCli,
    model: typeof config.recapModel,
    fn: () => Promise<void>,
  ): Promise<void> {
    const savedCli = config.recapCli;
    const savedModel = config.recapModel;
    config.recapCli = cli;
    config.recapModel = model;
    return fn().finally(() => {
      config.recapCli = savedCli;
      config.recapModel = savedModel;
    });
  }

  it("warns when a blocklisted codex model is configured under chatgpt auth", async () => {
    await withRecap("codex", "gpt-5.3-codex", async () => {
      const svc = new DiagnosticsService({
        ...healthyDeps(),
        readCodexAuthMode: () => "chatgpt",
      });
      const c = byId((await svc.check(0)).checks, "codex_model_auth");
      expect(c.state).toBe("warning");
      expect(c.hintKey).toBe("diagnostics_hint_codex_model_chatgpt_incompatible");
      assertPure(c);
    });
  });

  it("does NOT warn under apikey auth (the model is supported there)", async () => {
    await withRecap("codex", "gpt-5.3-codex", async () => {
      const svc = new DiagnosticsService({
        ...healthyDeps(),
        readCodexAuthMode: () => "apikey",
      });
      const checks = (await svc.check(0)).checks;
      expect(checks.find((c) => c.id === "codex_model_auth")).toBeUndefined();
    });
  });

  it("does NOT warn for a compatible codex model under chatgpt auth", async () => {
    await withRecap("codex", "gpt-5.5", async () => {
      const svc = new DiagnosticsService({
        ...healthyDeps(),
        readCodexAuthMode: () => "chatgpt",
      });
      const checks = (await svc.check(0)).checks;
      expect(checks.find((c) => c.id === "codex_model_auth")).toBeUndefined();
    });
  });
});
