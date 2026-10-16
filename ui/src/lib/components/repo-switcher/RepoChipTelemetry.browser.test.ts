import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import RepoChipTelemetry from "./RepoChipTelemetry.svelte";
import type { DrainStatus } from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";

const api = vi.hoisted(() => ({
  updateEpic: vi.fn(async () => ({})),
  getDrainQueue: vi.fn(async () => []),
}));

vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
  return { ...actual, ...api };
});

function drain(over: Partial<DrainStatus> = {}): DrainStatus {
  return {
    repoPath: "/repos/site",
    enabled: true,
    paused: false,
    reason: null,
    detail: null,
    queued: 1,
    inFlight: 0,
    max: 5,
    epicParent: 42,
    usageCeilingPct: 80,
    usageCeilingIgnored: false,
    ...over,
  };
}

const chip = (d: DrainStatus) => ({
  repoPath: d.repoPath,
  count: 1,
  drain: d,
});

const usageHold = (over: Partial<DrainStatus> = {}) =>
  drain({ paused: true, reason: "usage", detail: "81", ...over });

beforeEach(() => {
  api.updateEpic.mockClear();
});

describe("RepoChipTelemetry usage ceiling override", () => {
  it("an epic held at the usage ceiling offers ignoring it for that epic", async () => {
    render(RepoChipTelemetry, { chip: chip(usageHold()) });

    await expect
      .element(page.getByText(m.drain_paused_usage_ceiling({ pct: "81", ceiling: 80 })))
      .toBeInTheDocument();
    await page.getByRole("button", { name: m.drain_usage_ignore({ epic: 42 }) }).click();
    expect(api.updateEpic).toHaveBeenCalledWith("/repos/site", 42, { ignoreUsageCeiling: true });
  });

  it("no override for a label-mode drain held at the usage ceiling", async () => {
    render(RepoChipTelemetry, { chip: chip(usageHold({ epicParent: null })) });

    await expect
      .element(page.getByText(m.drain_paused_usage_ceiling({ pct: "81", ceiling: 80 })))
      .toBeInTheDocument();
    expect(
      page.getByRole("button", { name: m.drain_usage_ignore({ epic: 42 }) }).query(),
    ).toBeNull();
  });

  it("no override for another pause reason", async () => {
    render(RepoChipTelemetry, { chip: chip(drain({ paused: true, reason: "credits" })) });

    await expect.element(page.getByText(m.drain_paused_credits())).toBeInTheDocument();
    expect(
      page.getByRole("button", { name: m.drain_usage_ignore({ epic: 42 }) }).query(),
    ).toBeNull();
  });

  it("an epic running over the ceiling says so and offers respecting it again", async () => {
    render(RepoChipTelemetry, { chip: chip(drain({ usageCeilingIgnored: true })) });

    await expect.element(page.getByText(m.drain_usage_ignored({ epic: 42 }))).toBeInTheDocument();
    await page.getByRole("button", { name: m.drain_usage_respect() }).click();
    expect(api.updateEpic).toHaveBeenCalledWith("/repos/site", 42, { ignoreUsageCeiling: false });
  });
});
