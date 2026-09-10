import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import AppOverlays from "./AppOverlays.svelte";
import { HerdStore } from "$lib/store.svelte";
import type {
  AgentProvider,
  BacklogPayload,
  DiagnosticsSnapshot,
  GitState,
  HerdrUpdateStatus,
  Session,
  Steer,
} from "$lib/types";
import { steers } from "$lib/steers.svelte";
import { repos } from "$lib/repos.svelte";
import { steersSettingsOpen } from "../../../routes/steers-settings-open";
import { m } from "$lib/paraglide/messages";
import { ApiError, restartHerdrServer, uploadFile } from "$lib/api";

// The redesigned NewTask is responsive (rail vs. mobile sheet); vitest-browser's
// default viewport is mobile-width, so pin desktop for these desktop-DOM suites.
beforeEach(async () => {
  await page.viewport(1280, 900);
});
afterEach(() => {
  steers.list = [];
  steers.loaded = false;
  repos.entries = [];
  repos.loaded = false;
});

// NewTask calls listRepos() on mount; stub it so the dialog mounts without a server.
// Keep every other $lib/api export real (AppOverlays imports many for the
// learnings drawer, but those only fire on interaction, not on mount).
vi.mock("$lib/api", async (original) => ({
  ...(await original<typeof import("$lib/api")>()),
  listRepos: vi.fn(async () => ({ repos: [], recentWindowDays: 30 })),
  listBranches: vi.fn(async () => ({ current: "main", branches: ["main"], default: "main" })),
  branchStatus: vi.fn(async () => ({
    behind: 0,
    ahead: 0,
    diverged: false,
    hasUpstream: true,
    localExists: true,
  })),
  getRepoConfig: vi.fn(async () => ({
    automationConfirmed: true,
    automationRowExists: true,
    planGateEnabled: false,
    autopilotEnabled: false,
  })),
  getCommands: vi.fn(async () => ({ commands: [] })),
  listIssues: vi.fn(async () => ({ issues: [], slug: null, webUrl: null, viewer: null })),
  getTodo: vi.fn(async () => ({ exists: false, content: "" })),
  getEpics: vi.fn(async () => ({ epics: [], subIssues: [] })),
  getHerdrUpdate: vi.fn(() => new Promise(() => {})),
  restartHerdrServer: vi.fn(),
  uploadFile: vi.fn(async (file: File) => `/staged/${file.name}`),
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
    amendTarget: null,
    onamendclose: vi.fn(),
    decomLeftovers: [],
    ondecomleftoverclose: vi.fn(),
    ondecomleftoverconfirm: vi.fn(),
    decommissionPr: null,
    ondecommissionprselect: vi.fn(),
    ondecommissionprclose: vi.fn(),
    onretryclose: vi.fn(),
    showEpicDiagnose: false,
    onepicdiagnoseclose: vi.fn(),
    clearMergedSessions: null,
    clearMergedLeftovers: 0,
    clearMergedProbesUnavailable: false,
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

const steer = (p: Partial<Steer>): Steer => ({
  id: "b",
  label: "Bravo",
  text: "do bravo",
  inSteerBar: true,
  onIssues: false,
  ...p,
});

const frames = (n = 2) =>
  new Promise<void>((resolve) => {
    let i = 0;
    const step = () => (++i >= n ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });

describe("AppOverlays — Repos selection", () => {
  it("selects the backlog raw path for a realpath-based active repo filter", async () => {
    const props = baseProps();
    props.showBacklog = true;
    props.repoFilter = "/repos/filtered";
    repos.entries = [
      {
        name: "filtered",
        path: "/repos/filtered-link",
        display: "/repos/filtered-link",
        realPath: "/repos/filtered",
      },
    ];
    props.backlog = {
      pinnedPath: "/repos/pinned",
      projects: ["/repos/pinned", "/repos/filtered-link"].map((path) => ({
        path,
        display: path,
        slug: null,
        kind: "github",
        openIssues: 1,
        openPRs: 0,
        prKinds: null,
        workflows: null,
        ciStatus: null,
        hidden: false,
      })),
      totals: { openIssues: 2, openPRs: 0 },
    } satisfies BacklogPayload;

    render(AppOverlays, props);

    await expect.element(page.getByText("filtered-link", { exact: true })).toBeVisible();
    expect(document.querySelectorAll(".project-row")).toHaveLength(2);
    expect(document.querySelector(".project-row.sel .row-name")?.textContent).toBe("filtered-link");
  });
});

describe("Settings deep links", () => {
  it("forwards the Steers request into the mobile detail and focused editor row", async () => {
    await page.viewport(360, 900);
    steers.list = [steer({})];
    steers.loaded = true;
    repos.loaded = true;

    render(AppOverlays, { ...baseProps(), ...steersSettingsOpen("b") });
    await frames();

    await expect
      .element(page.getByRole("region", { name: m.settings_tab_steers() }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: m.settings_tab_workspace(), exact: false }))
      .not.toBeInTheDocument();

    const row = document.querySelector<HTMLElement>('.srow[data-steer-id="b"]');
    expect(row?.classList.contains("open")).toBe(true);
    expect(document.activeElement).toBe(row?.querySelector("textarea.ptext"));
  });
});

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

  it("renders the open-PR decommission dialog and forwards the selected action", async () => {
    const props = baseProps();
    props.decommissionPr = {
      name: "task one",
      git: {
        kind: "github",
        state: "open",
        number: 42,
        checks: "success",
        mergeable: true,
        mergeStateStatus: "clean",
        deployConfigured: false,
      } satisfies GitState,
    };
    render(AppOverlays, props);

    await page.getByRole("button", { name: m.decommission_pr_keep() }).click();
    expect(props.ondecommissionprselect).toHaveBeenCalledWith("keep");
  });

  // The batch clear reaps without asking, so on a host that can't detect processes the
  // operator would be shown a clean-looking dialog and leak every dev server (#1923). The
  // caution must therefore render at leftovers === 0 — i.e. OUTSIDE the count guard that
  // hides the `clearmerged_leftovers` line.
  it("cautions in ClearMergedDialog at a zero count when leftover probes are unavailable", async () => {
    const props = baseProps();
    props.clearMergedSessions = [
      { id: "s1", desig: "TASK-01", name: "task one" },
    ] as unknown as Session[];
    props.clearMergedLeftovers = 0;
    props.clearMergedProbesUnavailable = true;
    render(AppOverlays, props);
    await expect.element(page.getByText(m.clearmerged_probes_unavailable())).toBeVisible();
  });

  it("shows no such caution when the probes work", async () => {
    const props = baseProps();
    props.clearMergedSessions = [
      { id: "s1", desig: "TASK-01", name: "task one" },
    ] as unknown as Session[];
    props.clearMergedLeftovers = 0;
    props.clearMergedProbesUnavailable = false;
    render(AppOverlays, props);
    expect(page.getByText(m.clearmerged_probes_unavailable()).elements()).toHaveLength(0);
  });
});

// Explicit opens also refresh runtime when the installed version is already current.
describe("AppOverlays — herdr-update modal gate (#1898 stranded downgrade)", () => {
  beforeEach(() => vi.clearAllMocks());

  function herdrStore(status: Partial<HerdrUpdateStatus>): HerdStore {
    return {
      sessions: [],
      workingBlocked: {},
      herdrUpdate: {
        current: "0.7.5",
        latest: "0.7.5",
        updateAvailable: false,
        currentUnsupported: false,
        downgradeTarget: null,
        notes: null,
        checkedAt: 0,
        ...status,
      },
    } as unknown as HerdStore;
  }

  it("renders the downgrade modal when the installed herdr is unsupported (currentUnsupported)", async () => {
    const props = baseProps();
    props.showHerdrUpdate = true;
    props.store = herdrStore({ currentUnsupported: true, downgradeTarget: "0.7.4" });

    render(AppOverlays, props);

    await expect.element(page.getByRole("dialog")).toBeVisible();
    expect(document.querySelector(".run.downgrade")).not.toBeNull();
  });

  it("allows an explicit open to refresh runtime even when no release is available", () => {
    const props = baseProps();
    props.showHerdrUpdate = true;
    props.store = herdrStore({});

    render(AppOverlays, props);

    expect(document.querySelector(".run.downgrade")).toBeNull();
    expect(page.getByRole("dialog").elements()).toHaveLength(1);
  });
});

it("preserves the real composer through recovery and restores focus without submitting twice", async () => {
  const store = new HerdStore();
  store.setHerdrUpdate({
    current: "0.9.0",
    latest: "0.9.0",
    updateAvailable: false,
    notes: null,
    checkedAt: 1,
    phase: "idle",
    revision: 1,
    runtime: { state: "restart_required", installedVersion: "0.9.0", serverVersion: "0.8.2" },
  });
  const onsubmit = vi
    .fn()
    .mockRejectedValueOnce(new ApiError(409, "protocol_mismatch", "herdr_restart_required", true))
    .mockResolvedValue(undefined);
  const props: Props = {
    ...baseProps(),
    store,
    settings: null,
    showNew: true,
    showHerdrUpdate: false,
    composeRepoPath: "/repo/recovery",
    composeBaseBranch: "main",
    composePrompt: "Preserve this draft",
    composeImages: [{ path: "/staged/draft.png", name: "draft.png" }],
    composeModel: "sonnet",
    decomLeftovers: [],
    onsubmit,
    onsettingsherdrupdate: () => view.rerender({ ...props, showHerdrUpdate: true }),
    onherdrupdateclose: () => view.rerender(props),
  };
  const view = await render(AppOverlays, { props });
  const prompt = document.querySelector<HTMLTextAreaElement>("#nt-prompt")!;
  const run = document.querySelector<HTMLButtonElement>("button.run")!;
  await expect.poll(() => run.disabled).toBe(false);
  run.click();
  await page.getByRole("button", { name: m.diagnostics_herdr_repair(), exact: true }).click();
  await expect.element(page.getByText(m.herdrupdate_repair_warning())).toBeVisible();
  expect(document.querySelector("#nt-prompt")).toBe(prompt);
  expect(prompt.closest("[hidden][inert]")).not.toBeNull();
  const clipboard = new DataTransfer();
  clipboard.items.add(new File(["png"], "hidden-paste.png", { type: "image/png" }));
  const paste = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", { value: clipboard });
  window.dispatchEvent(paste);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(uploadFile).not.toHaveBeenCalled();
  prompt.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
  );
  expect(onsubmit).toHaveBeenCalledOnce();
  expect(restartHerdrServer).not.toHaveBeenCalled();
  await page.getByRole("button", { name: m.herdrupdate_later(), exact: true }).click();
  await expect.poll(() => prompt.closest("[hidden]")).toBeNull();
  await expect.poll(() => document.activeElement?.textContent).toBe(m.diagnostics_herdr_repair());
  expect(prompt.value).toBe("Preserve this draft");
  expect(document.body.textContent).toContain("draft.png");
  expect(onsubmit).toHaveBeenCalledOnce();
  run.click();
  await expect.poll(() => onsubmit.mock.calls.length).toBe(2);
  expect(onsubmit.mock.calls[1]![0]).toMatchObject({
    prompt: "Preserve this draft",
    images: ["/staged/draft.png"],
    model: "sonnet",
    baseBranch: "main",
  });
});

it("still opens a closable recovery dialog if bootstrap status was unavailable", async () => {
  const store = new HerdStore();
  const props = {
    ...baseProps(),
    store,
    showNew: true,
    showHerdrUpdate: true,
    composePrompt: "Unsaved draft",
  };
  props.onherdrupdateclose = () => {
    void view.rerender({ ...props, showHerdrUpdate: false });
  };
  const view = await render(AppOverlays, props);
  await expect
    .element(page.getByRole("button", { name: m.herdrupdate_repair_check(), exact: true }))
    .toBeVisible();
  await page.getByRole("button", { name: m.herdrupdate_later(), exact: true }).click();
  await expect.poll(() => document.querySelector("#nt-prompt")?.closest("[hidden]")).toBeNull();
  expect(document.querySelector<HTMLTextAreaElement>("#nt-prompt")!.value).toBe("Unsaved draft");
});
