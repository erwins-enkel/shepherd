import { afterEach, describe, expect, it, vi } from "vitest";
import { tick } from "svelte";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import { m } from "#lib/paraglide/messages.js";
import type { RepoRunDefaults } from "#lib/api.js";
import type { Session } from "#lib/types.js";

// The repos with their own values, as GET /api/repo-run-defaults serves them.
let server: RepoRunDefaults[] = [];
let refuse = false;
vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
  return {
    ...actual,
    getRepoRunDefaults: vi.fn(async () => {
      if (refuse) throw new Error("500");
      return { repos: server };
    }),
  };
});

const { default: UsageFailoverAction } = await import("./UsageFailoverAction.svelte");
const { getRepoRunDefaults } = await import("#lib/api.js");

const OFFER = { from: "codex", to: "claude", fromFreePct: 23, toFreePct: 79 } as const;
const ACTIVE = { active: true, from: "codex", current: "claude" } as const;

const props = (over: Partial<Record<string, unknown>> = {}) => ({
  offer: null,
  failover: null,
  busy: false,
  failed: false,
  onEngage: vi.fn(),
  onRelease: vi.fn(),
  sessions: [],
  onOpenRepo: vi.fn(),
  ...over,
});

afterEach(() => {
  server = [];
  refuse = false;
  vi.mocked(getRepoRunDefaults).mockClear();
});

describe("UsageFailoverAction", () => {
  it("renders nothing with neither an offer nor an active failover", () => {
    render(UsageFailoverAction, { props: props() });
    expect(document.querySelector(".failover")).toBeNull();
  });

  it("offers the switch and names the target CLI", async () => {
    render(UsageFailoverAction, { props: props({ offer: OFFER }) });
    await expect
      .element(
        page.getByRole("button", {
          name: m.usage_failover_engage({ provider: m.agent_provider_claude() }),
        }),
      )
      .toBeVisible();
  });

  it("states both providers and both percentages, so it cannot contradict the hero", async () => {
    render(UsageFailoverAction, { props: props({ offer: OFFER }) });
    const reason = document.querySelector(".failover-reason")!.textContent!;
    expect(reason).toContain("23");
    expect(reason).toContain("79");
    expect(reason).toContain(m.agent_provider_codex());
    expect(reason).toContain(m.agent_provider_claude());
  });

  it("clicking the offer engages", async () => {
    const onEngage = vi.fn();
    render(UsageFailoverAction, { props: props({ offer: OFFER, onEngage }) });
    await page
      .getByRole("button", {
        name: m.usage_failover_engage({ provider: m.agent_provider_claude() }),
      })
      .click();
    expect(onEngage).toHaveBeenCalledTimes(1);
  });

  it("an active failover shows the revert instead of the offer", async () => {
    const onRelease = vi.fn();
    render(UsageFailoverAction, { props: props({ offer: OFFER, failover: ACTIVE, onRelease }) });
    await page
      .getByRole("button", {
        name: m.usage_failover_revert({ provider: m.agent_provider_codex() }),
      })
      .click();
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it("disables the button while a request is in flight", () => {
    render(UsageFailoverAction, { props: props({ offer: OFFER, busy: true }) });
    expect(document.querySelector<HTMLButtonElement>(".failover-btn")!.disabled).toBe(true);
  });

  it("surfaces a refused switch as an alert", async () => {
    render(UsageFailoverAction, { props: props({ offer: OFFER, failed: true }) });
    await expect.element(page.getByRole("alert")).toHaveTextContent(m.usage_failover_failed());
  });
});

describe("UsageFailoverAction — repos that stay on the exhausted CLI (#3448)", () => {
  // Global Claude Code, the switch goes to Codex.
  const CLAUDE_OFFER = { from: "claude", to: "codex", fromFreePct: 12, toFreePct: 79 } as const;
  const CLAUDE_ACTIVE = { active: true, from: "claude", current: "codex" } as const;
  const repo = (
    name: string,
    agentProvider: RepoRunDefaults["agentProvider"],
  ): RepoRunDefaults => ({
    repoPath: `/real/${name}`,
    name,
    agentProvider,
    defaultModel: "inherit",
    defaultEffort: "inherit",
    defaultExecutionEffort: "inherit",
  });
  const live = (name: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `${name}-${i}`,
      repoPath: `/real/${name}`,
      status: "running",
    })) as unknown as Session[];
  const twoSessions = m.usage_failover_staying_sessions_other({ count: 2 });
  // The list's read has answered (or failed) and the component has rendered what it got.
  async function listSettled() {
    await vi.waitFor(() => expect(vi.mocked(getRepoRunDefaults)).toHaveBeenCalled());
    await vi.mocked(getRepoRunDefaults).mock.results[0]!.value.catch(() => {});
    await tick();
  }
  const entry = (name: string, sessions: string) =>
    page.getByRole("button", {
      name: m.usage_failover_staying_open_aria({ repo: name, sessions }),
    });

  it("names a repo pinned to the exhausted CLI with its two sessions", async () => {
    server = [repo("app", "claude")];
    render(UsageFailoverAction, {
      props: props({ offer: CLAUDE_OFFER, sessions: live("app", 2) }),
    });
    await expect.element(entry("app", twoSessions)).toBeVisible();
    await expect
      .element(
        page.getByText(m.usage_failover_staying_title({ provider: m.agent_provider_claude() })),
      )
      .toBeVisible();
    expect(document.querySelector(".staying-repo")!.textContent).toContain(twoSessions);
  });

  it("names it while the switch is in effect too", async () => {
    server = [repo("app", "claude")];
    render(UsageFailoverAction, {
      props: props({ failover: CLAUDE_ACTIVE, sessions: live("app", 1) }),
    });
    await expect.element(entry("app", m.usage_failover_staying_sessions_one())).toBeVisible();
  });

  it("the same repo without running sessions: no hint", async () => {
    server = [repo("app", "claude")];
    render(UsageFailoverAction, {
      props: props({ offer: CLAUDE_OFFER, sessions: live("other", 3) }),
    });
    await expect
      .element(
        page.getByRole("button", {
          name: m.usage_failover_engage({ provider: m.agent_provider_codex() }),
        }),
      )
      .toBeVisible();
    await listSettled();
    expect(document.querySelector(".staying")).toBeNull();
  });

  it("repos that inherit or are pinned to the target CLI never appear", async () => {
    server = [repo("inh", "inherit"), repo("cdx", "codex"), repo("app", "claude")];
    render(UsageFailoverAction, {
      props: props({
        offer: CLAUDE_OFFER,
        sessions: [...live("inh", 2), ...live("cdx", 2), ...live("app", 2)],
      }),
    });
    await expect.element(entry("app", twoSessions)).toBeVisible();
    expect([...document.querySelectorAll(".staying-repo .name")].map((n) => n.textContent)).toEqual(
      ["app"],
    );
  });

  it("an entry opens that repo", async () => {
    server = [repo("app", "claude")];
    const onOpenRepo = vi.fn();
    render(UsageFailoverAction, {
      props: props({ offer: CLAUDE_OFFER, sessions: live("app", 2), onOpenRepo }),
    });
    await entry("app", twoSessions).click();
    expect(onOpenRepo).toHaveBeenCalledWith("/real/app");
  });

  it("a failed read shows no hint and leaves the switch usable", async () => {
    refuse = true;
    server = [repo("app", "claude")];
    render(UsageFailoverAction, {
      props: props({ offer: CLAUDE_OFFER, sessions: live("app", 2) }),
    });
    await listSettled();
    expect(document.querySelector(".staying")).toBeNull();
    expect(document.querySelector<HTMLButtonElement>(".failover-btn")!.disabled).toBe(false);
  });
});
