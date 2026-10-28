import { describe, it, expect } from "vitest";
import type {
  DrainRunSummary,
  EpicAutoBlockers,
  EpicAutoFixOption,
  EpicChild,
} from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";
import {
  causeView,
  confirmText,
  haltedSettings,
  haltSummary,
  issueList,
  optionView,
  startable,
} from "./epic-auto-fix";

const ok = (id: string) => ({ id, ok: true });
const bad = (id: string) => ({ id, ok: false });

// The design's three cases ("Behebung" artboard), as GET /api/epic/auto-fix answers them.
// A: Standard + Codex — two causes, three ways, Autonomous alone disabled by the CLI.
const FALL_A: EpicAutoBlockers = {
  causes: [
    { code: "sandbox_interactive", scope: "repo", detail: "standard" },
    { code: "sandbox_provider_unconfined", scope: "epic", detail: "codex" },
  ],
  options: [
    {
      id: "autonomous_claude",
      changes: { sandboxProfile: "autonomous", agentProvider: "claude" },
      enabled: true,
      checks: [ok("bwrap"), ok("egress"), ok("remote_https")],
    },
    { id: "trusted", changes: { sandboxProfile: "trusted" }, enabled: true, checks: [] },
    {
      id: "autonomous",
      changes: { sandboxProfile: "autonomous" },
      enabled: false,
      why: "cli",
      checks: [bad("cli"), ok("bwrap"), ok("egress"), ok("remote_https")],
    },
  ],
  preselect: "autonomous_claude",
};
// B: Standard + Claude Code — one cause, Autonomous or Trusted.
const FALL_B: EpicAutoBlockers = {
  causes: [{ code: "sandbox_interactive", scope: "repo", detail: "standard" }],
  options: [
    {
      id: "autonomous",
      changes: { sandboxProfile: "autonomous" },
      enabled: true,
      checks: [ok("cli"), ok("bwrap"), ok("egress"), ok("remote_https")],
    },
    { id: "trusted", changes: { sandboxProfile: "trusted" }, enabled: true, checks: [] },
  ],
  preselect: "autonomous",
};
// C: host and remote block Autonomous — Trusted is the only way.
const FALL_C: EpicAutoBlockers = {
  causes: [
    { code: "sandbox_interactive", scope: "repo", detail: "standard" },
    { code: "sandbox_backend_unavailable", scope: "host", detail: "standard" },
  ],
  options: [
    {
      id: "autonomous",
      changes: { sandboxProfile: "autonomous" },
      enabled: false,
      why: "bwrap",
      checks: [ok("cli"), bad("bwrap"), ok("egress"), bad("remote_https")],
    },
    { id: "trusted", changes: { sandboxProfile: "trusted" }, enabled: true, checks: [] },
  ],
  preselect: "trusted",
};

const view = (b: EpicAutoBlockers, id: string) =>
  optionView(b.options.find((o) => o.id === id) as EpicAutoFixOption, b, "hundesport");

describe("causeView", () => {
  it("names the setting at fault and its scope chip", () => {
    expect(causeView(FALL_A.causes[0]!)).toEqual({
      scope: "repo",
      scopeLabel: m.epic_autofix_scope_repo(),
      what: m.epic_autofix_cause_interactive_what(),
      why: m.epic_autofix_cause_interactive_why(),
    });
    expect(causeView(FALL_A.causes[1]!)).toMatchObject({
      scopeLabel: m.epic_autofix_scope_epic(),
      what: m.epic_autofix_cli({ cli: m.agent_provider_codex() }),
      why: m.epic_autofix_cause_provider_why(),
    });
    expect(causeView(FALL_C.causes[1]!)).toMatchObject({
      scopeLabel: m.epic_autofix_scope_host(),
      what: m.epic_autofix_cause_backend_what(),
    });
    expect(
      causeView({ code: "sandbox_egress_unavailable", scope: "host", detail: "autonomous" }).what,
    ).toBe(m.epic_autofix_cause_egress_what());
  });

  it("an unknown code or scope (open enum) reads generically instead of failing", () => {
    expect(causeView({ code: "future_gate", scope: "lauf", detail: "x" })).toEqual({
      scope: "lauf",
      scopeLabel: "LAUF",
      what: "",
      why: m.epic_autofix_cause_other(),
    });
  });
});

describe("optionView", () => {
  it("Fall A: Autonomous + Claude Code changes repo and epic, lists its passing checks", () => {
    expect(view(FALL_A, "autonomous_claude")).toEqual({
      id: "autonomous_claude",
      enabled: true,
      title: `${m.epic_autofix_title_sandbox({ profile: m.epic_autofix_profile_autonomous() })} + ${m.epic_autofix_cli({ cli: m.agent_provider_claude() })}`,
      where: m.epic_autofix_where_both(),
      body: m.epic_autofix_body_confined(),
      change: m.epic_autofix_change_cli({
        from: m.agent_provider_codex(),
        to: m.agent_provider_claude(),
      }),
      risk: null,
      checks: [
        { ok: true, text: m.epic_autofix_check_bwrap_ok() },
        { ok: true, text: m.epic_autofix_check_egress_ok() },
        { ok: true, text: m.epic_autofix_check_remote_ok() },
      ],
      disabledWhy: null,
      disabledHint: null,
    });
  });

  it("Fall A: Trusted keeps Codex and carries its risk", () => {
    expect(view(FALL_A, "trusted")).toMatchObject({
      enabled: true,
      title: m.epic_autofix_title_sandbox({ profile: m.epic_autofix_profile_trusted() }),
      where: m.epic_autofix_where_repo({ repo: "hundesport" }),
      body: m.epic_autofix_body_keeps_cli({ cli: m.agent_provider_codex() }),
      change: null,
      risk: m.epic_autofix_risk_trusted({ repo: "hundesport" }),
      checks: [],
    });
  });

  it("Fall A: Autonomous alone is 'not enough' because of the CLI, with no ticks", () => {
    expect(view(FALL_A, "autonomous")).toMatchObject({
      enabled: false,
      title: m.epic_autofix_title_autonomous_only(),
      body: null,
      checks: [],
      disabledWhy: m.epic_autofix_disabled_cli({ cli: m.agent_provider_codex() }),
      disabledHint: null,
    });
  });

  it("Fall B: Autonomous says nothing else changes; Trusted has only its risk", () => {
    expect(view(FALL_B, "autonomous")).toMatchObject({
      title: m.epic_autofix_title_sandbox({ profile: m.epic_autofix_profile_autonomous() }),
      body: `${m.epic_autofix_body_confined()} ${m.epic_autofix_body_nothing_else()}`,
      change: null,
    });
    expect(view(FALL_B, "autonomous").checks).toHaveLength(3); // the CLI check is never a tick
    expect(view(FALL_B, "trusted")).toMatchObject({
      body: null,
      risk: m.epic_autofix_risk_trusted({ repo: "hundesport" }),
    });
  });

  it("Fall C: disabled Autonomous lists its failing checks and the host hint; Trusted is the only way", () => {
    expect(view(FALL_C, "autonomous")).toMatchObject({
      enabled: false,
      title: m.epic_autofix_title_sandbox({ profile: m.epic_autofix_profile_autonomous() }),
      checks: [
        { ok: false, text: m.epic_autofix_check_bwrap_fail() },
        { ok: false, text: m.epic_autofix_check_remote_fail() },
      ],
      disabledWhy: null,
      disabledHint: m.epic_autofix_disabled_host(),
    });
    expect(view(FALL_C, "trusted").body).toBe(m.epic_autofix_body_only_way());
  });

  it("a remote-only failure points at the remote", () => {
    const b: EpicAutoBlockers = {
      ...FALL_C,
      options: [{ ...FALL_C.options[0]!, why: "remote_https" }, FALL_C.options[1]!],
    };
    expect(view(b, "autonomous").disabledHint).toBe(m.epic_autofix_disabled_remote());
  });

  it("an already autonomous repo: the switch to Claude Code changes only this epic", () => {
    const b: EpicAutoBlockers = {
      causes: [{ code: "sandbox_provider_unconfined", scope: "epic", detail: "codex" }],
      options: [
        {
          id: "autonomous_claude",
          changes: { agentProvider: "claude" },
          enabled: true,
          checks: [ok("bwrap"), ok("egress"), ok("remote_https")],
        },
        { id: "trusted", changes: { sandboxProfile: "trusted" }, enabled: true, checks: [] },
      ],
      preselect: "autonomous_claude",
    };
    expect(view(b, "autonomous_claude")).toMatchObject({
      title: m.epic_autofix_cli({ cli: m.agent_provider_claude() }),
      where: m.epic_autofix_where_epic(),
    });
  });
});

function child(number: number, state: EpicChild["state"]): EpicChild {
  return {
    number,
    title: `c${number}`,
    url: "u",
    order: number,
    body: "",
    blockedBy: [],
    state,
    sessionId: null,
    prNumber: null,
    issueClosed: false,
    claimed: false,
  };
}

function summary(used: number, max: number, next: number[]): DrainRunSummary {
  return {
    leadingEpic: 35,
    windingDown: [],
    slots: { used, max, holders: [] },
    next,
    after: [],
  };
}

describe("startable", () => {
  const epic = {
    children: [child(19, "blocked"), child(18, "ready"), child(17, "ready"), child(20, "ready")],
  };

  it("orders the ready children as the drain would start them, limited to free slots", () => {
    expect(startable(epic, summary(0, 2, [17, 18, 20]))).toEqual({
      ready: [17, 18, 20],
      starting: [17, 18],
    });
    expect(startable(epic, summary(1, 2, [17, 18, 20])).starting).toEqual([17]);
    expect(startable(epic, summary(2, 2, [17])).starting).toEqual([]);
  });

  it("children the drain doesn't list keep their epic order, behind the listed ones", () => {
    expect(startable(epic, summary(0, 3, [20])).ready).toEqual([20, 18, 17]);
  });

  it("promises no start without a run picture", () => {
    expect(startable(epic, null)).toEqual({ ready: [18, 17, 20], starting: [] });
  });
});

describe("issueList / confirmText", () => {
  it("joins issue numbers as a localized list", () => {
    expect(issueList([17])).toBe("#17");
    expect(issueList([17, 18])).toMatch(/^#17 .+ #18$/);
  });

  it("states what the fix set", () => {
    expect(
      confirmText({ sandboxProfile: "autonomous", agentProvider: "claude" }, "hundesport"),
    ).toBe(
      `${m.epic_autofix_done_sandbox({ repo: "hundesport", profile: m.epic_autofix_profile_autonomous() })} ${m.epic_autofix_done_cli({ cli: m.agent_provider_claude() })}`,
    );
    expect(confirmText({ sandboxProfile: "trusted" }, "hundesport")).toBe(
      m.epic_autofix_done_sandbox({
        repo: "hundesport",
        profile: m.epic_autofix_profile_trusted(),
      }),
    );
  });
});

describe("haltedSettings", () => {
  it("marks the CLI for an epic cause and the sandbox for a repo cause", () => {
    expect(haltedSettings(FALL_A, "sandbox_provider_unconfined")).toEqual({
      cli: true,
      sandbox: true,
    });
    expect(haltedSettings(FALL_C, "sandbox_interactive")).toEqual({ cli: false, sandbox: true });
    expect(haltedSettings({ causes: [], options: [], preselect: null }, null)).toEqual({
      cli: false,
      sandbox: false,
    });
  });

  it("falls back to the drain's hold reason until the model loads", () => {
    expect(haltedSettings(null, "sandbox_provider_unconfined")).toEqual({
      cli: true,
      sandbox: false,
    });
    expect(haltedSettings(null, "sandbox_interactive")).toEqual({ cli: false, sandbox: true });
    expect(haltedSettings(null, "sandbox_backend_unavailable")).toEqual({
      cli: false,
      sandbox: false,
    });
    expect(haltedSettings(null, null)).toEqual({ cli: false, sandbox: false });
  });
});

describe("haltSummary (#3455)", () => {
  it("names each cause in one short sentence", () => {
    expect(
      haltSummary([
        { code: "sandbox_interactive", detail: "standard" },
        { code: "sandbox_provider_unconfined", detail: "codex" },
      ]),
    ).toBe(
      `${m.epic_autofix_short_interactive()} ${m.epic_autofix_short_provider({ cli: m.agent_provider_codex() })}`,
    );
    expect(haltSummary([{ code: "sandbox_backend_unavailable", detail: "autonomous" }])).toBe(
      m.epic_autofix_short_backend(),
    );
    expect(haltSummary([{ code: "sandbox_egress_unavailable", detail: "autonomous" }])).toBe(
      m.epic_autofix_short_egress(),
    );
  });

  it("falls back to a generic sentence for a cause it doesn't know", () => {
    expect(haltSummary([{ code: "something_new", detail: "" }])).toBe(m.epic_autofix_short_other());
  });
});
