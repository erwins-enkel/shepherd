import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import AppOverlays from "./AppOverlays.svelte";
import type { HerdStore } from "$lib/store.svelte";
import type { AgentProvider, DiagnosticsSnapshot } from "$lib/types";

// NewTask calls listRepos() on mount; stub it so the dialog mounts without a server.
// Keep every other $lib/api export real (AppOverlays imports many for the
// learnings drawer, but those only fire on interaction, not on mount).
vi.mock("$lib/api", async (orig) => ({
  ...((await orig()) as object),
  listRepos: vi.fn().mockResolvedValue({ repos: [], recentWindowDays: 30 }),
}));

// store is only read by overlay blocks that are not shown in these tests (update,
// herdr-update, broadcast, retry, backlog, star-prompt); the NewTask path never
// touches it. A bare stub avoids HerdStore construction side-effects.
const store = {} as unknown as HerdStore;

type Props = Parameters<typeof AppOverlays>[1];

function baseProps(): Props {
  return {
    store,
    settings: null,
    mobile: false,
    showLearnings: false,
    learningsRepo: null,
    onlearningsclose: vi.fn(),
    showUpdate: false,
    deploy: null,
    onupdateconfirm: vi.fn(),
    onupdateclose: vi.fn(),
    showHerdrUpdate: false,
    herdrUpdating: false,
    onherdrupdateconfirm: vi.fn(),
    onherdrupdateclose: vi.fn(),
    onherdrupdatejump: vi.fn(),
    showCodexUpdate: false,
    codexUpdating: false,
    oncodexupdateconfirm: vi.fn(),
    oncodexupdateclose: vi.fn(),
    showPluginUpdates: false,
    onpluginupdatesclose: vi.fn(),
    onpluginupdated: vi.fn(),
    showOnboarding: false,
    diagnosticsLoadFailed: false,
    ononboardingretry: vi.fn(),
    ononboardingdismiss: vi.fn(),
    ononboardingpicked: vi.fn(),
    showWhatsNew: false,
    whatsNewEntries: [],
    onwhatsnewdismiss: vi.fn(),
    onwhatsnewclose: vi.fn(),
    showFableArrival: false,
    onfabletry: vi.fn(),
    onfableclose: vi.fn(),
    showNew: false,
    onsubmit: vi.fn(),
    relaunchOriginal: false,
    editHeld: false,
    composeRepoPath: null,
    repoFilter: null,
    composeBaseBranch: null,
    composeIssue: null,
    relaunchIssueNumber: null,
    composeImages: [],
    composePrompt: null,
    composeModel: null,
    composeEffort: null,
    composeAgentProvider: null,
    composePlanGate: null,
    composeAutopilot: null,
    composeSandbox: null,
    composeResearch: false,
    composeEpicAuthoring: false,
    holdLikely: false,
    onnewclose: vi.fn(),
    onnewclone: vi.fn(),
    onnewfork: vi.fn(),
    onnewnewproject: vi.fn(),
    showSettings: false,
    settingsTab: "workspace",
    onsettingsclose: vi.fn(),
    onsettingsherdrupdate: vi.fn(),
    onsettingscodexupdate: vi.fn(),
    onsettingspluginupdates: vi.fn(),
    onsettingswhatsnew: vi.fn(),
    showUsage: false,
    onusageclose: vi.fn(),
    showClone: false,
    oncloneclose: vi.fn(),
    onclonedone: vi.fn(),
    showFork: false,
    onforkclose: vi.fn(),
    onforkdone: vi.fn(),
    showNewProject: false,
    onnewprojectclose: vi.fn(),
    onnewprojectdone: vi.fn(),
    showBroadcast: false,
    onbroadcastclose: vi.fn(),
    showCommandBar: false,
    commandBarCommands: [],
    oncommandbarclose: vi.fn(),
    oncommandbarsession: vi.fn(),
    oncommandbarrepo: vi.fn(),
    oncommandbarfilterrepo: vi.fn(),
    oncommandbarlens: vi.fn(),
    showRetry: false,
    decomLeftovers: [],
    ondecomleftoverclose: vi.fn(),
    ondecomleftoverconfirm: vi.fn(),
    onretryclose: vi.fn(),
    showEpicDiagnose: false,
    onepicdiagnoseclose: vi.fn(),
    clearMergedSessions: null,
    clearMergedLeftovers: 0,
    onclearmergedclose: vi.fn(),
    onclearmergedconfirm: vi.fn(),
    showBacklog: false,
    backlog: null,
    epicTarget: null,
    inTrainPrs: new Set<string>(),
    onissue: vi.fn(),
    onquick: vi.fn(),
    oninject: vi.fn(),
    onpr: vi.fn(),
    onadopt: vi.fn(),
    onlaunchtrain: vi.fn(),
    onaddclone: vi.fn(),
    onaddfork: vi.fn(),
    onaddnewproject: vi.fn(),
    backlogSelectPath: null,
    onbacklogclose: vi.fn(),
    pendingTrain: null,
    ontrainclose: vi.fn(),
    ontrainconfirm: vi.fn(),
    onstarresolve: vi.fn(),
  };
}

function diagnostics(states: Record<AgentProvider, "ok" | "optional">): DiagnosticsSnapshot {
  return {
    checks: [
      { id: "claude", state: states.claude, hintKey: "x" },
      { id: "codex", state: states.codex, hintKey: "x" },
    ],
    generatedAt: 0,
    overall: "ok",
  };
}

describe("AppOverlays — NewTask provider capacity default", () => {
  beforeEach(() => vi.clearAllMocks());

  it("preselects Codex when Claude would be held and both coding CLIs are ready", async () => {
    const props = baseProps();
    props.showNew = true;
    props.holdLikely = true;
    props.settings = { defaultAgentProvider: "claude", fableAvailable: true } as Props["settings"];
    props.store = {
      diagnostics: diagnostics({ claude: "ok", codex: "ok" }),
    } as unknown as HerdStore;

    render(AppOverlays, props);

    await expect
      .poll(() => document.querySelector<HTMLSelectElement>("#nt-agent-provider")?.value)
      .toBe("codex");
  });

  it("keeps Claude when the Codex CLI is not ready", async () => {
    const props = baseProps();
    props.showNew = true;
    props.holdLikely = true;
    props.settings = { defaultAgentProvider: "claude", fableAvailable: true } as Props["settings"];
    props.store = {
      diagnostics: diagnostics({ claude: "ok", codex: "optional" }),
    } as unknown as HerdStore;

    render(AppOverlays, props);

    await expect
      .poll(() => document.querySelector<HTMLSelectElement>("#nt-agent-provider")?.value)
      .toBe("claude");
  });
});

// Regression guard for the #855 +page → AppOverlays extraction: the
// NewTask↔Clone↔Fork↔NewProject handoff wiring now flows through AppOverlays
// props (onnewclone/onnewfork/onnewnewproject), so verify each repo-picker
// shortcut still reaches the route-owned handler that runs resetCompose + opens
// the next dialog.
describe("AppOverlays — NewTask repo-picker handoffs", () => {
  beforeEach(() => vi.clearAllMocks());

  async function openRepoPicker() {
    await page.getByRole("button", { name: /select a repo/i }).click();
  }

  it("forwards the Clone shortcut to onnewclone", async () => {
    const props = baseProps();
    props.showNew = true;
    render(AppOverlays, props);
    await openRepoPicker();
    await page.getByRole("button", { name: "+ Clone repository" }).click();
    expect(props.onnewclone).toHaveBeenCalledOnce();
    expect(props.onnewfork).not.toHaveBeenCalled();
    expect(props.onnewnewproject).not.toHaveBeenCalled();
  });

  it("forwards the Fork shortcut to onnewfork", async () => {
    const props = baseProps();
    props.showNew = true;
    render(AppOverlays, props);
    await openRepoPicker();
    await page.getByRole("button", { name: "+ Fork a GitHub repo" }).click();
    expect(props.onnewfork).toHaveBeenCalledOnce();
    expect(props.onnewclone).not.toHaveBeenCalled();
    expect(props.onnewnewproject).not.toHaveBeenCalled();
  });

  it("forwards the New-project shortcut to onnewnewproject", async () => {
    const props = baseProps();
    props.showNew = true;
    render(AppOverlays, props);
    await openRepoPicker();
    await page.getByRole("button", { name: "+ New project" }).click();
    expect(props.onnewnewproject).toHaveBeenCalledOnce();
    expect(props.onnewclone).not.toHaveBeenCalled();
    expect(props.onnewfork).not.toHaveBeenCalled();
  });
});

// #1338: AppOverlays must forward commandBarCommands into the CommandBar it renders —
// otherwise the page's registry would build verbs that never reach the bar (vacuous).
describe("AppOverlays — command bar wiring", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes commandBarCommands through to the rendered CommandBar", async () => {
    const props = baseProps();
    props.store = { sessions: [], workingBlocked: {} } as unknown as HerdStore;
    props.showCommandBar = true;
    props.commandBarCommands = [{ id: "probe", label: () => "Probe verb", run: vi.fn() }];
    render(AppOverlays, props);
    // Commands are query-gated, so type to reveal the forwarded verb.
    await page.getByRole("combobox").fill("probe");
    await expect.element(page.getByRole("option", { name: /Probe verb/ })).toBeVisible();
  });

  it("pops LeftoverDialog for the leftovers the ⌘K decommission probe turned up", async () => {
    // The command-bar verb must reap like Viewport's button does — a decommission that silently
    // orphans a running dev server is exactly what the dialog exists to prevent.
    const props = baseProps();
    props.decomLeftovers = [
      { kind: "process", name: "vite", port: 5173, key: "vite:5173", pid: 42 },
    ];
    render(AppOverlays, props);
    await expect.element(page.getByText("vite")).toBeVisible();
  });

  it("renders no LeftoverDialog when the probe came back empty", async () => {
    const props = baseProps();
    props.decomLeftovers = [];
    render(AppOverlays, props);
    expect(page.getByText("vite").elements()).toHaveLength(0);
  });
});
