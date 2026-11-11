import { describe, it, expect, afterEach, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import { tick } from "svelte";
import "../../../app.css";
import RepoSettingsBody from "./RepoSettingsBody.svelte";
import { REPO_SETTINGS_SECTIONS, type RepoSettingsSection } from "./sections";
import { infoTips } from "#lib/info-tips.svelte.js";
import { m } from "#lib/paraglide/messages.js";
import { repoConfig } from "#lib/reviews.svelte.js";
import { toasts } from "#lib/toasts.svelte.js";
import type { DrainStatus } from "#lib/types.js";

afterEach(() => infoTips.set(false));

// The body of every repo-settings surface (#3443) — the window, a session's Automation tab and
// the Backlog's Settings tab: one section at a time, the hints above it. These cover the
// sections' rows; RepoSettingsWindow.browser.test.ts covers the window around them.

// The ⓘ explainers are toggled with `hidden`, not {#if}, so a collapsed detail block is
// ALREADY in the DOM. An "is it absent when tips are hidden?" assertion would therefore pass
// even with no guard at all. Every test below expands the row FIRST, then hides tips, then
// asserts the block is gone from the DOM — which is what makes the assertion bite.
const sandboxTip = () =>
  document.querySelector<HTMLButtonElement>('button[aria-controls="auto-detail-sandbox"]');
const sandboxDetail = () => document.querySelector<HTMLElement>(".sandbox-detail");
const criticTip = () =>
  document.querySelector<HTMLButtonElement>('button[aria-controls="auto-detail-critic"]');
const criticDetail = () => document.querySelector<HTMLElement>("#auto-detail-critic");

type Props = {
  repoPath?: string;
  section?: RepoSettingsSection;
  sessionId?: string;
  drain?: DrainStatus | null;
  onsetupci?: () => void;
};

/** The body as the Backlog embeds it; without a section it opens where the hints point. */
function show(props: Props = {}) {
  render(RepoSettingsBody, { repoPath: "/tmp/repo", variant: "embedded", ...props });
}

const tab = (section: RepoSettingsSection) =>
  document.querySelector<HTMLButtonElement>(`[role="tab"][id$="-tab-${section}"]`);

/** Switch to `section` by its tab, as the operator does. */
async function visit(section: RepoSettingsSection) {
  tab(section)!.click();
  await expect.poll(() => tab(section)?.getAttribute("aria-selected")).toBe("true");
}

// Mounted once per test, at the section under test; wait for its tab so we know it rendered.
async function mount(section: RepoSettingsSection, props: Props = {}) {
  show({ section, ...props });
  await expect.poll(() => tab(section)?.getAttribute("aria-selected")).toBe("true");
}

describe("RepoSettingsBody — hide-info-tips preference", () => {
  it("sandbox row: expanded detail is removed outright when tips are hidden", async () => {
    await mount("agent");

    // Expand the sandbox explainer for real, so the block is genuinely visible.
    expect(sandboxTip()).not.toBeNull();
    sandboxTip()!.click();
    await tick();
    expect(sandboxDetail()!.hidden).toBe(false);

    infoTips.set(true);
    await tick();

    // The sandbox explainer is hand-written rather than emitted by {#snippet detail}, so it
    // needs its own guard — without it the ⓘ would vanish and strand these two paragraphs.
    expect(sandboxTip()).toBeNull();
    expect(sandboxDetail()).toBeNull();
    expect(page.getByText(m.automation_sandbox_profile_caveats()).query()).toBeNull();
  });

  it("snippet-driven row: expanded detail is removed outright when tips are hidden", async () => {
    await mount("review");

    expect(criticTip()).not.toBeNull();
    criticTip()!.click();
    await tick();
    expect(criticDetail()!.hidden).toBe(false);

    infoTips.set(true);
    await tick();

    expect(criticTip()).toBeNull();
    expect(criticDetail()).toBeNull();
  });

  it("no ⓘ survives in any section when tips are hidden", async () => {
    infoTips.set(true);
    await mount("autonomy");

    for (const section of REPO_SETTINGS_SECTIONS) {
      await visit(section);
      expect(document.querySelectorAll("button.info"), section).toHaveLength(0);
      expect(document.querySelectorAll(".auto-detail"), section).toHaveLength(0);
    }
  });

  it("re-enabling tips restores a cleanly collapsed panel (no stale expansion)", async () => {
    await mount("agent");

    sandboxTip()!.click();
    await tick();
    expect(sandboxDetail()!.hidden).toBe(false);

    infoTips.set(true);
    await tick(); // let the $effect observe the flip before re-enabling

    infoTips.set(false);
    await tick();

    // openDetail is component-local state that survives the flip without a remount; the
    // $effect reset is what stops the row coming back still expanded.
    expect(sandboxTip()).not.toBeNull();
    expect(sandboxDetail()!.hidden).toBe(true);
  });

  it("renders the ⓘ affordances by default (preference off)", async () => {
    await mount("agent");

    expect(document.querySelectorAll("button.info").length).toBeGreaterThan(0);
    expect(sandboxDetail()).not.toBeNull();
  });
});

describe("RepoSettingsBody — Auto-Drain explanation (#2872)", () => {
  it("renders an intro plus titled sections, naming both cases and the off-switch fallback", async () => {
    await mount("start");
    document
      .querySelector<HTMLButtonElement>('button[aria-controls="auto-detail-auto-drain"]')!
      .click();
    await tick();

    const detail = document.querySelector<HTMLElement>("#auto-detail-auto-drain")!;
    expect(detail.hidden).toBe(false);
    const titles = [...detail.querySelectorAll("strong")].map((t) => t.textContent);
    expect(titles).toEqual([
      m.automation_autodrain_detail_backlog_title(),
      m.automation_autodrain_detail_landing_title(),
      m.automation_autodrain_detail_off_title(),
      m.automation_autodrain_detail_limits_title(),
    ]);
    expect(detail.textContent).toContain(m.automation_autodrain_detail_intro());
    expect(detail.textContent).toContain(m.automation_autodrain_detail_off());
    await expect.element(page.getByText(m.automation_autodrain_desc())).toBeInTheDocument();
  });
});

describe("RepoSettingsBody — sandbox default + auto-drain hold (#2100)", () => {
  const REPO = "/tmp/repo";
  const held = () => page.getByText(m.automation_autodrain_sandbox_held());

  afterEach(() => {
    repoConfig.autoDrain = {};
    repoConfig.sandboxProfile = {};
    repoConfig.sandboxDefault = {};
  });

  it("the inherit option names the global default it resolves to", async () => {
    await mount("agent");
    repoConfig.sandboxProfile = { [REPO]: "inherit" };
    repoConfig.sandboxDefault = { [REPO]: "standard" };
    await tick();
    const select = page.getByRole("combobox", { name: m.automation_sandbox_profile_label() });
    await expect.element(select).toHaveValue("inherit");
    expect(
      page
        .getByRole("option", {
          name: m.automation_sandbox_inherit({ profile: m.sandbox_profile_standard() }),
        })
        .query(),
    ).not.toBeNull();
  });

  it("auto-drain on a repo resolving to standard explains the hold", async () => {
    await mount("start");
    repoConfig.autoDrain = { [REPO]: true };
    repoConfig.sandboxProfile = { [REPO]: "inherit" };
    repoConfig.sandboxDefault = { [REPO]: "standard" };
    await tick();
    await expect.element(held()).toBeVisible();
  });

  it("no hold note for autonomous/trusted, or with auto-drain off", async () => {
    await mount("start");
    repoConfig.autoDrain = { [REPO]: true };
    repoConfig.sandboxProfile = { [REPO]: "autonomous" };
    await tick();
    await expect.element(held()).not.toBeVisible();
    repoConfig.sandboxProfile = { [REPO]: "inherit" };
    repoConfig.sandboxDefault = { [REPO]: "trusted" };
    await tick();
    await expect.element(held()).not.toBeVisible();
    repoConfig.autoDrain = { [REPO]: false };
    repoConfig.sandboxProfile = { [REPO]: "standard" };
    await tick();
    await expect.element(held()).not.toBeVisible();
  });
});

describe("RepoSettingsBody — Open shared browser", () => {
  const REPO = "/tmp/repo";
  const openButton = () => page.getByRole("button", { name: m.automation_shared_browser_open() });

  afterEach(() => {
    vi.unstubAllGlobals();
    repoConfig.sharedBrowser = {};
    for (const t of toasts.items) toasts.close(t.id);
  });

  // Only the open endpoint is faked; every other request the panel makes keeps its real path.
  const realFetch = globalThis.fetch;
  function stubFetch(open: () => Response) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === "/api/repo-browser/open" ? open() : realFetch(input, init),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("is shown only while the toggle is on", async () => {
    stubFetch(() => Response.json({ ok: true, url: "about:blank" }));
    repoConfig.sharedBrowser = { [REPO]: false };
    await mount("agent");
    expect(openButton().query()).toBeNull();
    repoConfig.sharedBrowser = { [REPO]: true };
    await expect.element(openButton()).toBeVisible();
  });

  it("calls the open endpoint with the repo and session", async () => {
    const fetchMock = stubFetch(() => Response.json({ ok: true, url: "about:blank" }));
    repoConfig.sharedBrowser = { [REPO]: true };
    await mount("agent", { repoPath: REPO, sessionId: "sess-1" });
    await expect.element(openButton()).toBeVisible();
    (openButton().element() as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u) === "/api/repo-browser/open")).toBe(true),
    );
    const call = fetchMock.mock.calls.find(([u]) => String(u) === "/api/repo-browser/open")!;
    const init = (call as unknown as [string, RequestInit])[1];
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ repo: REPO, sessionId: "sess-1" });
    expect(toasts.items).toEqual([]);
  });

  it("maps a refusal code to a toast", async () => {
    stubFetch(() => Response.json({ error: "cap", code: "cap" }, { status: 503 }));
    repoConfig.sharedBrowser = { [REPO]: true };
    await mount("agent");
    (openButton().element() as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(toasts.items.map((t) => t.text)).toEqual([m.automation_shared_browser_open_cap()]),
    );
  });
});

describe("RepoSettingsBody — claude.ai connectors", () => {
  const REPO = "/tmp/repo";
  const connectorSwitch = () =>
    page.getByRole("switch", { name: m.automation_claudeai_connectors_name() });

  afterEach(() => {
    vi.unstubAllGlobals();
    repoConfig.claudeAiConnectors = {};
    for (const t of toasts.items) toasts.close(t.id);
  });

  // Fake only the repo-config PUT: echo the patch back with the given restart counts.
  const realFetch = globalThis.fetch;
  function stubPut(connectorRestart?: { now: number; later: number }) {
    const puts: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).startsWith("/api/repo-config") && init?.method === "PUT") {
          const patch = JSON.parse(String(init.body)) as Record<string, unknown>;
          puts.push(patch);
          return Response.json({ ...patch, connectorRestart });
        }
        return realFetch(input, init);
      }),
    );
    return puts;
  }

  it("flips the switch and toasts how many sessions restart now and later", async () => {
    const puts = stubPut({ now: 2, later: 1 });
    repoConfig.claudeAiConnectors = { [REPO]: false };
    await mount("agent");
    await expect.element(connectorSwitch()).toHaveAttribute("aria-checked", "false");
    (connectorSwitch().element() as HTMLButtonElement).click();
    await vi.waitFor(() => expect(puts).toEqual([{ claudeAiConnectorsEnabled: true }]));
    await expect.element(connectorSwitch()).toHaveAttribute("aria-checked", "true");
    await vi.waitFor(() =>
      expect(toasts.items.map((t) => t.text)).toEqual([
        m.automation_claudeai_connectors_restart_toast({ now: 2, later: 1 }),
      ]),
    );
  });

  it("stays quiet when no live session restarts", async () => {
    const puts = stubPut({ now: 0, later: 0 });
    repoConfig.claudeAiConnectors = { [REPO]: false };
    await mount("agent");
    (connectorSwitch().element() as HTMLButtonElement).click();
    await vi.waitFor(() => expect(puts).toHaveLength(1));
    await tick();
    expect(toasts.items).toEqual([]);
  });
});

describe("RepoSettingsBody — browser allowed hosts", () => {
  const REPO = "/tmp/repo";
  const hostInput = () => page.getByRole("textbox", { name: m.automation_browser_hosts_label() });
  const addButton = () =>
    page.getByRole("button", { name: m.automation_browser_hosts_add(), exact: true });

  afterEach(() => {
    vi.unstubAllGlobals();
    repoConfig.sharedBrowser = {};
    repoConfig.browserAllowedHosts = {};
  });

  // Fake only the repo-config PUT: echo the patch back as the stored config.
  const realFetch = globalThis.fetch;
  function stubFetch() {
    const puts: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("/api/repo-config") && init?.method === "PUT") {
        const patch = JSON.parse(String(init.body)) as Record<string, unknown>;
        puts.push(patch);
        return Response.json({ sharedBrowserEnabled: true, ...patch });
      }
      return realFetch(input, init);
    });
    vi.stubGlobal("fetch", fetchMock);
    return puts;
  }

  async function addHost(value: string) {
    const input = hostInput().element() as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    (addButton().element() as HTMLButtonElement).click();
    await tick();
  }

  it("is shown only while the shared browser is on", async () => {
    stubFetch();
    repoConfig.sharedBrowser = { [REPO]: false };
    await mount("agent");
    expect(hostInput().query()).toBeNull();
    repoConfig.sharedBrowser = { [REPO]: true };
    await expect.element(hostInput()).toBeVisible();
    await expect.element(page.getByText(m.automation_browser_hosts_hint())).toBeVisible();
  });

  it("adds a normalized host and persists the full list", async () => {
    const puts = stubFetch();
    repoConfig.sharedBrowser = { [REPO]: true };
    repoConfig.browserAllowedHosts = { [REPO]: ["a.example.com"] };
    await mount("agent");
    await addHost(" App.Example.com ");
    await vi.waitFor(() =>
      expect(puts).toEqual([{ browserAllowedHosts: ["a.example.com", "app.example.com"] }]),
    );
    await expect.element(page.getByText("app.example.com", { exact: true })).toBeVisible();
    expect((hostInput().element() as HTMLInputElement).value).toBe("");
  });

  it("removes a host and persists the rest", async () => {
    const puts = stubFetch();
    repoConfig.sharedBrowser = { [REPO]: true };
    repoConfig.browserAllowedHosts = { [REPO]: ["a.example.com", "b.example.com"] };
    await mount("agent");
    const remove = page.getByRole("button", {
      name: m.automation_browser_hosts_remove({ host: "a.example.com" }),
    });
    (remove.element() as HTMLButtonElement).click();
    await vi.waitFor(() => expect(puts).toEqual([{ browserAllowedHosts: ["b.example.com"] }]));
    expect(page.getByText("a.example.com", { exact: true }).query()).toBeNull();
  });

  it.each([
    ["https://x.com", () => m.automation_browser_hosts_err_invalid()],
    ["x.com:443", () => m.automation_browser_hosts_err_invalid()],
    ["*.x.com", () => m.automation_browser_hosts_err_invalid()],
    ["localhost", () => m.automation_browser_hosts_err_invalid()],
    ["1.2.3.4", () => m.automation_browser_hosts_err_ip()],
    ["A.example.com", () => m.automation_browser_hosts_err_duplicate()],
  ])("rejects %s inline without saving", async (value, message) => {
    const puts = stubFetch();
    repoConfig.sharedBrowser = { [REPO]: true };
    repoConfig.browserAllowedHosts = { [REPO]: ["a.example.com"] };
    await mount("agent");
    await addHost(value);
    await expect.element(page.getByRole("alert")).toHaveTextContent(message());
    expect(hostInput().element().getAttribute("aria-invalid")).toBe("true");
    expect(puts).toEqual([]);
  });
});

describe("RepoSettingsBody — extra allowed hosts (#3446)", () => {
  const REPO = "/tmp/repo";
  const hostInput = () => page.getByRole("textbox", { name: m.automation_egress_hosts_label() });
  const addButton = () =>
    page.getByRole("button", { name: m.automation_egress_hosts_add(), exact: true });

  afterEach(() => {
    vi.unstubAllGlobals();
    repoConfig.sandboxProfile = {};
    repoConfig.sandboxDefault = {};
    repoConfig.egressExtraHosts = {};
  });

  // Fake only the repo-config PUT: echo the patch back as the stored config, still Autonomous.
  const realFetch = globalThis.fetch;
  function stubFetch() {
    const puts: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("/api/repo-config") && init?.method === "PUT") {
        const patch = JSON.parse(String(init.body)) as Record<string, unknown>;
        puts.push(patch);
        return Response.json({ sandboxProfile: "autonomous", ...patch });
      }
      return realFetch(input, init);
    });
    vi.stubGlobal("fetch", fetchMock);
    return puts;
  }

  async function addHost(value: string) {
    const input = hostInput().element() as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    (addButton().element() as HTMLButtonElement).click();
    await tick();
  }

  it("is shown only while the repo runs Autonomous, an inherited default included", async () => {
    stubFetch();
    repoConfig.sandboxProfile = { [REPO]: "trusted" };
    await mount("agent");
    expect(hostInput().query()).toBeNull();
    repoConfig.sandboxProfile = { [REPO]: "standard" };
    await tick();
    expect(hostInput().query()).toBeNull();
    repoConfig.sandboxProfile = { [REPO]: "autonomous" };
    await expect.element(hostInput()).toBeVisible();
    await expect.element(page.getByText(m.automation_egress_hosts_empty())).toBeVisible();
    repoConfig.sandboxProfile = { [REPO]: "inherit" };
    await tick();
    expect(hostInput().query()).toBeNull(); // the inherited default is still unknown
    repoConfig.sandboxDefault = { [REPO]: "autonomous" };
    await expect.element(hostInput()).toBeVisible();
  });

  it("adds a normalized host and persists the full list", async () => {
    const puts = stubFetch();
    repoConfig.sandboxProfile = { [REPO]: "autonomous" };
    repoConfig.egressExtraHosts = { [REPO]: ["a.example.com"] };
    await mount("agent");
    await addHost(" Registry.Example.com ");
    await vi.waitFor(() =>
      expect(puts).toEqual([{ egressExtraHosts: ["a.example.com", "registry.example.com"] }]),
    );
    await expect.element(page.getByText("registry.example.com", { exact: true })).toBeVisible();
    expect((hostInput().element() as HTMLInputElement).value).toBe("");
  });

  it("takes a dotted-quad, as the server does, after a risky-host warning (#3922)", async () => {
    const puts = stubFetch();
    repoConfig.sandboxProfile = { [REPO]: "autonomous" };
    await mount("agent");
    await addHost("10.0.0.1");
    await expect
      .element(page.getByText(m.automation_egress_hosts_warn({ reason: m.egress_risk_ip() })))
      .toBeVisible();
    expect(puts).toEqual([]);
    const anyway = page.getByRole("button", { name: m.automation_egress_hosts_add_anyway() });
    (anyway.element() as HTMLButtonElement).click();
    await vi.waitFor(() => expect(puts).toEqual([{ egressExtraHosts: ["10.0.0.1"] }]));
  });

  it("adds port entries, normalizing :443 away", async () => {
    const puts = stubFetch();
    repoConfig.sandboxProfile = { [REPO]: "autonomous" };
    await mount("agent");
    await addHost("git.example.com:8443");
    await vi.waitFor(() => expect(puts).toEqual([{ egressExtraHosts: ["git.example.com:8443"] }]));
    await addHost("x.example.com:443");
    await vi.waitFor(() =>
      expect(puts.at(-1)).toEqual({ egressExtraHosts: ["git.example.com:8443", "x.example.com"] }),
    );
  });

  it("adds a wildcard entry only after Add anyway, and flags its chip (#3923)", async () => {
    const puts = stubFetch();
    repoConfig.sandboxProfile = { [REPO]: "autonomous" };
    await mount("agent");
    const reason = m.egress_risk_wildcard();
    await addHost("*.Example.com");
    await expect.element(page.getByText(m.automation_egress_hosts_warn({ reason }))).toBeVisible();
    expect(puts).toEqual([]);
    const anyway = page.getByRole("button", { name: m.automation_egress_hosts_add_anyway() });
    (anyway.element() as HTMLButtonElement).click();
    await vi.waitFor(() => expect(puts).toEqual([{ egressExtraHosts: ["*.example.com"] }]));
    await expect
      .element(
        page.getByRole("button", {
          name: m.automation_egress_hosts_risky_chip({ host: "*.example.com", reason }),
        }),
      )
      .toBeVisible();
  });

  it("removes a host and persists the rest", async () => {
    const puts = stubFetch();
    repoConfig.sandboxProfile = { [REPO]: "autonomous" };
    repoConfig.egressExtraHosts = { [REPO]: ["a.example.com", "b.example.com"] };
    await mount("agent");
    const remove = page.getByRole("button", {
      name: m.automation_egress_hosts_remove({ host: "a.example.com" }),
    });
    (remove.element() as HTMLButtonElement).click();
    await vi.waitFor(() => expect(puts).toEqual([{ egressExtraHosts: ["b.example.com"] }]));
    expect(page.getByText("a.example.com", { exact: true }).query()).toBeNull();
  });

  it.each([
    ["localhost", () => m.automation_egress_hosts_err_invalid()],
    ["-x.com", () => m.automation_egress_hosts_err_invalid()],
    ["https://x.com", () => m.automation_egress_hosts_err_invalid()],
    ["*.com", () => m.automation_egress_hosts_err_invalid()],
    ["x.com:0", () => m.automation_egress_hosts_err_invalid()],
    ["a.example.com:443", () => m.automation_egress_hosts_err_duplicate()],
    ["   ", () => m.automation_egress_hosts_err_empty()],
    ["A.example.com", () => m.automation_egress_hosts_err_duplicate()],
  ])("rejects %j inline without saving", async (value, message) => {
    const puts = stubFetch();
    repoConfig.sandboxProfile = { [REPO]: "autonomous" };
    repoConfig.egressExtraHosts = { [REPO]: ["a.example.com"] };
    await mount("agent");
    await addHost(value);
    await expect.element(page.getByRole("alert")).toHaveTextContent(message());
    expect(hostInput().element().getAttribute("aria-invalid")).toBe("true");
    expect(puts).toEqual([]);
  });

  it("renders a repeat the API stored, and removing it removes every copy", async () => {
    const puts = stubFetch();
    repoConfig.sandboxProfile = { [REPO]: "autonomous" };
    repoConfig.egressExtraHosts = { [REPO]: ["a.example.com", "a.example.com", "b.example.com"] };
    await mount("agent");
    await expect.element(page.getByText("b.example.com", { exact: true })).toBeVisible();
    const removes = page.getByRole("button", {
      name: m.automation_egress_hosts_remove({ host: "a.example.com" }),
    });
    expect(removes.elements()).toHaveLength(2);
    (removes.elements()[0] as HTMLButtonElement).click();
    await vi.waitFor(() => expect(puts).toEqual([{ egressExtraHosts: ["b.example.com"] }]));
  });

  it("hides on a non-Autonomous profile without touching the stored hosts", async () => {
    const puts = stubFetch();
    repoConfig.sandboxProfile = { [REPO]: "autonomous" };
    repoConfig.egressExtraHosts = { [REPO]: ["a.example.com"] };
    await mount("agent");
    await expect.element(page.getByText("a.example.com", { exact: true })).toBeVisible();
    repoConfig.sandboxProfile = { [REPO]: "standard" };
    await tick();
    expect(hostInput().query()).toBeNull();
    expect(puts).toEqual([]);
    expect(repoConfig.egressExtraHostsFor(REPO)).toEqual(["a.example.com"]);
  });
});

describe("RepoSettingsBody — merge without CI (#3104)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    repoConfig.mergeWithoutCi = {};
  });

  const toggle = () => page.getByRole("switch", { name: m.automation_merge_without_ci_name() });

  it("reflects the repo flag (default off) and toggles it on click", async () => {
    const spy = vi.spyOn(repoConfig, "toggleMergeWithoutCi").mockResolvedValue(undefined);
    await mount("merge");
    await expect.element(toggle()).toHaveAttribute("aria-checked", "false");
    repoConfig.mergeWithoutCi = { "/tmp/repo": true };
    await expect.element(toggle()).toHaveAttribute("aria-checked", "true");
    (toggle().element() as HTMLButtonElement).click();
    expect(spy).toHaveBeenCalledWith("/tmp/repo");
  });
});

describe("RepoSettingsBody — no-PR-CI card (#3305)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    repoConfig.loaded = {};
    repoConfig.noPrCi = {};
    repoConfig.mergeWithoutCi = {};
  });

  const card = () => document.querySelector<HTMLElement>(".auto-hold");
  const setup = () => page.getByRole("button", { name: m.automation_no_pr_ci_setup() });
  const mergeWithout = () =>
    page.getByRole("button", { name: m.automation_no_pr_ci_merge_without() });

  function holdRepo() {
    repoConfig.loaded = { "/tmp/repo": true };
    repoConfig.noPrCi = { "/tmp/repo": true };
  }

  it("explains the hold with both fixes, and goes once Merge without CI is on", async () => {
    holdRepo();
    const spy = vi.spyOn(repoConfig, "toggleMergeWithoutCi").mockResolvedValue(undefined);
    const onsetupci = vi.fn();
    show({ onsetupci });
    await expect.element(page.getByText(m.automation_no_pr_ci_title())).toBeVisible();
    expect(card()!.getAttribute("role")).toBe("status");

    (setup().element() as HTMLButtonElement).click();
    expect(onsetupci).toHaveBeenCalledOnce();
    (mergeWithout().element() as HTMLButtonElement).click();
    expect(spy).toHaveBeenCalledWith("/tmp/repo");

    repoConfig.mergeWithoutCi = { "/tmp/repo": true };
    await tick();
    expect(card()).toBeNull();
  });

  it("offers only Merge without CI when the host cannot seed a task", async () => {
    holdRepo();
    show();
    await expect.element(mergeWithout()).toBeVisible();
    expect(setup().query()).toBeNull();
  });

  it("shows no card for a repo that runs PR CI", async () => {
    repoConfig.loaded = { "/tmp/repo": true };
    await mount("autonomy");
    expect(card()).toBeNull();
  });
});

describe("RepoSettingsBody — epic halt hint (#3443)", () => {
  const REPO = "/tmp/halt-repo";
  const drain: DrainStatus = {
    repoPath: REPO,
    enabled: true,
    paused: true,
    reason: "sandbox_interactive",
    detail: "standard",
    queued: 1,
    inFlight: 0,
    max: 1,
    epicParent: 42,
  };
  const blockers = (enabled: boolean) => ({
    causes: [
      {
        code: "sandbox_interactive",
        scope: "repo",
        detail: "standard",
        fix: { changes: { sandboxProfile: "autonomous" }, enabled, checks: [] },
      },
    ],
    options: [],
    preselect: null,
  });
  const autonomous = () => page.getByRole("button", { name: m.repooverview_halt_autonomous() });

  afterEach(() => vi.unstubAllGlobals());

  // Fake the auto-fix model and its apply; every other request keeps its real path.
  const realFetch = globalThis.fetch;
  function stubAutoFix(enabled: boolean) {
    const posts: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!String(input).startsWith("/api/epic/auto-fix")) return realFetch(input, init);
        if (init?.method === "POST") {
          posts.push(JSON.parse(String(init.body)));
          return Response.json({
            previous: { sandboxProfile: "inherit" },
            blockers: blockers(enabled),
          });
        }
        return Response.json(blockers(enabled));
      }),
    );
    return posts;
  }

  it("says what holds the epic and switches the repo to Autonomous through the auto-fix", async () => {
    const posts = stubAutoFix(true);
    show({ repoPath: REPO, drain });
    await expect
      .element(page.getByText(m.repooverview_halt_title({ repo: "halt-repo" })))
      .toBeVisible();
    await autonomous().click();
    await vi.waitFor(() => expect(posts).toEqual([{ cause: "sandbox_interactive" }]));
  });

  it("offers no switch the model doesn't report effective here", async () => {
    stubAutoFix(false);
    show({ repoPath: REPO, drain });
    await expect
      .element(page.getByText(m.repooverview_halt_title({ repo: "halt-repo" })))
      .toBeVisible();
    expect(autonomous().query()).toBeNull();
  });

  it("stays away while nothing holds the repo's epic", async () => {
    stubAutoFix(true);
    await mount("autonomy", { repoPath: REPO, drain: { ...drain, reason: null, detail: null } });
    expect(document.querySelector("[data-epic-halt]")).toBeNull();
  });
});

describe("RepoSettingsBody — lock reasons (#3444)", () => {
  const repo = "/tmp/repo";
  afterEach(() => {
    repoConfig.repoMode = {};
    repoConfig.enabled = {};
    repoConfig.autoMerge = {};
    repoConfig.autopilot = {};
  });

  /** Every locked switch row by its field, in every section, with the reason it names. */
  async function locks(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const section of REPO_SETTINGS_SECTIONS) {
      await visit(section);
      for (const s of document.querySelectorAll<HTMLButtonElement>(
        '[role="switch"][aria-describedby]',
      )) {
        const row = s.closest<HTMLElement>("[data-field]")!;
        const reason = document.getElementById(s.getAttribute("aria-describedby")!)!;
        expect(s.disabled, row.dataset.field).toBe(true);
        // the reason stays readable while the rest of the row dims
        for (let el: HTMLElement | null = reason; el && el !== row; el = el.parentElement)
          expect(getComputedStyle(el).opacity, row.dataset.field).toBe("1");
        out[row.dataset.field!] = reason.textContent!.trim();
      }
    }
    return out;
  }

  it("a local-only repo locks exactly the GitHub settings, each with its reason", async () => {
    repoConfig.repoMode = { [repo]: "lightweight" };
    await mount("autonomy");
    const reason = m.automation_lightweight_unavailable();
    expect(await locks()).toEqual({
      autoDrainEnabled: reason,
      criticAllPrs: reason,
      mergeWithoutCi: reason,
      manualStepsIssueEnabled: reason,
      epicStacksEnabled: reason,
      preWarmEpicLandingCi: reason,
    });
    await visit("merge");
    const draft = page.getByRole("radio", { name: m.reposettings_merge_mode_draft(), exact: true });
    await expect.element(draft).toBeDisabled();
    await expect.element(draft).toHaveAccessibleDescription(new RegExp(`${reason}$`));
    for (const name of [m.reposettings_merge_mode_manual(), m.automation_automerge_name()])
      await expect.element(page.getByRole("radio", { name, exact: true })).toBeEnabled();
  });

  it("with the Critic off, exactly Auto-Address and the smell lens are locked", async () => {
    repoConfig.enabled = { [repo]: false };
    await mount("autonomy");
    expect(await locks()).toEqual({
      autoAddressEnabled: m.automation_autoaddress_needs_critic(),
      criticSmellLensEnabled: m.automation_smelllens_needs_critic(),
    });
  });

  it("locks nothing in a GitHub repo with the Critic on", async () => {
    await mount("autonomy");
    expect(await locks()).toEqual({});
  });

  it("Go to Autopilot opens Start & flow and focuses the Autopilot switch", async () => {
    repoConfig.autoMerge = { [repo]: true };
    await mount("merge");
    await page.getByRole("button", { name: m.reposettings_merge_goto_autopilot() }).click();
    await expect
      .element(page.getByRole("switch", { name: m.automation_autopilot_name() }))
      .toHaveFocus();
    expect(tab("start")!.getAttribute("aria-selected")).toBe("true");
  });
});

describe("RepoSettingsBody — the autonomy chain follows the switches (#3445)", () => {
  const REPO = "/tmp/repo-chain";

  afterEach(() => vi.restoreAllMocks());

  it("flipping Critic, Auto-Address or Autopilot moves its step at once", async () => {
    let config: Record<string, unknown> = {
      criticEnabled: false,
      autoAddressEnabled: false,
      autopilotEnabled: false,
      autoDrainEnabled: false,
      autoMergeEnabled: false,
      draftMode: false,
      signoffAuthority: "human",
      repoMode: "forge",
      sandboxProfile: "autonomous",
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (!String(input).startsWith("/api/repo-config")) return new Response("{}", { status: 404 });
      if (init?.method === "PUT") config = { ...config, ...JSON.parse(String(init.body)) };
      return Response.json(config);
    });
    await mount("autonomy", { repoPath: REPO });
    await vi.waitFor(() => expect(repoConfig.isConfigLoaded(REPO)).toBe(true));
    const step = (s: string) => document.querySelector(`[data-step="${s}"]`)!.textContent!;
    for (const s of ["review", "fix", "stops"]) expect(step(s)).toContain(m.guardtl_marker_you());

    // each switch lives in its own section; the chain sits in Autonomy
    await visit("review");
    await page.getByRole("switch", { name: m.automation_critic_name(), exact: true }).click();
    await visit("autonomy");
    expect(step("review")).toContain(m.reposettings_chain_shepherd());
    // Auto-Address only fixes what the Critic found
    expect(step("fix")).toContain(m.guardtl_marker_you());
    await visit("review");
    await page.getByRole("switch", { name: m.automation_autoaddress_name() }).click();
    await visit("autonomy");
    expect(step("fix")).toContain(m.reposettings_chain_shepherd());
    await visit("start");
    await page.getByRole("switch", { name: m.automation_autopilot_name() }).click();
    await visit("autonomy");
    expect(step("stops")).toContain(m.reposettings_chain_shepherd());
    // three switches and the level follows: With review
    await expect
      .element(page.getByRole("radio", { name: m.reposettings_autonomy_review(), exact: true }))
      .toBeChecked();
  });
});

describe("RepoSettingsBody — search", () => {
  it("finds settings in unmounted sections and opens their controls", async () => {
    await mount("autonomy");
    const input = page.getByRole("searchbox", { name: m.reposettings_search_label() });
    await input.fill(m.automation_critic_name());
    await page
      .getByRole("button", {
        name: `${m.automation_critic_name()} ${m.reposettings_section_review()}`,
        exact: true,
      })
      .click();
    await expect
      .element(page.getByRole("switch", { name: m.automation_critic_name() }))
      .toHaveFocus();
    await expect.element(input).toHaveValue("");
    expect(tab("review")?.getAttribute("aria-selected")).toBe("true");
  });

  it("announces no results and clears back to the selected section", async () => {
    await mount("display");
    const input = page.getByRole("searchbox", { name: m.reposettings_search_label() });
    await input.fill("zzzz_no_such_setting");
    await expect.element(page.getByRole("status")).toHaveTextContent(m.reposettings_search_empty());
    await page.getByRole("button", { name: m.reposettings_search_clear() }).click();
    await expect.element(input).toHaveFocus();
    await expect
      .element(page.getByRole("switch", { name: m.reposettings_pin_name() }))
      .toBeVisible();
    await input.fill("critic");
    await visit("epics");
    await expect.element(input).toHaveValue("");
    await expect
      .element(page.getByRole("switch", { name: m.automation_epic_stacks_name() }))
      .toBeVisible();
  });
});
