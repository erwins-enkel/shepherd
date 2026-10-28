import { describe, expect, test } from "bun:test";
import {
  autoBlockers,
  providerSwitchSettings,
  remoteIsHttps,
  type AutoBlockers,
} from "../src/auto-blockers";
import { autoHoldCode, codexAutoHoldReason, type SandboxProfile } from "../src/sandbox";
import type { AgentProvider } from "../src/types";

const HOST_OK = { bwrap: true, egress: true };

describe("autoBlockers — the design's three cases (#3453)", () => {
  test("A · standard + Codex: Autonomous + Claude Code preselected, Trusted, Autonomous alone can't", () => {
    expect(
      autoBlockers({ agentProvider: "codex" }, { profile: "standard", remoteHttps: true }, HOST_OK),
    ).toEqual({
      agentProvider: "codex",
      causes: [
        {
          code: "sandbox_interactive",
          scope: "repo",
          detail: "standard",
          fix: {
            changes: { sandboxProfile: "autonomous" },
            enabled: true,
            checks: [
              { id: "bwrap", ok: true },
              { id: "egress", ok: true },
              { id: "remote_https", ok: true },
            ],
          },
        },
        {
          code: "sandbox_provider_unconfined",
          scope: "epic",
          detail: "codex",
          fix: { changes: { agentProvider: "claude" }, enabled: true, checks: [] },
        },
      ],
      options: [
        {
          id: "autonomous_claude",
          changes: { sandboxProfile: "autonomous", agentProvider: "claude" },
          enabled: true,
          checks: [
            { id: "bwrap", ok: true },
            { id: "egress", ok: true },
            { id: "remote_https", ok: true },
          ],
        },
        { id: "trusted", changes: { sandboxProfile: "trusted" }, enabled: true, checks: [] },
        {
          id: "autonomous",
          changes: { sandboxProfile: "autonomous" },
          enabled: false,
          why: "cli",
          checks: [
            { id: "cli", ok: false },
            { id: "bwrap", ok: true },
            { id: "egress", ok: true },
            { id: "remote_https", ok: true },
          ],
        },
      ],
      preselect: "autonomous_claude",
    } satisfies AutoBlockers);
  });

  test("B · standard + Claude Code: Autonomous preselected, Trusted", () => {
    expect(
      autoBlockers(
        { agentProvider: "claude" },
        { profile: "standard", remoteHttps: true },
        HOST_OK,
      ),
    ).toEqual({
      agentProvider: "claude",
      causes: [
        {
          code: "sandbox_interactive",
          scope: "repo",
          detail: "standard",
          fix: {
            changes: { sandboxProfile: "autonomous" },
            enabled: true,
            checks: [
              { id: "bwrap", ok: true },
              { id: "egress", ok: true },
              { id: "remote_https", ok: true },
            ],
          },
        },
      ],
      options: [
        {
          id: "autonomous",
          changes: { sandboxProfile: "autonomous" },
          enabled: true,
          checks: [
            { id: "cli", ok: true },
            { id: "bwrap", ok: true },
            { id: "egress", ok: true },
            { id: "remote_https", ok: true },
          ],
        },
        { id: "trusted", changes: { sandboxProfile: "trusted" }, enabled: true, checks: [] },
      ],
      preselect: "autonomous",
    } satisfies AutoBlockers);
  });

  test("C · no bubblewrap and an SSH remote: Autonomous disabled with its failed checks, Trusted the only way", () => {
    expect(
      autoBlockers(
        { agentProvider: "claude" },
        { profile: "standard", remoteHttps: false },
        { bwrap: false, egress: true },
      ),
    ).toEqual({
      agentProvider: "claude",
      causes: [
        {
          code: "sandbox_interactive",
          scope: "repo",
          detail: "standard",
          fix: {
            changes: { sandboxProfile: "autonomous" },
            enabled: false,
            why: "bwrap",
            checks: [
              { id: "bwrap", ok: false },
              { id: "egress", ok: true },
              { id: "remote_https", ok: false },
            ],
          },
        },
        { code: "sandbox_backend_unavailable", scope: "host", detail: "standard" },
      ],
      options: [
        {
          id: "autonomous",
          changes: { sandboxProfile: "autonomous" },
          enabled: false,
          why: "bwrap",
          checks: [
            { id: "cli", ok: true },
            { id: "bwrap", ok: false },
            { id: "egress", ok: true },
            { id: "remote_https", ok: false },
          ],
        },
        { id: "trusted", changes: { sandboxProfile: "trusted" }, enabled: true, checks: [] },
      ],
      preselect: "trusted",
    } satisfies AutoBlockers);
  });

  test("C′ · only an SSH remote: Autonomous disabled on remote_https, Trusted the only way", () => {
    const r = autoBlockers(
      { agentProvider: "claude" },
      { profile: "standard", remoteHttps: false },
      HOST_OK,
    );
    expect(r.causes.map((c) => [c.code, c.fix?.enabled, c.fix?.why])).toEqual([
      ["sandbox_interactive", false, "remote_https"],
    ]);
    expect(r.options.map((o) => [o.id, o.enabled, o.why])).toEqual([
      ["autonomous", false, "remote_https"],
      ["trusted", true, undefined],
    ]);
    expect(r.preselect).toBe("trusted");
  });
});

describe("autoBlockers — other states", () => {
  test("trusted reports nothing, whatever the CLI, host or remote", () => {
    for (const agentProvider of ["claude", "codex"] as const)
      expect(
        autoBlockers(
          { agentProvider },
          { profile: "trusted", remoteHttps: false },
          { bwrap: false, egress: false },
        ),
      ).toEqual({ agentProvider, causes: [], options: [], preselect: null });
  });

  test("autonomous + Codex: switching the CLI alone is the confined way", () => {
    const r = autoBlockers(
      { agentProvider: "codex" },
      { profile: "autonomous", remoteHttps: true },
      HOST_OK,
    );
    expect(r.causes).toEqual([
      {
        code: "sandbox_provider_unconfined",
        scope: "epic",
        detail: "codex",
        fix: { changes: { agentProvider: "claude" }, enabled: true, checks: [] },
      },
    ]);
    expect(r.options.map((o) => [o.id, o.changes, o.enabled])).toEqual([
      ["autonomous_claude", { agentProvider: "claude" }, true],
      ["trusted", { sandboxProfile: "trusted" }, true],
    ]);
    expect(r.preselect).toBe("autonomous_claude");
  });

  test("autonomous + Claude Code without an egress backend: Trusted is the only way", () => {
    const r = autoBlockers(
      { agentProvider: "claude" },
      { profile: "autonomous", remoteHttps: true },
      { bwrap: true, egress: false },
    );
    expect(r.causes).toEqual([
      { code: "sandbox_egress_unavailable", scope: "host", detail: "autonomous" },
    ]);
    expect(r.options.map((o) => o.id)).toEqual(["trusted"]);
    expect(r.preselect).toBe("trusted");
  });

  test("an autonomous repo with Claude Code and a working host reports nothing", () => {
    expect(
      autoBlockers(
        { agentProvider: "claude" },
        { profile: "autonomous", remoteHttps: true },
        HOST_OK,
      ),
    ).toEqual({ agentProvider: "claude", causes: [], options: [], preselect: null });
  });
});

describe("autoBlockers agrees with the drain's spawn gate (#3452)", () => {
  const PROFILES: SandboxProfile[] = ["trusted", "standard", "autonomous"];
  const PROVIDERS: AgentProvider[] = ["claude", "codex"];
  const BOOLS = [true, false];

  /** The hold code DrainService.spawnSandboxHold reports, or null when the spawn may start. */
  function gate(
    profile: SandboxProfile,
    provider: AgentProvider,
    host: { bwrap: boolean; egress: boolean },
  ): string | null {
    if (codexAutoHoldReason(provider, profile)) return "sandbox_provider_unconfined";
    const backend = profile === "trusted" || !host.bwrap ? null : "bwrap";
    const egress =
      profile === "autonomous" && backend !== null
        ? host.egress
          ? "slirp4netns"
          : null
        : undefined;
    return autoHoldCode(profile, backend, egress);
  }

  const states = PROFILES.flatMap((profile) =>
    PROVIDERS.flatMap((agentProvider) =>
      BOOLS.flatMap((bwrap) =>
        BOOLS.flatMap((egress) =>
          BOOLS.map((remoteHttps) => ({ profile, agentProvider, bwrap, egress, remoteHttps })),
        ),
      ),
    ),
  );

  test("no causes exactly when the gate passes; otherwise the gate's code is among them", () => {
    for (const s of states) {
      const host = { bwrap: s.bwrap, egress: s.egress };
      const r = autoBlockers(s, s, host);
      const hold = gate(s.profile, s.agentProvider, host);
      if (hold === null) expect(r.causes, JSON.stringify(s)).toEqual([]);
      else
        expect(
          r.causes.map((c) => c.code),
          JSON.stringify(s),
        ).toContain(hold as never);
    }
  });

  test("every enabled option produces a state the gate lets start, with an https remote", () => {
    for (const s of states) {
      const host = { bwrap: s.bwrap, egress: s.egress };
      for (const o of autoBlockers(s, s, host).options.filter((o) => o.enabled)) {
        const profile = o.changes.sandboxProfile ?? s.profile;
        const provider = o.changes.agentProvider ?? s.agentProvider;
        expect(gate(profile, provider, host), `${o.id} ${JSON.stringify(s)}`).toBeNull();
        if (profile !== "trusted") expect(s.remoteHttps).toBe(true);
      }
    }
  });

  test("Trusted is preselected only when it is the sole enabled option", () => {
    for (const s of states) {
      const r = autoBlockers(s, s, { bwrap: s.bwrap, egress: s.egress });
      if (r.preselect !== "trusted") continue;
      expect(r.options.filter((o) => o.enabled).map((o) => o.id)).toEqual(["trusted"]);
    }
  });

  test("an enabled cause fix clears every cause of its scope, the repo's its host causes too (#3456)", () => {
    for (const s of states) {
      const host = { bwrap: s.bwrap, egress: s.egress };
      for (const c of autoBlockers(s, s, host).causes) {
        if (!c.fix?.enabled) continue;
        const after = autoBlockers(
          { agentProvider: c.fix.changes.agentProvider ?? s.agentProvider },
          { ...s, profile: c.fix.changes.sandboxProfile ?? s.profile },
          host,
        );
        const cleared = c.scope === "repo" ? ["repo", "host"] : [c.scope];
        expect(
          after.causes.filter((a) => cleared.includes(a.scope)),
          `${c.code} ${JSON.stringify(s)}`,
        ).toEqual([]);
      }
    }
  });

  test("only the repo's sandbox and the epic's CLI carry a fix; host causes never do (#3456)", () => {
    for (const s of states) {
      for (const c of autoBlockers(s, s, { bwrap: s.bwrap, egress: s.egress }).causes) {
        if (c.scope === "host") expect(c.fix, JSON.stringify(s)).toBeUndefined();
        else expect(c.fix, JSON.stringify(s)).toBeDefined();
      }
    }
  });

  test("the repo's fix is enabled exactly when this host and remote can confine, whatever the CLI (#3456)", () => {
    for (const s of states) {
      const r = autoBlockers(s, s, { bwrap: s.bwrap, egress: s.egress });
      const repoFix = r.causes.find((c) => c.code === "sandbox_interactive")?.fix;
      if (!repoFix) continue;
      expect(repoFix.enabled, JSON.stringify(s)).toBe(s.bwrap && s.egress && s.remoteHttps);
    }
  });

  test("names the CLI the children spawn with, blocked or not (#3456)", () => {
    for (const s of states)
      expect(autoBlockers(s, s, { bwrap: s.bwrap, egress: s.egress }).agentProvider).toBe(
        s.agentProvider,
      );
  });

  test("no option is a no-op", () => {
    for (const s of states) {
      for (const o of autoBlockers(s, s, { bwrap: s.bwrap, egress: s.egress }).options) {
        const changed =
          (o.changes.sandboxProfile !== undefined && o.changes.sandboxProfile !== s.profile) ||
          (o.changes.agentProvider !== undefined && o.changes.agentProvider !== s.agentProvider);
        expect(changed, `${o.id} ${JSON.stringify(s)}`).toBe(true);
      }
    }
  });
});

describe("remoteIsHttps", () => {
  test("only an https remote passes", () => {
    expect(remoteIsHttps("https://github.com/o/r.git")).toBe(true);
    expect(remoteIsHttps("https://x-access-token:t@github.com/o/r")).toBe(true);
    expect(remoteIsHttps("HTTPS://github.com/o/r")).toBe(true);
    expect(remoteIsHttps("git@github.com:o/r.git")).toBe(false);
    expect(remoteIsHttps("ssh://git@github.com/o/r.git")).toBe(false);
    expect(remoteIsHttps("http://gitea.local/o/r")).toBe(false);
    expect(remoteIsHttps(null)).toBe(false);
  });
});

describe("providerSwitchSettings", () => {
  test("drops a model and an effort the new CLI doesn't offer, keeps the rest", () => {
    expect(providerSwitchSettings({ model: "gpt-5.5", effort: "ultra" }, "claude")).toEqual({
      agentProvider: "claude",
      model: null,
      effort: null,
    });
    expect(providerSwitchSettings({ model: "gpt-5.5", effort: "high" }, "claude")).toEqual({
      agentProvider: "claude",
      model: null,
      effort: "high",
    });
    expect(providerSwitchSettings({ model: null, effort: null }, "claude")).toEqual({
      agentProvider: "claude",
      model: null,
      effort: null,
    });
    expect(providerSwitchSettings({}, "claude")).toEqual({
      agentProvider: "claude",
      model: null,
      effort: null,
    });
  });

  test("keeps a model the new CLI runs", () => {
    expect(providerSwitchSettings({ model: "opus", effort: "max" }, "claude")).toEqual({
      agentProvider: "claude",
      model: "opus",
      effort: "max",
    });
  });
});
