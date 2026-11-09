import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import GithubActionsUsage from "./GithubActionsUsage.svelte";
import { m } from "#lib/paraglide/messages.js";
import type { ActionsAccountBilling, GithubActionsBilling } from "#lib/types.js";
import { getGithubActionsBilling } from "#lib/api.js";

vi.mock("#lib/api.js", () => ({ getGithubActionsBilling: vi.fn() }));

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 8, 21);
const RESET = Date.UTC(2026, 11, 1);

function account(over: Partial<ActionsAccountBilling>): ActionsAccountBilling {
  return {
    login: "acme",
    kind: "org",
    status: "ok",
    plan: "free",
    includedUsd: 12,
    budget: { amountUsd: 0, stops: true },
    usedUsd: 0,
    paidUsd: 0,
    stopAtUsd: 12,
    projection: { monthEndUsd: 0, includedOutAt: null, stopAt: null },
    runners: [],
    topRepos: [],
    publicMinutes: 0,
    publicGrossUsd: 0,
    topPublicRepo: null,
    ...over,
  };
}

const risky = account({
  login: "erwins-enkel",
  plan: "enterprise",
  includedUsd: 300,
  budget: { amountUsd: 55, stops: true },
  usedUsd: 124.17,
  stopAtUsd: 355,
  projection: { monthEndUsd: 471, includedOutAt: NOW + 11 * DAY, stopAt: NOW + 14.7 * DAY },
  runners: [
    { os: "macos", minutes: 994, grossUsd: 61.63 },
    { os: "linux", minutes: 9771, grossUsd: 58.63 },
  ],
  topRepos: [{ repo: "kronisto", minutes: 1301, grossUsd: 63.25 }],
  publicMinutes: 23558,
  publicGrossUsd: 654.7,
  topPublicRepo: { repo: "shepherd", minutes: 23328 },
});

function billing(accounts: ActionsAccountBilling[]): GithubActionsBilling {
  return {
    fetchedAt: NOW - 15 * 60_000,
    periodStart: Date.UTC(2026, 10, 1),
    resetAt: RESET,
    accounts,
  };
}

beforeEach(() => vi.resetAllMocks());

it("leads with the account whose forecast runs into a stop, its cost drivers open", async () => {
  vi.mocked(getGithubActionsBilling).mockResolvedValue(
    billing([
      account({ login: "kai-osthoff", kind: "user", plan: null, status: "missing-scope" }),
      account({ login: "quiet-org" }),
      risky,
    ]),
  );
  render(GithubActionsUsage, { nowMs: NOW });

  const rows = page.getByRole("region", { name: m.topbar_gha_title() });
  await expect.element(rows).toBeVisible();
  const logins = [...document.querySelectorAll<HTMLElement>(".gha-account")].map(
    (el) => el.dataset.login,
  );
  expect(logins).toEqual(["erwins-enkel", "kai-osthoff", "quiet-org"]);

  const toggle = page.getByRole("button", { name: "erwins-enkel" });
  await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
  await expect.element(page.getByText("kronisto")).toBeVisible();
  await expect
    .element(page.getByText(m.topbar_gha_costly_runner({ os: "macOS", minutes: 9, cost: 51 })))
    .toBeVisible();

  await toggle.click();
  await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
  await expect.element(page.getByText("kronisto")).not.toBeInTheDocument();
});

it("tells the personal account how to grant the missing scope", async () => {
  vi.mocked(getGithubActionsBilling).mockResolvedValue(
    billing([account({ login: "kai-osthoff", kind: "user", plan: null, status: "missing-scope" })]),
  );
  render(GithubActionsUsage, { nowMs: NOW });
  await expect.element(page.getByText(m.topbar_gha_missing_scope())).toBeVisible();
  await expect.element(page.getByText("gh auth refresh -h github.com -s user")).toBeVisible();
  await expect.element(page.getByRole("button", { name: m.topbar_gha_copy() })).toBeVisible();
});

it("names an org without billing rights instead of showing a zero", async () => {
  vi.mocked(getGithubActionsBilling).mockResolvedValue(
    billing([account({ login: "partner", status: "no-access", plan: null })]),
  );
  render(GithubActionsUsage, { nowMs: NOW });
  await expect.element(page.getByText(m.topbar_gha_no_access())).toBeVisible();
});

it("says when billing can't be loaded", async () => {
  vi.mocked(getGithubActionsBilling).mockRejectedValue(new Error("502"));
  render(GithubActionsUsage, { nowMs: NOW });
  await expect.element(page.getByText(m.topbar_gha_load_failed())).toBeVisible();
});

it("stays out of the panel when there is no GitHub account to show", async () => {
  vi.mocked(getGithubActionsBilling).mockResolvedValue(billing([]));
  render(GithubActionsUsage, { nowMs: NOW });
  await vi.waitFor(() => expect(getGithubActionsBilling).toHaveBeenCalled());
  await expect.poll(() => document.querySelector(".gha")).toBeNull();
});
