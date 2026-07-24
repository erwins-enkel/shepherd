import { describe, expect, it, spyOn } from "bun:test";
import {
  DiagnosticsService,
  classifyHerdrFleet,
  classifyHostCapacity,
  classifyPreviewProbes,
  classifyTmpInodes,
  defaultReadHerdrFleet,
  defaultRunRemediation,
  hasMeaningfulLimit,
  herdrLimitFromProps,
  nextDiagnosticsDelay,
  parseCgroupUnit,
  parseMemTotal,
  parsePsiAvg10,
  parseSwap,
  parseSystemctlShow,
  proposeHostLimits,
  type DiagnosticsDeps,
  type HostCapacityFacts,
} from "../src/diagnostics";
import type { HerdrAgent } from "../src/herdr";
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
    // claude_trust (#1683) surfaces only under subscription auth with Claude present. Pin both so
    // the ambient snapshot is deterministic and all-ok (trusted → ok); override per case below.
    isApiKeyAuth: () => false,
    readClaudeTrusted: async () => true,
    // host_capacity (#1732): a systemd-managed host WITH limits and no pressure → ok. Override
    // per case to model unbounded / pressure / uninspectable.
    readHostResources: async () => ({
      unit: "shepherd.service",
      userScope: true,
      limited: true,
      herdrLimited: true,
      swap: { total: 8_000_000_000, used: 100_000_000 },
      pressure: { memory: 0, io: 0 },
      memTotal: 32 * 1024 ** 3,
      cpuCount: 8,
    }),
    // herdr_health (#1835): a clean fleet (no live orphans) → ok. Injected because the service has
    // NO functional default (defaultReadHerdrFleet needs the store + herdr driver); without this
    // the probe's fail-safe reject would report herdr_health as optional/uninspectable and break
    // the all-ok assertions. Override per case to model leftover / husk / uninspectable.
    readHerdrFleet: async () => ({ orphanLive: 0, orphanHusk: 0 }),
    // tmp_inodes (#1862): a roomy temp filesystem → ok. Injected because the default statfs's the
    // REAL tmpdir(), whose inode use varies by host — without pinning it, every all-ok/overall
    // assertion here would flip on a machine whose /tmp happens to be under pressure.
    readTmpInodes: async () => ({ usePct: 12, warnPct: 80, errorPct: 95 }),
    // preview_probes (#1912): backend healthy + cell fresh → ok. Pinned so the row is
    // deterministic regardless of the test host's real /proc/lsof state.
    runPreviewProbe: async () => "ok",
    probeHealth: () => "fresh",
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
  const allowed = new Set([
    "hintKey",
    "id",
    "remediation",
    "state",
    "fixActionKey",
    "fixActionParams",
  ]);
  for (const k of Object.keys(check)) expect(allowed.has(k)).toBe(true);
  expect(typeof check.id).toBe("string");
  expect(typeof check.state).toBe("string");
  expect(typeof check.hintKey).toBe("string");
  if ("remediation" in check) expect(typeof check.remediation).toBe("string");
  if ("fixActionKey" in check) expect(typeof check.fixActionKey).toBe("string");
  // fixActionParams pins the claimed purity boundary: non-secret host facts only — unit names +
  // limit strings, never a path (`/`), token, or identity shape.
  if (check.fixActionParams) {
    for (const v of Object.values(check.fixActionParams)) expect(typeof v).toBe("string");
    if ("units" in check.fixActionParams) {
      expect(check.fixActionParams.units).toMatch(/^[\w.-]+( [\w.-]+)*$/);
    }
    if ("memoryHigh" in check.fixActionParams) {
      expect(check.fixActionParams.memoryHigh).toMatch(/^\d+G$/);
    }
    if ("cpuQuota" in check.fixActionParams) {
      expect(check.fixActionParams.cpuQuota).toMatch(/^\d+%$/);
    }
  }
}

describe("DiagnosticsService probes", () => {
  it("reports all-ok on a healthy machine", async () => {
    const svc = new DiagnosticsService(healthyDeps());
    const snap = await svc.check(1000);
    expect(snap.overall).toBe("ok");
    expect(snap.generatedAt).toBe(1000);
    expect(snap.checks).toHaveLength(13);
    expect(snap.checks.map((c) => c.id).sort()).toEqual([
      "bun",
      "claude",
      "claude_trust",
      "codex",
      "gh",
      "git",
      "herdr",
      "herdr_health",
      "host_capacity",
      "node",
      "preview_probes",
      "tailscale",
      "tmp_inodes",
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

    it("error/unsupported on a herdr past the ceiling (0.7.6) — outranks liveness", async () => {
      const svc = new DiagnosticsService({
        ...healthyDeps(),
        runVersion: versionRunner({ ...HEALTHY_VERSIONS, herdr: "herdr 0.7.6" }),
        runHerdrLiveness: async () => {}, // even a healthy daemon can't rescue an unsupported version
      });
      const c = byId((await svc.check(0)).checks, "herdr");
      expect(c.state).toBe("error");
      expect(c.hintKey).toBe("diagnostics_hint_herdr_unsupported");
    });

    it("ok on herdr 0.7.5 (now supported) when the daemon answers", async () => {
      const svc = new DiagnosticsService({
        ...healthyDeps(),
        runVersion: versionRunner({ ...HEALTHY_VERSIONS, herdr: "herdr 0.7.5" }),
        runHerdrLiveness: async () => {},
      });
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

  // ── claude_trust (#1683): subscription-only, claude-gated folder-trust surfacing ──
  it("claude_trust: ok when Claude Code trusts the repo root", async () => {
    const svc = new DiagnosticsService({ ...healthyDeps(), readClaudeTrusted: async () => true });
    const c = byId((await svc.check(0)).checks, "claude_trust");
    expect(c.state).toBe("ok");
    expect(c.hintKey).toBe("diagnostics_hint_claude_trust_ok");
    expect(c.fixActionKey).toBeUndefined();
  });
  it("claude_trust: warning + path-free fixActionKey when untrusted", async () => {
    const svc = new DiagnosticsService({ ...healthyDeps(), readClaudeTrusted: async () => false });
    const snap = await svc.check(0);
    const c = byId(snap.checks, "claude_trust");
    expect(c.state).toBe("warning");
    expect(c.hintKey).toBe("diagnostics_hint_claude_trust_untrusted");
    expect(c.fixActionKey).toBe("diagnostics_fix_action_claude_trust");
    expect(c.remediation).toBeUndefined(); // code fix, not a shell command
    expect(snap.overall).toBe("warning");
  });
  it("claude_trust: absent under api-key auth (probe never wedges anything)", async () => {
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      isApiKeyAuth: () => true,
      readClaudeTrusted: async () => false, // would be a warning if it surfaced
    });
    const checks = (await svc.check(0)).checks;
    expect(checks.find((c) => c.id === "claude_trust")).toBeUndefined();
  });
  it("claude_trust: absent when Claude Code is not installed", async () => {
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      runVersion: versionRunner({ ...HEALTHY_VERSIONS, claude: new Error("ENOENT") }),
      readClaudeTrusted: async () => false,
    });
    const checks = (await svc.check(0)).checks;
    expect(checks.find((c) => c.id === "claude_trust")).toBeUndefined();
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
    expect(snap.checks).toHaveLength(14);
    expect(snap.checks.map((c) => c.id).sort()).toEqual([
      "bun",
      "claude",
      "claude_trust",
      "codex",
      "gh",
      "git",
      "git_mergetree",
      "herdr",
      "herdr_health",
      "host_capacity",
      "node",
      "preview_probes",
      "tailscale",
      "tmp_inodes",
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
      // Old until the remediation "updates" it, then above the floor (and still supported —
      // 0.7.5+ is unsupported and would re-probe as an error, not ok; see #1889).
      runVersion: async (bin, args) => {
        if (bin === "herdr") return updated ? "herdr 0.7.4" : "herdr 0.5.0";
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

  // ── claude_trust (#1683): code-fix dispatch by hintKey — seeds trust, no shell command ──
  it("claude_trust: seeds folder trust then re-probe flips to ok", async () => {
    let seeded = false;
    let trustCalls = 0;
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      readClaudeTrusted: async () => seeded, // untrusted until the seed
      trustClaude: async () => {
        trustCalls++;
        seeded = true;
      },
    });
    const snap = await svc.fix("claude_trust", 0);
    expect(trustCalls).toBe(1);
    const c = byId(snap.checks, "claude_trust");
    expect(c.state).toBe("ok");
    expect(c.hintKey).toBe("diagnostics_hint_claude_trust_ok");
  });
  it("claude_trust: read-gated — skips the seed write when already trusted at fix time", async () => {
    let reads = 0;
    let trustCalls = 0;
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      // Untrusted on the first (probe) read so the untrusted check exists; trusted by the
      // gate read (seeded meanwhile) → the write must be skipped, no clobber of live state.
      readClaudeTrusted: async () => reads++ > 0,
      trustClaude: async () => {
        trustCalls++;
      },
    });
    const snap = await svc.fix("claude_trust", 0);
    expect(trustCalls).toBe(0);
    expect(byId(snap.checks, "claude_trust").state).toBe("ok");
  });
});

// ── host_capacity one-click fix (#1839): code-fix dispatch by fixActionKey ──
describe("host_capacity fix() dispatch", () => {
  const GIB = 1024 ** 3;
  const userUnbounded = (o: Partial<HostCapacityFacts> = {}): HostCapacityFacts => ({
    unit: "shepherd.service",
    userScope: true,
    limited: false,
    herdrLimited: false,
    swap: null,
    pressure: null,
    memTotal: 32 * GIB,
    cpuCount: 8,
    ...o,
  });

  it("applies the carried units + values, then the re-probe flips to ok", async () => {
    let bounded = false;
    const applied: Array<{ units: string[]; limits: { memoryHigh: string; cpuQuota: string } }> =
      [];
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      readHostResources: async () =>
        bounded ? userUnbounded({ limited: true, herdrLimited: true }) : userUnbounded(),
      applyHostLimits: async (units, limits) => {
        applied.push({ units, limits });
        bounded = true;
      },
    });
    const snap = await svc.fix("host_capacity", 0);
    expect(applied).toHaveLength(1);
    expect(applied[0]?.units).toEqual(["shepherd.service", "herdr.service"]);
    expect(applied[0]?.limits).toEqual({ memoryHigh: "27G", cpuQuota: "700%" });
    expect(byId(snap.checks, "host_capacity").state).toBe("ok");
  });

  it("no-stomp: Shepherd already bounded → applies only herdr.service", async () => {
    let units: string[] = [];
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      readHostResources: async () => userUnbounded({ limited: true, herdrLimited: false }),
      applyHostLimits: async (u) => {
        units = u;
      },
    });
    await svc.fix("host_capacity", 0);
    expect(units).toEqual(["herdr.service"]);
  });

  it("both code-fix paths coexist: fixActionKey routes host_capacity, hintKey routes claude_trust", async () => {
    let trustCalls = 0;
    let applyCalls = 0;
    const deps = {
      ...healthyDeps(),
      readClaudeTrusted: async () => false, // untrusted → claude_trust warning with fixActionKey
      trustClaude: async () => {
        trustCalls++;
      },
      readHostResources: async () => userUnbounded(),
      applyHostLimits: async () => {
        applyCalls++;
      },
    };
    const svc = new DiagnosticsService(deps);
    await svc.fix("host_capacity", 0);
    expect(applyCalls).toBe(1);
    expect(trustCalls).toBe(0); // host_capacity fix did NOT touch the trust path
    await svc.fix("claude_trust", 0);
    expect(trustCalls).toBe(1);
    expect(applyCalls).toBe(1); // claude_trust fix did NOT re-run the host limits
  });

  it("a system-scoped unbounded check has no fix → fix() throws no remediation", async () => {
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      readHostResources: async () => userUnbounded({ userScope: false, herdrLimited: null }),
      applyHostLimits: async () => {
        throw new Error("should not be called");
      },
    });
    await expect(svc.fix("host_capacity", 0)).rejects.toThrow("no remediation for host_capacity");
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
// A NON-steady-state `error` accelerates to the recheck interval so a transient hard error
// (herdr `offline`) self-corrects fast; `warning` and `ok` stay on the steady interval, and a
// steady-state error (`host_capacity` pressure) is EXEMPT so it never fast-polls the full
// probe fan-out onto an already-stressed host.
describe("nextDiagnosticsDelay", () => {
  const chk = (id: string, state: DiagnosticState): DiagnosticCheck => ({
    id,
    state,
    hintKey: `diagnostics_hint_${id}`,
  });
  const delay = (checks: DiagnosticCheck[]): number =>
    nextDiagnosticsDelay(checks, DIAGNOSTICS_INTERVAL_MS, DIAGNOSTICS_RECHECK_INTERVAL_MS);

  it("a transient error (herdr) accelerates to the recheck interval", () => {
    expect(delay([chk("herdr", "error"), chk("bun", "ok")])).toBe(DIAGNOSTICS_RECHECK_INTERVAL_MS);
  });

  it("all-ok / warning stay on the steady interval", () => {
    expect(delay([chk("bun", "ok"), chk("gh", "warning")])).toBe(DIAGNOSTICS_INTERVAL_MS);
  });

  it("a host_capacity-only error does NOT accelerate (steady-state exempt)", () => {
    expect(delay([chk("host_capacity", "error"), chk("bun", "ok")])).toBe(DIAGNOSTICS_INTERVAL_MS);
  });

  it("host_capacity error alongside a transient error still accelerates", () => {
    expect(delay([chk("host_capacity", "error"), chk("herdr", "error")])).toBe(
      DIAGNOSTICS_RECHECK_INTERVAL_MS,
    );
  });

  // tmp_inodes (#1862) is steady-state for two reasons: the forced sweep commonly cannot clear it
  // (the largest consumers aren't reclaimed yet), and accelerating the full probe fan-out means
  // ~10 extra fork/execs a minute on a host whose inode table — the very resource process spawning
  // needs — is already exhausted.
  it("a tmp_inodes-only error does NOT accelerate (steady-state exempt)", () => {
    expect(delay([chk("tmp_inodes", "error"), chk("bun", "ok")])).toBe(DIAGNOSTICS_INTERVAL_MS);
  });

  it("tmp_inodes error alongside a transient error still accelerates (exemption is scoped)", () => {
    expect(delay([chk("tmp_inodes", "error"), chk("herdr", "error")])).toBe(
      DIAGNOSTICS_RECHECK_INTERVAL_MS,
    );
  });
});

// ── host_capacity check (#1732) ─────────────────────────────────────────────────
describe("classifyHostCapacity", () => {
  // A systemd-managed, limited, unpressured host → ok. Override per case.
  const base: HostCapacityFacts = {
    unit: "shepherd.service",
    userScope: true,
    limited: true,
    herdrLimited: true,
    swap: { total: 8_000_000_000, used: 100_000_000 },
    pressure: { memory: 0, io: 0 },
    memTotal: 32 * 1024 ** 3,
    cpuCount: 8,
  };
  const facts = (o: Partial<HostCapacityFacts>): HostCapacityFacts => ({ ...base, ...o });
  const saturated = { total: 8_000_000_000, used: 7_900_000_000 }; // ~98% used

  const cases: Array<[string, HostCapacityFacts, DiagnosticState, string]> = [
    ["limited + calm → ok", base, "ok", "diagnostics_hint_host_capacity_ok"],
    [
      "systemd, no limits → unbounded",
      facts({ limited: false }),
      "warning",
      "diagnostics_hint_host_capacity_unbounded",
    ],
    [
      "not systemd (unit null) → uninspectable",
      facts({ unit: null, limited: null }),
      "optional",
      "diagnostics_hint_host_capacity_uninspectable",
    ],
    [
      "non-Linux (all null) → uninspectable",
      {
        unit: null,
        userScope: false,
        limited: null,
        herdrLimited: null,
        swap: null,
        pressure: null,
        memTotal: null,
        cpuCount: 8,
      },
      "optional",
      "diagnostics_hint_host_capacity_uninspectable",
    ],
    [
      "unit found but limits unreadable (limited null) → uninspectable, not a false unbounded",
      facts({ limited: null }),
      "optional",
      "diagnostics_hint_host_capacity_uninspectable",
    ],
    [
      "memory PSI high → error",
      facts({ pressure: { memory: 15, io: 0 } }),
      "error",
      "diagnostics_hint_host_capacity_pressure",
    ],
    [
      "io PSI high → error",
      facts({ pressure: { memory: 0, io: 30 } }),
      "error",
      "diagnostics_hint_host_capacity_pressure",
    ],
    [
      "saturated swap + LOW PSI → NOT error (zram/proactive guard)",
      facts({ swap: saturated, pressure: { memory: 1, io: 0 } }),
      "ok",
      "diagnostics_hint_host_capacity_ok",
    ],
    [
      "saturated swap + moderate PSI (≥5) → error via corroboration",
      facts({ swap: saturated, pressure: { memory: 6, io: 0 } }),
      "error",
      "diagnostics_hint_host_capacity_pressure",
    ],
    [
      "saturated swap but no /proc/pressure → NOT error (can't corroborate)",
      facts({ swap: saturated, pressure: null }),
      "ok",
      "diagnostics_hint_host_capacity_ok",
    ],
    [
      "pressure beats unbounded (precedence)",
      facts({ limited: false, pressure: { memory: 20, io: 0 } }),
      "error",
      "diagnostics_hint_host_capacity_pressure",
    ],
    // ── herdr dimension (#1839) ──
    [
      "Shepherd bounded but herdr unbounded → warning with the DISTINCT herdr hint (durability)",
      facts({ limited: true, herdrLimited: false }),
      "warning",
      "diagnostics_hint_host_capacity_herdr_unbounded",
    ],
    [
      "both bounded (e.g. via shared slice) → ok (slice-greens: no new warning)",
      facts({ limited: true, herdrLimited: true }),
      "ok",
      "diagnostics_hint_host_capacity_ok",
    ],
    [
      "Shepherd bounded, herdr unknown (absent/system/unreadable) → ok, not a spurious warning",
      facts({ limited: true, herdrLimited: null }),
      "ok",
      "diagnostics_hint_host_capacity_ok",
    ],
    [
      "Shepherd unbounded + herdr unknown → warning off Shepherd alone (generic unbounded hint)",
      facts({ limited: false, herdrLimited: null }),
      "warning",
      "diagnostics_hint_host_capacity_unbounded",
    ],
    [
      "both unbounded → warning (generic unbounded hint)",
      facts({ limited: false, herdrLimited: false }),
      "warning",
      "diagnostics_hint_host_capacity_unbounded",
    ],
  ];

  for (const [name, f, state, hintKey] of cases) {
    it(name, () => {
      const c = classifyHostCapacity(f);
      expect(c.id).toBe("host_capacity");
      expect(c.state).toBe(state);
      expect(c.hintKey).toBe(hintKey);
      assertPure(c);
    });
  }
});

describe("host_capacity fix emission (#1839)", () => {
  const GIB = 1024 ** 3;
  const facts = (o: Partial<HostCapacityFacts>): HostCapacityFacts => ({
    unit: "shepherd.service",
    userScope: true,
    limited: false,
    herdrLimited: false,
    swap: null,
    pressure: null,
    memTotal: 32 * GIB,
    cpuCount: 8,
    ...o,
  });

  it("user-scoped, both unbounded → lists BOTH units with computed values", () => {
    const c = classifyHostCapacity(facts({ limited: false, herdrLimited: false }));
    expect(c.fixActionKey).toBe("diagnostics_fix_action_host_capacity");
    expect(c.fixActionParams).toEqual({
      units: "shepherd.service herdr.service",
      memoryHigh: "27G",
      cpuQuota: "700%",
    });
    assertPure(c);
  });

  it("no-stomp: Shepherd already bounded, herdr unbounded → lists ONLY herdr", () => {
    const c = classifyHostCapacity(facts({ limited: true, herdrLimited: false }));
    expect(c.fixActionParams?.units).toBe("herdr.service");
  });

  it("Shepherd unbounded, herdr unknown → lists ONLY Shepherd's unit", () => {
    const c = classifyHostCapacity(facts({ limited: false, herdrLimited: null }));
    expect(c.fixActionParams?.units).toBe("shepherd.service");
  });

  it("system-scoped → doc-link only, no fixActionKey", () => {
    const c = classifyHostCapacity(facts({ userScope: false, herdrLimited: null }));
    expect(c.state).toBe("warning");
    expect(c.fixActionKey).toBeUndefined();
    expect(c.fixActionParams).toBeUndefined();
  });

  it("below MIN_TUNABLE (memTotal < 6 GiB) → doc-link only, no fixActionKey", () => {
    const c = classifyHostCapacity(facts({ memTotal: 4 * GIB }));
    expect(c.state).toBe("warning");
    expect(c.fixActionKey).toBeUndefined();
  });
});

describe("proposeHostLimits (#1839)", () => {
  const GIB = 1024 ** 3;
  it("32 GiB / 8 core → 27G / 700% (reserve capped, one core for OS)", () => {
    expect(proposeHostLimits(32 * GIB, 8)).toEqual({ memoryHigh: "27G", cpuQuota: "700%" });
  });
  it("6 GiB boundary → 4G (reserve floored at 2 GiB, still ≈67% of RAM)", () => {
    expect(proposeHostLimits(6 * GIB, 8).memoryHigh).toBe("4G");
  });
  it("2-core → 170% (85% ceiling, NOT a halved 100%)", () => {
    expect(proposeHostLimits(32 * GIB, 2).cpuQuota).toBe("170%");
  });
  it("4-core → 340%", () => {
    expect(proposeHostLimits(32 * GIB, 4).cpuQuota).toBe("340%");
  });
  it("1-core → 85% (leaves 15% headroom)", () => {
    expect(proposeHostLimits(32 * GIB, 1).cpuQuota).toBe("85%");
  });
  it("very large host → reserve capped at 8 GiB", () => {
    expect(proposeHostLimits(128 * GIB, 8).memoryHigh).toBe("120G");
  });
});

describe("herdrLimitFromProps (#1839 — the not-found regression pin)", () => {
  it("absent/non-user unit (LoadState=not-found, MemoryHigh=infinity) → null, NOT false", () => {
    expect(herdrLimitFromProps({ LoadState: "not-found", MemoryHigh: "infinity" })).toBeNull();
  });
  it("masked → null", () => {
    expect(herdrLimitFromProps({ LoadState: "masked" })).toBeNull();
  });
  it("loaded + no limit → false", () => {
    expect(herdrLimitFromProps({ LoadState: "loaded", MemoryHigh: "infinity" })).toBe(false);
  });
  it("loaded + a limit → true", () => {
    expect(herdrLimitFromProps({ LoadState: "loaded", MemoryHigh: "6G" })).toBe(true);
  });
});

describe("parseMemTotal (#1839)", () => {
  it("parses MemTotal kB → bytes", () => {
    expect(parseMemTotal("MemTotal:       32768000 kB\nSwapTotal: 0 kB\n")).toBe(32768000 * 1024);
  });
  it("null when absent", () => {
    expect(parseMemTotal("SwapTotal: 0 kB\n")).toBeNull();
  });
});

describe("host_capacity parsers", () => {
  it("parseCgroupUnit: v2 user service", () => {
    expect(
      parseCgroupUnit(
        "0::/user.slice/user-1000.slice/user@1000.service/app.slice/shepherd.service\n",
      ),
    ).toEqual({ unit: "shepherd.service", userScope: true });
  });
  it("parseCgroupUnit: v2 system service (no --user)", () => {
    expect(parseCgroupUnit("0::/system.slice/shepherd.service\n")).toEqual({
      unit: "shepherd.service",
      userScope: false,
    });
  });
  it("parseCgroupUnit: a login *.scope is not a managed service", () => {
    expect(
      parseCgroupUnit(
        "0::/user.slice/user-1000.slice/user@1000.service/app.slice/foot-server.scope\n",
      ),
    ).toEqual({ unit: null, userScope: true });
  });
  it("parseCgroupUnit: cgroup v1 (no 0:: line) → null", () => {
    expect(parseCgroupUnit("12:pids:/user.slice\n11:memory:/user.slice\n")).toEqual({
      unit: null,
      userScope: false,
    });
  });

  it("hasMeaningfulLimit: all infinity → false", () => {
    const p = parseSystemctlShow(
      "MemoryHigh=infinity\nMemoryMax=infinity\nCPUQuotaPerSecUSec=infinity\nTasksMax=4915\nSlice=app.slice",
    );
    expect(p.Slice).toBe("app.slice");
    expect(hasMeaningfulLimit(p)).toBe(false);
  });
  it("hasMeaningfulLimit: MemoryMax set → true", () => {
    expect(
      hasMeaningfulLimit(parseSystemctlShow("MemoryMax=25769803776\nCPUQuotaPerSecUSec=infinity")),
    ).toBe(true);
  });
  it("hasMeaningfulLimit: CPUQuota set → true", () => {
    expect(
      hasMeaningfulLimit(parseSystemctlShow("MemoryMax=infinity\nCPUQuotaPerSecUSec=12000000")),
    ).toBe(true);
  });
  it("hasMeaningfulLimit: TasksMax alone does NOT count", () => {
    expect(
      hasMeaningfulLimit(
        parseSystemctlShow(
          "MemoryHigh=infinity\nMemoryMax=infinity\nCPUQuotaPerSecUSec=infinity\nTasksMax=100",
        ),
      ),
    ).toBe(false);
  });

  it("parsePsiAvg10: reads the some-line avg10", () => {
    expect(
      parsePsiAvg10("some avg10=12.34 avg60=5.00 avg300=1.00 total=999\nfull avg10=6.00 total=42"),
    ).toBe(12.34);
  });
  it("parsePsiAvg10: no some line → null", () => {
    expect(parsePsiAvg10("")).toBe(null);
  });

  it("parseSwap: computes used bytes", () => {
    expect(parseSwap("SwapTotal:       8388604 kB\nSwapFree:        4194304 kB\n")).toEqual({
      total: 8388604 * 1024,
      used: (8388604 - 4194304) * 1024,
    });
  });
  it("parseSwap: no swap configured → total 0", () => {
    expect(parseSwap("SwapTotal:       0 kB\nSwapFree:        0 kB")).toEqual({
      total: 0,
      used: 0,
    });
  });
  it("parseSwap: missing fields → null", () => {
    expect(parseSwap("MemTotal:  123 kB")).toBe(null);
  });
});

describe("host_capacity probe (via injected readHostResources)", () => {
  it("unbounded facts → warning, degrades overall", async () => {
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      // system-scoped ⇒ doc-link only (no fixActionKey), so the existing warning/unbounded/pure
      // assertions are unchanged by the #1839 fix.
      readHostResources: async () => ({
        unit: "shepherd.service",
        userScope: false,
        limited: false,
        herdrLimited: null,
        swap: { total: 8_000_000_000, used: 100_000_000 },
        pressure: { memory: 0, io: 0 },
        memTotal: null,
        cpuCount: 8,
      }),
    });
    const snap = await svc.check(1000);
    const c = byId(snap.checks, "host_capacity");
    expect(c.state).toBe("warning");
    expect(c.hintKey).toBe("diagnostics_hint_host_capacity_unbounded");
    assertPure(c);
    expect(snap.overall).toBe("warning");
  });

  it("a rejecting host read falls back to optional/uninspectable (never reddens overall)", async () => {
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      readHostResources: async () => {
        throw new Error("boom");
      },
    });
    const snap = await svc.check(1000);
    const c = byId(snap.checks, "host_capacity");
    expect(c.state).toBe("optional");
    expect(c.hintKey).toBe("diagnostics_hint_host_capacity_uninspectable");
    assertPure(c);
    expect(snap.overall).toBe("ok"); // optional ranks 0, everything else healthy
  });
});

describe("classifyHerdrFleet", () => {
  it("a live orphan → warning (leftover)", () => {
    const c = classifyHerdrFleet({ orphanLive: 1, orphanHusk: 0 });
    expect(c).toEqual({
      id: "herdr_health",
      state: "warning",
      hintKey: "diagnostics_hint_herdr_health_leftover",
    });
    assertPure(c);
  });

  it("shell-only husks alone → ok (does NOT over-fire)", () => {
    const c = classifyHerdrFleet({ orphanLive: 0, orphanHusk: 3 });
    expect(c).toEqual({
      id: "herdr_health",
      state: "ok",
      hintKey: "diagnostics_hint_herdr_health_ok",
    });
    assertPure(c);
  });

  it("a clean fleet → ok", () => {
    const c = classifyHerdrFleet({ orphanLive: 0, orphanHusk: 0 });
    expect(c.state).toBe("ok");
    expect(c.hintKey).toBe("diagnostics_hint_herdr_health_ok");
  });
});

describe("herdr_health probe (via injected readHerdrFleet)", () => {
  it("a live orphan → warning, degrades overall", async () => {
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      readHerdrFleet: async () => ({ orphanLive: 2, orphanHusk: 0 }),
    });
    const snap = await svc.check(1000);
    const c = byId(snap.checks, "herdr_health");
    expect(c.state).toBe("warning");
    expect(c.hintKey).toBe("diagnostics_hint_herdr_health_leftover");
    assertPure(c);
    expect(snap.overall).toBe("warning");
  });

  it("a rejecting fleet read (herdr unreachable / unwired) → optional/uninspectable, never reddens overall", async () => {
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      readHerdrFleet: async () => {
        throw new Error("boom");
      },
    });
    const snap = await svc.check(1000);
    const c = byId(snap.checks, "herdr_health");
    expect(c.state).toBe("optional");
    expect(c.hintKey).toBe("diagnostics_hint_herdr_health_uninspectable");
    assertPure(c);
    expect(snap.overall).toBe("ok"); // optional ranks 0, everything else healthy
  });

  it("without an injected readHerdrFleet the fail-safe reject lands on optional/uninspectable", async () => {
    // No functional ctor default: an unwired service must NOT report a false ok/warning.
    const deps = healthyDeps();
    delete deps.readHerdrFleet;
    const svc = new DiagnosticsService(deps);
    const c = byId((await svc.check(1000)).checks, "herdr_health");
    expect(c.state).toBe("optional");
    expect(c.hintKey).toBe("diagnostics_hint_herdr_health_uninspectable");
  });
});

describe("defaultReadHerdrFleet (session ↔ fleet join)", () => {
  // Minimal HerdrAgent builder — only the fields the reconciliation reads matter.
  function agent(over: Partial<HerdrAgent>): HerdrAgent {
    return {
      agent: "claude",
      agentStatus: "idle",
      cwd: "/w",
      name: "task-07",
      paneId: "w1:t1",
      tabId: "t1",
      terminalId: "term-1",
      workspaceId: "w1",
      ...over,
    };
  }
  // Structural session subset matchAgents needs.
  function session(over: {
    id: string;
    herdrAgentId: string;
    worktreePath?: string;
    name?: string;
  }) {
    return { worktreePath: "/w", name: "task-07", ...over };
  }
  function fakeStore(sessions: ReturnType<typeof session>[]) {
    return { list: () => sessions } as unknown as Parameters<typeof defaultReadHerdrFleet>[0];
  }
  function fakeHerdr(
    agents: HerdrAgent[],
    procs: Record<string, string[]>,
  ): Parameters<typeof defaultReadHerdrFleet>[1] {
    return {
      listAsync: async () => agents,
      paneForegroundProcs: async (paneId: string) => {
        if (!(paneId in procs)) throw new Error(`no procs for ${paneId}`);
        return procs[paneId]!;
      },
    };
  }

  it("counts an unclaimed non-helper pane with a live proc as orphanLive", async () => {
    const facts = await defaultReadHerdrFleet(
      fakeStore([]), // no sessions → the agent is unclaimed
      fakeHerdr([agent({ terminalId: "term-1", paneId: "p1", name: "task-07" })], {
        p1: ["node", "claude"], // a live non-shell proc
      }),
    );
    expect(facts).toEqual({ orphanLive: 1, orphanHusk: 0 });
  });

  it("a claimed pane (adopted by an active session) is never counted", async () => {
    const facts = await defaultReadHerdrFleet(
      fakeStore([session({ id: "s1", herdrAgentId: "term-1" })]),
      fakeHerdr([agent({ terminalId: "term-1", paneId: "p1" })], { p1: ["node"] }),
    );
    expect(facts).toEqual({ orphanLive: 0, orphanHusk: 0 });
  });

  it("a Shepherd helper agent is excluded even with a live proc", async () => {
    const facts = await defaultReadHerdrFleet(
      fakeStore([]),
      fakeHerdr([agent({ terminalId: "term-h", paneId: "ph", name: "review TASK-07" })], {
        ph: ["node", "claude"],
      }),
    );
    expect(facts).toEqual({ orphanLive: 0, orphanHusk: 0 });
  });

  it("a shell-only orphan pane counts as orphanHusk, not orphanLive", async () => {
    const facts = await defaultReadHerdrFleet(
      fakeStore([]),
      fakeHerdr([agent({ terminalId: "term-1", paneId: "p1" })], { p1: ["zsh"] }),
    );
    expect(facts).toEqual({ orphanLive: 0, orphanHusk: 1 });
  });

  it("fail-closed: a throwing or empty proc read is never counted", async () => {
    const facts = await defaultReadHerdrFleet(
      fakeStore([]),
      fakeHerdr(
        [
          agent({ terminalId: "term-empty", paneId: "pe" }),
          agent({ terminalId: "term-throw", paneId: "pt" }),
        ],
        { pe: [] /* pt throws (absent) */ },
      ),
    );
    expect(facts).toEqual({ orphanLive: 0, orphanHusk: 0 });
  });

  it("propagates a herdr-unreachable listAsync rejection (→ probe onTimeout)", async () => {
    const herdr = {
      listAsync: async () => {
        throw new Error("ECONNREFUSED");
      },
      paneForegroundProcs: async () => [],
    } as Parameters<typeof defaultReadHerdrFleet>[1];
    await expect(defaultReadHerdrFleet(fakeStore([]), herdr)).rejects.toThrow("ECONNREFUSED");
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

  it("checks the provider-specific global Codex default", async () => {
    const savedProvider = config.defaultAgentProvider;
    const savedClaudeModel = config.defaultModel;
    const savedCodexModel = config.defaultCodexModel;
    config.defaultAgentProvider = "codex";
    config.defaultModel = "sonnet";
    config.defaultCodexModel = "gpt-5.3-codex";
    try {
      const svc = new DiagnosticsService({
        ...healthyDeps(),
        readCodexAuthMode: () => "chatgpt",
      });
      const c = byId((await svc.check(0)).checks, "codex_model_auth");
      expect(c.state).toBe("warning");
    } finally {
      config.defaultAgentProvider = savedProvider;
      config.defaultModel = savedClaudeModel;
      config.defaultCodexModel = savedCodexModel;
    }
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

  it("warns for a blocklisted per-repo or epic Codex model under chatgpt auth", async () => {
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      readCodexAuthMode: () => "chatgpt",
      configuredCodexModels: () => ["gpt-5.3-codex"],
    });
    const c = byId((await svc.check(0)).checks, "codex_model_auth");
    expect(c.state).toBe("warning");
    expect(c.hintKey).toBe("diagnostics_hint_codex_model_chatgpt_incompatible");
  });

  it("does NOT warn for configured Codex models under apikey auth", async () => {
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      readCodexAuthMode: () => "apikey",
      configuredCodexModels: () => ["gpt-5.3-codex"],
    });
    const checks = (await svc.check(0)).checks;
    expect(checks.find((c) => c.id === "codex_model_auth")).toBeUndefined();
  });
});

// ── tmp_inodes check (#1862) ────────────────────────────────────────────────────
describe("classifyTmpInodes", () => {
  // Bands are PASSED, never read from env here — that is the whole point of the parameterisation:
  // the row must warn at exactly the point `SHEPHERD_TMP_INODE_PCT` makes the sweeper act.
  const facts = (usePct: number | null, warnPct = 80, errorPct = 95) => ({
    usePct,
    warnPct,
    errorPct,
  });

  it("below the warning band → ok", () => {
    const c = classifyTmpInodes(facts(46));
    expect(c).toEqual({ id: "tmp_inodes", state: "ok", hintKey: "diagnostics_hint_tmp_inodes_ok" });
  });

  it("at/over the warning band → warning, with the forced-sweep fix offered", () => {
    for (const pct of [80, 94.9]) {
      const c = classifyTmpInodes(facts(pct));
      expect(c.state).toBe("warning");
      expect(c.fixActionKey).toBe("diagnostics_fix_action_tmp_inodes");
    }
  });

  it("at/over the error band → error, still offering the fix", () => {
    for (const pct of [95, 100]) {
      const c = classifyTmpInodes(facts(pct));
      expect(c.state).toBe("error");
      expect(c.fixActionKey).toBe("diagnostics_fix_action_tmp_inodes");
    }
  });

  it("a raised SHEPHERD_TMP_INODE_PCT moves the warning boundary", () => {
    // 85% is a warning at the default band but deliberately ignored by an operator who raised the
    // sweep threshold to 90 — the row must not warn about a state the sweeper won't act on.
    expect(classifyTmpInodes(facts(85, 80)).state).toBe("warning");
    expect(classifyTmpInodes(facts(85, 90)).state).toBe("ok");
    expect(classifyTmpInodes(facts(92, 90)).state).toBe("warning");
  });

  it("null use% → optional/uninspectable, never a pip degrade and never a fix", () => {
    // Covers BOTH read failures: statfs absent (non-Linux), and a btrfs tmp reporting files: 0
    // (it allocates inodes dynamically, so a percentage would be meaningless).
    const c = classifyTmpInodes(facts(null));
    expect(c).toEqual({
      id: "tmp_inodes",
      state: "optional",
      hintKey: "diagnostics_hint_tmp_inodes_uninspectable",
    });
    expect(c.fixActionKey).toBeUndefined();
  });
});

describe("tmp_inodes probe + fix dispatch", () => {
  it("surfaces the row from injected facts", async () => {
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      readTmpInodes: async () => ({ usePct: 99, warnPct: 80, errorPct: 95 }),
    });
    const checks = (await svc.check(0)).checks;
    expect(checks.find((c) => c.id === "tmp_inodes")?.state).toBe("error");
  });

  it("an unreadable temp filesystem resolves to optional, never a false ok", async () => {
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      readTmpInodes: async () => {
        throw new Error("statfs blew up");
      },
    });
    const checks = (await svc.check(0)).checks;
    expect(checks.find((c) => c.id === "tmp_inodes")).toEqual({
      id: "tmp_inodes",
      state: "optional",
      hintKey: "diagnostics_hint_tmp_inodes_uninspectable",
    });
  });

  it("fix() dispatches the forced sweep", async () => {
    let swept = 0;
    const svc = new DiagnosticsService({
      ...healthyDeps(),
      readTmpInodes: async () => ({ usePct: 99, warnPct: 80, errorPct: 95 }),
      runTmpSweep: async () => {
        swept += 1;
      },
    });
    await svc.check(0);
    await svc.fix("tmp_inodes", 1);
    expect(swept).toBe(1);
  });
});

describe("classifyPreviewProbes (#1912)", () => {
  it("ok only when the probe is ok AND the live cell is fresh", () => {
    expect(classifyPreviewProbes("ok", "fresh")).toEqual({
      id: "preview_probes",
      state: "ok",
      hintKey: "diagnostics_hint_preview_probes_ok",
    });
  });

  it("probe failure warns (unavailable) and takes precedence over a stale cell", () => {
    expect(classifyPreviewProbes("unavailable", "stale")).toEqual({
      id: "preview_probes",
      state: "warning",
      hintKey: "diagnostics_hint_preview_probes_unavailable",
    });
  });

  it("probe ok but a frozen cell (none/stale) warns stale — the 5s-vs-3s gap case", () => {
    for (const cell of ["none", "stale"] as const) {
      expect(classifyPreviewProbes("ok", cell)).toEqual({
        id: "preview_probes",
        state: "warning",
        hintKey: "diagnostics_hint_preview_probes_stale",
      });
    }
  });

  it("an unsupported platform warns unsupported", () => {
    expect(classifyPreviewProbes("unsupported", "none")).toEqual({
      id: "preview_probes",
      state: "warning",
      hintKey: "diagnostics_hint_preview_probes_unsupported",
    });
  });

  it("the probe reads the LIVE cell health, not a fresh backend (frozen-cell detection)", async () => {
    // Probe reports ok (its own spawn succeeds within the 5s budget), but the live
    // cell is frozen by 3s refresh timeouts → the check must still warn.
    const svc = new DiagnosticsService({
      runPreviewProbe: async () => "ok",
      probeHealth: () => "stale",
    });
    const snap = await svc.check(0);
    const row = snap.checks.find((c) => c.id === "preview_probes");
    expect(row?.state).toBe("warning");
    expect(row?.hintKey).toBe("diagnostics_hint_preview_probes_stale");
  });
});
