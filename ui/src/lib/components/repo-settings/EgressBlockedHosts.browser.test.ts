import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import {
  getRepoConfig,
  getRepoEgressBlocks,
  getSettings,
  putEgressMutedHosts,
  putRepoConfig,
} from "#lib/api.js";
import { m } from "#lib/paraglide/messages.js";
import type { EgressBlock } from "#lib/types.js";

vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
  return {
    ...actual,
    getRepoConfig: vi.fn(),
    getRepoEgressBlocks: vi.fn(),
    putRepoConfig: vi.fn(),
    getSettings: vi.fn(),
    putEgressMutedHosts: vi.fn(),
  };
});

const { default: EgressBlockedHosts } = await import("./EgressBlockedHosts.svelte");
const mockBlocks = vi.mocked(getRepoEgressBlocks);
const mockPut = vi.mocked(putRepoConfig);
const mockConfig = vi.mocked(getRepoConfig);

// repoConfig is a module singleton, so every test uses its own repo.
let n = 0;
let repo = "";

const block = (host: string): EgressBlock => ({
  host,
  count: 2,
  sessions: 2,
  sessionIds: ["s1", "s2"],
  lastSeen: Date.now() - 60_000,
});

const allowBtn = (host: string) =>
  page.getByRole("button", { name: m.egress_blocked_allow_host({ host }) });

beforeEach(() => {
  repo = `/repo/egress-${++n}`;
  mockBlocks.mockReset();
  mockPut.mockReset();
  mockConfig.mockReset();
  mockConfig.mockResolvedValue({ egressExtraHosts: [] } as never);
  mockPut.mockImplementation(async (_repo, patch) => ({ ...patch }) as never);
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("EgressBlockedHosts", () => {
  it("renders nothing while there are no blocks", async () => {
    mockBlocks.mockResolvedValue({ hosts: [] });
    render(EgressBlockedHosts, { repoPath: repo });
    await expect.poll(() => mockBlocks.mock.calls.length).toBeGreaterThan(0);
    expect(document.querySelector('[data-field="egressBlockedHosts"]')).toBeNull();
  });

  it("allows a trusted host in one click and drops it from the list", async () => {
    // the server drops the host once it is allowed
    mockBlocks.mockImplementation(async () => ({
      hosts: mockPut.mock.calls.length ? [] : [block("registry.npmjs.org")],
    }));
    render(EgressBlockedHosts, { repoPath: repo });

    await expect
      .element(page.getByText(m.egress_blocked_tier_trusted(), { exact: true }))
      .toBeVisible();
    await allowBtn("registry.npmjs.org").click();
    expect(mockPut).toHaveBeenCalledWith(repo, { egressExtraHosts: ["registry.npmjs.org"] });
    await expect.element(page.getByText("registry.npmjs.org")).not.toBeInTheDocument();
  });

  it("keeps the stored extra hosts, and waits for them before allowing", async () => {
    let loadConfig!: (c: never) => void;
    mockConfig.mockReturnValue(new Promise((res) => (loadConfig = res)));
    mockBlocks.mockResolvedValue({ hosts: [block("registry.npmjs.org")] });
    render(EgressBlockedHosts, { repoPath: repo });

    await expect.element(allowBtn("registry.npmjs.org")).toBeDisabled();
    loadConfig({ egressExtraHosts: ["corp.example.com"] } as never);
    await expect.element(allowBtn("registry.npmjs.org")).toBeEnabled();
    await allowBtn("registry.npmjs.org").click();
    expect(mockPut).toHaveBeenCalledWith(repo, {
      egressExtraHosts: ["corp.example.com", "registry.npmjs.org"],
    });
  });

  it("asks once before allowing a normal host", async () => {
    mockBlocks.mockResolvedValue({ hosts: [block("api.example.com")] });
    render(EgressBlockedHosts, { repoPath: repo });

    await allowBtn("api.example.com").click();
    expect(mockPut).not.toHaveBeenCalled();
    await expect
      .element(page.getByText(m.egress_blocked_confirm({ host: "api.example.com" })))
      .toBeVisible();
    await page.getByRole("button", { name: m.egress_blocked_confirm_allow() }).click();
    expect(mockPut).toHaveBeenCalledWith(repo, { egressExtraHosts: ["api.example.com"] });
  });

  it("names the risk before a risky host can be allowed, and Cancel writes nothing", async () => {
    mockBlocks.mockResolvedValue({ hosts: [block("abc.ngrok.io")] });
    render(EgressBlockedHosts, { repoPath: repo });

    const reason = m.egress_risk_tunnel();
    await expect.element(page.getByText(m.egress_blocked_tier_risky({ reason }))).toBeVisible();
    await allowBtn("abc.ngrok.io").click();
    await expect
      .element(page.getByText(m.egress_blocked_confirm_risky({ host: "abc.ngrok.io", reason })))
      .toBeVisible();
    await page.getByRole("button", { name: m.common_cancel() }).click();
    expect(mockPut).not.toHaveBeenCalled();

    await allowBtn("abc.ngrok.io").click();
    await page.getByRole("button", { name: m.egress_blocked_confirm_anyway() }).click();
    expect(mockPut).toHaveBeenCalledWith(repo, { egressExtraHosts: ["abc.ngrok.io"] });
  });

  it("stays hidden when the first load fails", async () => {
    mockBlocks.mockRejectedValue(new Error("offline"));
    render(EgressBlockedHosts, { repoPath: repo });
    await expect.poll(() => mockBlocks.mock.calls.length).toBeGreaterThan(0);
    expect(document.querySelector('[data-field="egressBlockedHosts"]')).toBeNull();
  });

  it("keeps the list and notes a failed reload", async () => {
    mockBlocks.mockImplementation(async () => {
      if (mockPut.mock.calls.length) throw new Error("offline");
      return { hosts: [block("api.example.com")] };
    });
    mockPut.mockRejectedValue(new Error("down"));
    render(EgressBlockedHosts, { repoPath: repo });
    await allowBtn("api.example.com").click();
    await page.getByRole("button", { name: m.egress_blocked_confirm_allow() }).click();
    // the optimistic write reloads (and fails), then the write itself fails and reverts
    await expect.element(page.getByText(m.egress_blocked_load_failed())).toBeVisible();
    await expect.element(allowBtn("api.example.com")).toBeVisible();
  });

  it("Mute everywhere appends to the stored muted list and drops the row", async () => {
    vi.mocked(getSettings).mockResolvedValue({ egressMutedHosts: ["ph.varlock.dev"] } as never);
    const mute = vi.mocked(putEgressMutedHosts);
    mute.mockReset();
    mute.mockResolvedValue({} as never);
    mockBlocks.mockResolvedValue({ hosts: [block("telemetry.example.com")] });
    render(EgressBlockedHosts, { repoPath: repo });

    await page
      .getByRole("button", { name: m.egress_blocked_mute_host({ host: "telemetry.example.com" }) })
      .click();
    expect(mute).toHaveBeenCalledWith(["ph.varlock.dev", "telemetry.example.com"]);
    expect(mockPut).not.toHaveBeenCalled();
    await expect.element(page.getByText("telemetry.example.com")).not.toBeInTheDocument();
  });
});
