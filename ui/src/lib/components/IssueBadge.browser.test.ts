import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { GitState, Issue, Session, SessionLaunchMetadata } from "$lib/types";
import { m } from "$lib/paraglide/messages";

const { default: IssueBadge } = await import("./IssueBadge.svelte");
const { issueRef } = await import("$lib/issue-ref.svelte");

// The peek store is a module singleton with its own cache, so every case here uses a
// distinct repo/number pair rather than trying to reset it — that also keeps each case
// honest about which request it actually triggered.
let nextNumber = 1000;
function freshNumber(): number {
  return nextNumber++;
}

function launchMetadata(issue: { number: number; title: string; url: string } | null) {
  return {
    sourceKind: "generated",
    prompt: "p",
    issue,
    attachments: [],
    branch: { baseBranch: "main", workBranch: "shepherd/x", sharedCheckout: false },
    uiState: null,
    submittedChoices: {
      planGateOverride: null,
      autopilotOverride: null,
      sandboxProfile: null,
      model: null,
      effort: null,
    },
    resolvedLaunch: {
      research: false,
      planGateOptIn: false,
      autopilotOptIn: false,
      storedModel: null,
      effort: null,
      sandboxApplied: null,
      sandboxDegraded: false,
      egressApplied: false,
      egressDegraded: false,
    },
    agent: { provider: "claude", model: null, effort: null },
  } as unknown as SessionLaunchMetadata;
}

function issue(over: Partial<Issue> = {}): Issue {
  return {
    number: 72,
    title: "Stufe B: die Niederschrift",
    body: "Gesprochenes wird Text mit Zeitmarken.",
    url: "https://example.test/issues/72",
    labels: ["enhancement"],
    createdAt: Date.now() - 3 * 86_400_000,
    assignees: [],
    author: "kai",
    ...over,
  };
}

/** Stub `fetch` with one issue payload; returns the spy so a case can count calls. */
function stubIssueFetch(body: { issue: Issue | null }) {
  const fetchSpy = vi.fn(async () => new Response(JSON.stringify(body)));
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

function session(partial: Partial<Session> & { id: string }): Session {
  return {
    desig: "TASK-01",
    name: "task one",
    prompt: "p",
    repoPath: "/repo/a",
    baseBranch: "main",
    branch: "feat/x",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "h",
    herdrAgentId: "ha",
    claudeSessionId: "cs",
    model: null,
    status: "idle",
    readyToMerge: false,
    mergingSince: null,
    mergingTrainId: null,
    mergeTrainPrs: null,
    autopilotEnabled: null,
    autopilotStepCount: 0,
    autopilotPaused: false,
    autopilotComplete: false,
    autopilotQuestion: null,
    planGateEnabled: null,
    planPhase: null,
    autoMergeEnabled: null,
    autoMergeRebaseCount: 0,
    auto: false,
    sandboxApplied: null,
    sandboxDegraded: false,
    egressApplied: false,
    egressDegraded: false,
    research: false,
    epicAuthoring: false,
    issueNumber: null,
    lastState: "",
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    haltReason: null,
    haltedAt: null,
    manualSteps: [],
    manualStepsAckedAt: null,
    experimentId: null,
    experimentRole: null,
    ...partial,
  };
}

/** A session whose chip links out, with the launch-time snapshot the preview paints first. */
function linkedSession(number: number, title = "Stufe B: die Niederschrift"): Session {
  return session({
    id: `s${number}`,
    repoPath: `/repo/${number}`,
    issueNumber: number,
    launchMetadata: launchMetadata({
      number,
      title,
      url: `https://example.test/issues/${number}`,
    }),
  });
}

beforeEach(() => {
  issueRef.set(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  issueRef.set(true);
});

describe("IssueBadge", () => {
  it("names the issue a session was spawned for", async () => {
    const n = freshNumber();
    render(IssueBadge, { session: linkedSession(n) });
    await expect.element(page.getByText(`#${n}`, { exact: true })).toBeVisible();
  });

  it("renders nothing for a session launched without an issue", () => {
    render(IssueBadge, { session: session({ id: "b", issueNumber: null }) });
    expect(document.querySelector(".issue-badge")).toBeNull();
  });

  // The whole point of the setting: an operator who finds the chip noisy turns it off
  // and every card drops it, without the number becoming unrecoverable elsewhere.
  it("disappears while the per-device preference is off", () => {
    issueRef.set(false);
    render(IssueBadge, { session: linkedSession(freshNumber()) });
    expect(document.querySelector(".issue-badge")).toBeNull();
  });
});

describe("IssueBadge link", () => {
  it("opens the issue on the forge in a new tab", () => {
    const n = freshNumber();
    render(IssueBadge, { session: linkedSession(n) });
    const el = document.querySelector("a.issue-badge") as HTMLAnchorElement;
    expect(el.getAttribute("href")).toBe(`https://example.test/issues/${n}`);
    expect(el.target).toBe("_blank");
    expect(el.rel).toBe("noopener");
    expect(el.getAttribute("aria-label")).toBe(m.issuebadge_open_label({ number: n }));
    // A styled preview is the only tooltip path — a native title would double up on hover.
    expect(el.hasAttribute("title")).toBe(false);
  });

  // Rows predating launch metadata still link: the server derives the URL from the forge.
  it("falls back to the git state's issue URL", () => {
    const n = freshNumber();
    const git = { issueUrl: `https://git.test/issues/${n}` } as GitState;
    render(IssueBadge, {
      session: session({ id: `g${n}`, repoPath: `/repo/${n}`, issueNumber: n }),
      git,
    });
    expect(document.querySelector("a.issue-badge")?.getAttribute("href")).toBe(
      `https://git.test/issues/${n}`,
    );
  });

  it("falls back to the archived session's issue URL", () => {
    const n = freshNumber();
    render(IssueBadge, {
      session: session({
        id: `d${n}`,
        repoPath: `/repo/${n}`,
        issueNumber: n,
        issueUrl: `https://done.test/issues/${n}`,
      }),
    });
    expect(document.querySelector("a.issue-badge")?.getAttribute("href")).toBe(
      `https://done.test/issues/${n}`,
    );
  });

  // No web forge (local mode) ⇒ nothing to open and nothing to fetch. The chip stays the
  // plain, unraised identifier it was, so it can't become a dead zone over the row's
  // click surface.
  it("stays a plain chip when no forge URL is known", () => {
    const n = freshNumber();
    render(IssueBadge, {
      session: session({ id: `l${n}`, repoPath: `/repo/${n}`, issueNumber: n }),
    });
    expect(document.querySelector("a.issue-badge")).toBeNull();
    const el = document.querySelector(".issue-badge") as HTMLElement;
    expect(el.getAttribute("role")).toBe("img");
    expect(el.title).toBe(m.issuebadge_title({ number: n }));
  });
});

describe("IssueBadge hover preview", () => {
  it("shows the launch-time title straight away, then the fetched detail", async () => {
    const n = freshNumber();
    const fetchSpy = stubIssueFetch({ issue: issue({ number: n, labels: ["enhancement"] }) });
    render(IssueBadge, { session: linkedSession(n, "Stufe B: die Niederschrift") });

    await page.getByText(`#${n}`, { exact: true }).hover();
    // Title from what the session recorded at launch — no waiting on the network.
    await expect.element(page.getByText("Stufe B: die Niederschrift")).toBeVisible();
    // …then the parts only the forge knows.
    await expect.element(page.getByText("enhancement")).toBeVisible();
    await expect.element(page.getByText("Gesprochenes wird Text mit Zeitmarken.")).toBeVisible();
    await expect.element(page.getByText(m.issuerow_author_by({ login: "kai" }))).toBeVisible();
    expect(fetchSpy).toHaveBeenCalledWith(
      `/api/issues/${n}?repo=${encodeURIComponent(`/repo/${n}`)}`,
    );
  });

  it("says so when the issue can't be loaded", async () => {
    const n = freshNumber();
    stubIssueFetch({ issue: null });
    render(IssueBadge, { session: linkedSession(n) });

    await page.getByText(`#${n}`, { exact: true }).hover();
    await expect.element(page.getByText(m.issuepeek_unavailable())).toBeVisible();
  });

  it("closes again when the pointer leaves", async () => {
    const n = freshNumber();
    // Same title from the forge as from the launch snapshot, so the assertion holds
    // whether or not the fetch has landed — this case is about the close, not the swap.
    stubIssueFetch({ issue: issue({ number: n, title: "leaving again" }) });
    render(IssueBadge, { session: linkedSession(n, "leaving again") });

    await page.getByText(`#${n}`, { exact: true }).hover();
    await expect.element(page.getByText("leaving again")).toBeVisible();
    const el = document.querySelector("a.issue-badge") as HTMLElement;
    el.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }));
    await expect.element(page.getByText("leaving again")).not.toBeInTheDocument();
  });

  // Replaces the pre-#2249-follow-up expectation that the chip opened NO overlay: back
  // then a popover would have raised the chip over the row's click surface for nothing.
  // Now the chip has its own click target, so the preview is what the raise buys.
  it("keeps the preview out of the DOM until it is opened", () => {
    const n = freshNumber();
    stubIssueFetch({ issue: issue({ number: n }) });
    render(IssueBadge, { session: linkedSession(n, "not yet shown") });
    expect(document.body.textContent).not.toContain("not yet shown");
  });

  it("does not select the row when the chip is clicked", async () => {
    const n = freshNumber();
    stubIssueFetch({ issue: issue({ number: n }) });
    render(IssueBadge, { session: linkedSession(n) });
    const el = document.querySelector("a.issue-badge") as HTMLAnchorElement;
    // The link would navigate the test page away; only the propagation matters here.
    el.removeAttribute("href");
    let bubbled = false;
    document.body.addEventListener("click", () => (bubbled = true));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(bubbled).toBe(false);
  });
});

describe("IssueBadge on a touchscreen", () => {
  function tap(el: HTMLElement): MouseEvent {
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    el.dispatchEvent(click);
    return click;
  }

  it("previews on the first tap and opens on the second", async () => {
    const n = freshNumber();
    stubIssueFetch({ issue: issue({ number: n, title: "two-step tap" }) });
    render(IssueBadge, { session: linkedSession(n, "two-step tap") });
    const el = document.querySelector("a.issue-badge") as HTMLAnchorElement;

    // First tap: no hover to lean on, so it stands in for one — navigation suppressed.
    const first = tap(el);
    expect(first.defaultPrevented).toBe(true);
    await expect.element(page.getByText("two-step tap")).toBeVisible();

    // Second tap: the preview is up, so the link gets to do its job.
    const second = tap(el);
    expect(second.defaultPrevented).toBe(false);
  });
});
