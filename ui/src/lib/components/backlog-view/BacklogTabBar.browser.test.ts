import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import type { ComponentProps } from "svelte";
import "../../../app.css";
import type { BacklogProject } from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";
import { issuesOverview } from "#lib/issues-overview.svelte.js";
import BacklogTabBar from "./BacklogTabBar.svelte";

type Props = Partial<ComponentProps<typeof BacklogTabBar>>;

function mount(over: Props = {}) {
  return render(BacklogTabBar, {
    variant: "desktop",
    activeTab: "issues",
    actionsState: { kind: "bare" },
    ffInFlight: false,
    selectedPath: "/repo",
    onselecttab: vi.fn(),
    onff: vi.fn(),
    ...over,
  });
}

const overview = () => page.getByRole("button", { name: m.backlog_overview_button() });

afterEach(() => {
  issuesOverview.selected = false;
});

describe("BacklogTabBar fast-forward label (#2639)", () => {
  const repo = (defaultBranch: string | null) =>
    ({ path: "/repo", openIssues: 1, openPRs: 0, defaultBranch }) as BacklogProject;
  const ffBtn = () => page.getByRole("button", { name: m.backlog_ff_main_title() }).element();

  it("names the selected repo's default branch behind a divider (mobile)", async () => {
    mount({ variant: "mobile", selected: repo("develop") });
    await expect
      .poll(() => ffBtn().textContent?.trim())
      .toBe(m.backlog_ff_branch({ branch: "develop" }));
    const sep = ffBtn().previousElementSibling as HTMLElement;
    expect(sep.classList.contains("ff-sep")).toBe(true);
    expect(sep.getAttribute("aria-hidden")).toBe("true");
  });

  it("falls back to the generic label without a default branch", async () => {
    mount({ variant: "mobile", selected: repo(null) });
    await expect.poll(() => ffBtn().textContent?.trim()).toBe(m.backlog_ff_main());
  });
});

describe("BacklogTabBar Overview button (#2950)", () => {
  it("sits at the right of the desktop tab row, ahead of the fast-forward button", async () => {
    mount();
    await expect.element(overview()).toBeVisible();
    const ov = overview().element().getBoundingClientRect();
    const ff = page.getByRole("button", { name: m.backlog_ff_main_title() }).element();
    const tabs = page.getByRole("button", { name: m.backlog_tab_automation() }).element();
    expect(ov.left).toBeGreaterThan(tabs.getBoundingClientRect().right);
    expect(ov.right).toBeLessThanOrEqual(ff.getBoundingClientRect().left);
    // Right-aligned: the fast-forward button ends the row.
    const row = document.querySelector<HTMLElement>(".tab-bar")!.getBoundingClientRect();
    expect(row.right - ff.getBoundingClientRect().right).toBeLessThan(16);
  });

  it("ends the desktop row when fast-forward lives in the dialog header (showFf off)", async () => {
    mount({ showFf: false });
    expect(page.getByRole("button", { name: m.backlog_ff_main_title() }).elements()).toHaveLength(
      0,
    );
    await expect.element(overview()).toBeVisible();
    const row = document.querySelector<HTMLElement>(".tab-bar")!.getBoundingClientRect();
    const ov = overview().element().getBoundingClientRect();
    expect(row.right - ov.right).toBeLessThan(16);
  });

  it("is lit while the overview shows and dims once an entry is selected", async () => {
    mount();
    await expect.element(overview()).toHaveAttribute("aria-pressed", "true");
    issuesOverview.selected = true;
    await expect.element(overview()).toHaveAttribute("aria-pressed", "false");
  });

  it("asks the Issues panel to show the overview", async () => {
    mount();
    const before = issuesOverview.nonce;
    await overview().click();
    expect(issuesOverview.nonce).toBe(before + 1);
  });

  it.each<[string, Props]>([
    ["on other tabs", { activeTab: "prs" }],
    ["on the phone layout", { variant: "mobile" }],
    ["without a repo", { selectedPath: null }],
  ])("is absent %s", async (_name, over) => {
    mount(over);
    await expect
      .element(page.getByRole("button", { name: m.backlog_tab_automation() }))
      .toBeVisible();
    expect(overview().elements()).toHaveLength(0);
  });
});

describe("BacklogTabBar Automation tab no-PR-CI mark (#3305)", () => {
  const repo = (noPrCiHold: boolean) =>
    ({
      path: "/repo",
      openIssues: 1,
      openPRs: 0,
      defaultBranch: "main",
      noPrCiHold,
    }) as BacklogProject;

  it("marks the Automation tab while auto-merge holds the repo's PRs", async () => {
    mount({ selected: repo(true) });
    await expect
      .element(page.getByRole("button", { name: m.backlog_tab_automation_no_pr_ci() }))
      .toBeVisible();
    expect(document.querySelector(".tab-hold")).not.toBeNull();
  });

  it("leaves the tab plain otherwise", async () => {
    mount({ selected: repo(false) });
    await expect
      .element(page.getByRole("button", { name: m.backlog_tab_automation(), exact: true }))
      .toBeVisible();
    expect(document.querySelector(".tab-hold")).toBeNull();
  });
});

describe("BacklogTabBar Automation halt count (#3455)", () => {
  const automation = () => page.getByRole("button", { name: m.backlog_tab_automation() });
  const count = () => automation().element().querySelector(".halt-count")?.textContent;

  it("counts the repo's and host's halts on the Automation tab", async () => {
    mount({ automationHalts: 1 });
    await expect.element(automation()).toBeVisible();
    expect(count()).toBe(m.backlog_tab_automation_halt_one());
  });

  it("names several halts", async () => {
    mount({ variant: "mobile", automationHalts: 2 });
    await expect.element(automation()).toBeVisible();
    expect(count()).toBe(m.backlog_tab_automation_halts({ count: 2 }));
  });

  it("shows no count without a halt", async () => {
    mount();
    await expect.element(automation()).toBeVisible();
    expect(count()).toBeUndefined();
  });
});
