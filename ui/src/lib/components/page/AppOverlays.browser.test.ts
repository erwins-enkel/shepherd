import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import AppOverlays from "./AppOverlays.svelte";
import type { HerdStore } from "$lib/store.svelte";

// NewTask calls listRepos() on mount; stub it so the dialog mounts without a server.
// Keep every other $lib/api export real (AppOverlays imports many for the
// learnings/triage drawers, but those only fire on interaction, not on mount).
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
    showTriage: false,
    blockedEntries: [],
    nowMs: 0,
    ontriageopen: vi.fn(),
    ontriageclose: vi.fn(),
    onresumequota: vi.fn(),
    ontakeoverquota: vi.fn(),
    onabandonquota: vi.fn(),
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
    showOnboarding: false,
    diagnosticsLoadFailed: false,
    ononboardingretry: vi.fn(),
    ononboardingdismiss: vi.fn(),
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
    composeRepoPath: null,
    repoFilter: null,
    composeBaseBranch: null,
    composeIssue: null,
    relaunchIssueNumber: null,
    composeImages: [],
    composePrompt: null,
    composeModel: null,
    holdLikely: false,
    onnewclose: vi.fn(),
    onnewclone: vi.fn(),
    onnewfork: vi.fn(),
    onnewnewproject: vi.fn(),
    showSettings: false,
    settingsTab: "workspace",
    onsettingsclose: vi.fn(),
    onsettingsherdrupdate: vi.fn(),
    onsettingsclone: vi.fn(),
    onsettingsfork: vi.fn(),
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
    showRetry: false,
    onretryclose: vi.fn(),
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
    onpr: vi.fn(),
    onadopt: vi.fn(),
    onlaunchtrain: vi.fn(),
    onbacklogclose: vi.fn(),
    pendingTrain: null,
    ontrainclose: vi.fn(),
    ontrainconfirm: vi.fn(),
    onstarresolve: vi.fn(),
  };
}

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
