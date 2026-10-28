import { describe, it, expect } from "vitest";
import type { EpicAutoBlockerCause, EpicAutoBlockers, EpicAutoCauseFix } from "#lib/types.js";
import type { RepoBootstrapView } from "#lib/api.js";
import { m } from "#lib/paraglide/messages.js";
import { causeView, haltSummary } from "./epic-auto-fix";
import { epicHaltView, overviewConfirmText, repoHaltView } from "./repo-halt";

const ok = (id: string) => ({ id, ok: true });
const TO_AUTONOMOUS: EpicAutoCauseFix = {
  changes: { sandboxProfile: "autonomous" },
  enabled: true,
  checks: [ok("bwrap"), ok("egress"), ok("remote_https")],
};
const TO_CLAUDE: EpicAutoCauseFix = {
  changes: { agentProvider: "claude" },
  enabled: true,
  checks: [],
};
const INTERACTIVE: EpicAutoBlockerCause = {
  code: "sandbox_interactive",
  scope: "repo",
  detail: "standard",
  fix: TO_AUTONOMOUS,
};
const CODEX: EpicAutoBlockerCause = {
  code: "sandbox_provider_unconfined",
  scope: "epic",
  detail: "codex",
  fix: TO_CLAUDE,
};
const NO_BWRAP: EpicAutoBlockerCause = {
  code: "sandbox_backend_unavailable",
  scope: "host",
  detail: "standard",
};

function model(
  agentProvider: "claude" | "codex" | undefined,
  causes: EpicAutoBlockerCause[],
): EpicAutoBlockers {
  return { agentProvider, causes, options: [], preselect: null };
}

// "Repo-Überblick": the repo on Standard, #35 leads on Codex, #40 queued on Claude Code, #41 not
// started on Codex.
const STD_CODEX = model("codex", [INTERACTIVE, CODEX]);
const STD_CLAUDE = model("claude", [INTERACTIVE]);
const CLEAR = model("claude", []);
const FALL = { 35: STD_CODEX, 40: STD_CLAUDE, 41: STD_CODEX };

function bootstrap(state: RepoBootstrapView["state"], missing: string[] = []): RepoBootstrapView {
  return { state, phase: 5, overrideAt: null, missing, suggested: false };
}

describe("repoHaltView (#3456)", () => {
  it("names the repo's cause once for every epic it holds, with Autonomous and the held epic", () => {
    expect(repoHaltView(FALL, [35, 40, 41], 35)).toEqual({
      causes: [INTERACTIVE],
      scope: "repo",
      scopeLabel: m.epic_autofix_scope_repo(),
      reason: haltSummary([INTERACTIVE]),
      affected: 3,
      autonomous: 35,
      target: 35,
    });
  });

  it("has no banner while no epic's model names a repo or host cause", () => {
    expect(repoHaltView({}, [35], null)).toBeNull();
    expect(repoHaltView({ 35: model("codex", [CODEX]), 40: CLEAR }, [35, 40], 35)).toBeNull();
  });

  it("offers the chooser for the first held epic when the drain holds none of them", () => {
    expect(repoHaltView(FALL, [40, 41, 35], null)?.target).toBe(40);
    expect(repoHaltView(FALL, [40, 41], 35)?.target).toBe(40);
  });

  it("counts only the epics whose model answered", () => {
    expect(repoHaltView(FALL, [35, 40, 41, 99], 35)?.affected).toBe(3);
  });

  it("hides Autonomous when this host can't confine; repo and host causes each once", () => {
    const disabled: EpicAutoBlockerCause = {
      ...INTERACTIVE,
      fix: { ...TO_AUTONOMOUS, enabled: false, why: "bwrap" },
    };
    const held = model("claude", [disabled, NO_BWRAP]);
    const view = repoHaltView({ 35: held, 40: held }, [35, 40], null);
    expect(view?.causes.map((c) => c.code)).toEqual([
      "sandbox_interactive",
      "sandbox_backend_unavailable",
    ]);
    expect(view?.reason).toBe(haltSummary([disabled, NO_BWRAP]));
    expect(view?.autonomous).toBeNull();
  });

  it("a host-only halt carries the HOST chip and no Autonomous", () => {
    const view = repoHaltView({ 35: model("claude", [NO_BWRAP]) }, [35], 35);
    expect([view?.scope, view?.scopeLabel, view?.autonomous]).toEqual([
      "host",
      m.epic_autofix_scope_host(),
      null,
    ]);
  });

  it("an older server without cause fixes offers no Autonomous", () => {
    const old = model(undefined, [{ code: "sandbox_interactive", scope: "repo", detail: "x" }]);
    expect(repoHaltView({ 35: old }, [35], 35)?.autonomous).toBeNull();
  });
});

describe("epicHaltView (#3456)", () => {
  const none = { halted: false, bootstrap: null };

  it("says nothing when nothing would hold the epic", () => {
    expect(epicHaltView(CLEAR, none)).toBeNull();
    expect(epicHaltView(CLEAR, { halted: true, bootstrap: null })).toBeNull();
  });

  it("a held epic points at the banner for the repo's cause and offers its own CLI fix", () => {
    const codex = causeView(CODEX);
    expect(epicHaltView(STD_CODEX, { halted: true, bootstrap: null })).toEqual({
      kind: "halted",
      lines: [
        {
          scope: "repo",
          scopeLabel: m.epic_autofix_scope_repo(),
          pointer: true,
          what: causeView(INTERACTIVE).what,
          text: m.repooverview_halt_see_above(),
          action: null,
        },
        {
          scope: "epic",
          scopeLabel: m.epic_autofix_scope_epic(),
          pointer: false,
          what: codex.what,
          text: codex.why,
          action: {
            code: "sandbox_provider_unconfined",
            label: m.repooverview_cli_switch({ cli: "Claude Code" }),
          },
        },
      ],
    });
  });

  it("an epic not started yet shows what would hold it on start — its own cause only", () => {
    expect(epicHaltView(STD_CODEX, none)).toEqual({
      kind: "precheck",
      lines: [
        {
          scope: "epic",
          scopeLabel: m.epic_autofix_scope_epic(),
          pointer: false,
          what: "",
          text: m.repooverview_precheck_would_halt({ reason: haltSummary([CODEX]) }),
          action: {
            code: "sandbox_provider_unconfined",
            label: m.repooverview_cli_switch({ cli: "Claude Code" }),
          },
        },
      ],
    });
  });

  it("an epic held only by the repo waits for it and lists what it has", () => {
    expect(epicHaltView(STD_CLAUDE, none)).toEqual({
      kind: "waits",
      scope: "repo",
      scopeLabel: m.epic_autofix_scope_repo(),
      ready: [m.epic_autofix_cli({ cli: "Claude Code" })],
    });
    expect(epicHaltView(STD_CLAUDE, { halted: false, bootstrap: bootstrap("done") })).toMatchObject(
      {
        ready: [
          m.epic_autofix_cli({ cli: "Claude Code" }),
          m.repooverview_precheck_bootstrap_done(),
        ],
      },
    );
  });

  it("an unfinished bootstrap means not ready either; no CLI known and no bootstrap → no list", () => {
    expect(
      epicHaltView(STD_CLAUDE, { halted: false, bootstrap: bootstrap("active", ["P3"]) }),
    ).toMatchObject({ kind: "waits", ready: null });
    expect(
      epicHaltView(model(undefined, [INTERACTIVE]), { halted: false, bootstrap: bootstrap("off") }),
    ).toMatchObject({ kind: "waits", ready: null });
  });

  it("a host-only hold waits under the HOST chip", () => {
    expect(epicHaltView(model("claude", [NO_BWRAP]), none)).toMatchObject({
      kind: "waits",
      scope: "host",
      scopeLabel: m.epic_autofix_scope_host(),
    });
  });

  it("an older server without cause fixes gives the card no action", () => {
    const old = model(undefined, [
      { code: "sandbox_provider_unconfined", scope: "epic", detail: "codex" },
    ]);
    const view = epicHaltView(old, none);
    expect(view?.kind === "precheck" && view.lines[0]!.action).toBeNull();
  });
});

describe("overviewConfirmText (#3456)", () => {
  it("names the repo's sandbox and the epic whose CLI changed", () => {
    expect(overviewConfirmText({ sandboxProfile: "autonomous" }, "shop", 35)).toBe(
      m.epic_autofix_done_sandbox({ repo: "shop", profile: m.epic_autofix_profile_autonomous() }),
    );
    expect(overviewConfirmText({ agentProvider: "claude" }, "shop", 35)).toBe(
      m.repooverview_done_cli({ epic: 35, cli: "Claude Code" }),
    );
    expect(
      overviewConfirmText({ sandboxProfile: "autonomous", agentProvider: "claude" }, "shop", 35),
    ).toBe(
      `${m.epic_autofix_done_sandbox({ repo: "shop", profile: m.epic_autofix_profile_autonomous() })} ${m.repooverview_done_cli({ epic: 35, cli: "Claude Code" })}`,
    );
  });
});
