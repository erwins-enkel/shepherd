import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import { repoConfig } from "$lib/reviews.svelte";
import { m } from "$lib/paraglide/messages";
import { getRepoCollaborators, getRepoRoles, putRepoRoles } from "$lib/api";
import "../../../app.css";

vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return {
    ...actual,
    getRepoCollaborators: vi.fn(),
    getRepoRoles: vi.fn(),
    putRepoRoles: vi.fn(),
  };
});

const { default: AutomationRepoFields } = await import("./AutomationRepoFields.svelte");
const mockCollaborators = vi.mocked(getRepoCollaborators);
const mockRoles = vi.mocked(getRepoRoles);
const mockPutRoles = vi.mocked(putRepoRoles);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const roleResult = (reviewer: string | null, merger: string | null, me = "Owner") => ({
  roles: { reviewer, merger },
  me,
});

const peopleResult = (logins: string[], overrides: Record<string, unknown> = {}) =>
  ({
    logins,
    me: "Owner",
    collaboratorsUnavailable: false,
    source: "collaborators",
    repoSlug: "team/repo",
    isFork: false,
    ...overrides,
  }) as never;

const reviewer = () => page.getByRole("combobox", { name: m.roles_reviewer_label() });
const merger = () => page.getByRole("combobox", { name: m.roles_merger_label() });

beforeEach(() => {
  mockRoles.mockReset();
  mockCollaborators.mockReset();
  mockPutRoles.mockReset();
  mockRoles.mockResolvedValue(roleResult(null, null));
  mockCollaborators.mockResolvedValue(peopleResult([]));
  mockPutRoles.mockResolvedValue(roleResult(null, null));
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("AutomationRepoFields repository roles", () => {
  it("loads stored roles independently and keeps dropdowns usable when people fail", async () => {
    const pendingRoles = deferred<ReturnType<typeof roleResult>>();
    const pendingPeople = deferred<never>();
    mockRoles.mockReturnValue(pendingRoles.promise);
    mockCollaborators.mockReturnValue(pendingPeople.promise);
    render(AutomationRepoFields, { repoPath: "/repo/a", fableAvailable: false });

    await expect.element(reviewer()).toBeDisabled();
    await expect.element(merger()).toBeDisabled();

    pendingRoles.resolve(roleResult("KaI", "LegacyMaintainer"));
    await expect.element(reviewer()).toBeEnabled();
    await expect.element(reviewer()).toHaveValue("KaI");
    await expect.element(merger()).toHaveValue("LegacyMaintainer");

    pendingPeople.resolve(peopleResult([], { collaboratorsUnavailable: true, source: undefined }));
    await expect.element(page.getByRole("button", { name: m.common_retry() })).toBeVisible();
    expect(document.querySelectorAll("#repo-roles ~ .auto-row select")).toHaveLength(2);
    expect(document.querySelector("#repo-roles ~ .auto-row input")).toBeNull();
  });

  it("retries whichever independent loads failed and restores both saved roles and people", async () => {
    mockRoles
      .mockRejectedValueOnce(new Error("roles offline"))
      .mockResolvedValueOnce(roleResult("ReviewerOne", "MergerOne"));
    mockCollaborators
      .mockRejectedValueOnce(new Error("people offline"))
      .mockResolvedValueOnce(peopleResult(["ReviewerOne", "MergerOne", "AnotherPerson"]));
    render(AutomationRepoFields, { repoPath: "/repo/a", fableAvailable: false });

    await page.getByRole("button", { name: m.common_retry() }).click();

    await expect.element(reviewer()).toHaveValue("ReviewerOne");
    await expect.element(merger()).toHaveValue("MergerOne");
    await expect
      .element(reviewer().getByRole("option", { name: "@AnotherPerson" }))
      .toBeInTheDocument();
    expect(page.getByRole("button", { name: m.common_retry() }).query()).toBeNull();
  });

  it("keeps an out-of-list stored login and disables both role controls while saving", async () => {
    mockRoles.mockResolvedValue(roleResult("LegacyCase", null));
    mockCollaborators.mockResolvedValue(peopleResult(["kai", "Alice"], { me: "ME" }));
    const save = deferred<ReturnType<typeof roleResult>>();
    mockPutRoles.mockReturnValue(save.promise);
    render(AutomationRepoFields, { repoPath: "/repo/a", fableAvailable: false });

    await expect.element(reviewer()).toHaveValue("LegacyCase");
    await expect
      .element(reviewer().getByRole("option", { name: "@LegacyCase" }))
      .toBeInTheDocument();
    await reviewer().selectOptions("Alice");
    await expect.element(reviewer()).toBeDisabled();
    await expect.element(merger()).toBeDisabled();

    save.resolve(roleResult("Alice", null, "ME"));
    await expect.element(reviewer()).toBeEnabled();
    await expect.element(reviewer()).toHaveValue("Alice");
    await expect.element(merger()).toHaveValue("");
  });

  it("ignores stale loads across an A to B to A repository switch", async () => {
    const aOldRoles = deferred<ReturnType<typeof roleResult>>();
    const bRoles = deferred<ReturnType<typeof roleResult>>();
    const aFreshRoles = deferred<ReturnType<typeof roleResult>>();
    const aOldPeople = deferred<never>();
    const bPeople = deferred<never>();
    const aFreshPeople = deferred<never>();
    mockRoles
      .mockReturnValueOnce(aOldRoles.promise)
      .mockReturnValueOnce(bRoles.promise)
      .mockReturnValueOnce(aFreshRoles.promise);
    mockCollaborators
      .mockReturnValueOnce(aOldPeople.promise)
      .mockReturnValueOnce(bPeople.promise)
      .mockReturnValueOnce(aFreshPeople.promise);

    const screen = await render(AutomationRepoFields, {
      repoPath: "/repo/a",
      fableAvailable: false,
    });
    await vi.waitFor(() => expect(mockRoles.mock.calls.length).toBe(1));
    await screen.rerender({ repoPath: "/repo/b", fableAvailable: false });
    await vi.waitFor(() => expect(mockRoles.mock.calls.length).toBe(2));
    await screen.rerender({ repoPath: "/repo/a", fableAvailable: false });
    await vi.waitFor(() => expect(mockRoles.mock.calls.length).toBe(3));

    aFreshRoles.resolve(roleResult("FreshA", null));
    aFreshPeople.resolve(peopleResult(["FreshA", "FreshCandidate"]));
    await expect.element(reviewer()).toHaveValue("FreshA");

    aOldRoles.resolve(roleResult("StaleA", "StaleMerger"));
    aOldPeople.resolve(peopleResult(["StaleA", "StaleCandidate"]));
    bRoles.resolve(roleResult("StaleB", "StaleBMerger"));
    bPeople.resolve(peopleResult(["StaleB", "StaleBCandidate"]));

    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect.element(reviewer()).toHaveValue("FreshA");
    expect(reviewer().getByRole("option", { name: "@StaleCandidate" }).query()).toBeNull();
    await expect
      .element(reviewer().getByRole("option", { name: "@FreshCandidate" }))
      .toBeInTheDocument();
  });

  it("ignores a stale save after switching A to B to A", async () => {
    mockRoles
      .mockResolvedValueOnce(roleResult("InitialA", null))
      .mockResolvedValueOnce(roleResult("CurrentB", null))
      .mockResolvedValueOnce(roleResult("FreshA", null));
    const save = deferred<ReturnType<typeof roleResult>>();
    mockPutRoles.mockReturnValue(save.promise);

    const screen = await render(AutomationRepoFields, {
      repoPath: "/repo/a",
      fableAvailable: false,
    });
    await expect.element(reviewer()).toHaveValue("InitialA");
    await reviewer().selectOptions("Owner");
    await expect.element(reviewer()).toBeDisabled();

    await screen.rerender({ repoPath: "/repo/b", fableAvailable: false });
    await expect.element(reviewer()).toHaveValue("CurrentB");
    await screen.rerender({ repoPath: "/repo/a", fableAvailable: false });
    await expect.element(reviewer()).toHaveValue("FreshA");

    save.resolve(roleResult("StaleSavedA", "StaleSavedMerger"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect.element(reviewer()).toHaveValue("FreshA");
  });

  it("explains assignee fallback and names the upstream repository for forks", async () => {
    mockCollaborators.mockResolvedValue(
      peopleResult(["UpstreamMaintainer"], {
        source: "assignees",
        repoSlug: "upstream/project",
        isFork: true,
      }),
    );
    render(AutomationRepoFields, { repoPath: "/repo/fork", fableAvailable: false });

    await expect
      .element(reviewer().getByRole("option", { name: "@UpstreamMaintainer" }))
      .toBeInTheDocument();
    await expect.element(page.getByText("upstream/project", { exact: false })).toBeVisible();
    await expect.element(page.getByText(m.roles_assignees_hint())).toBeVisible();
  });
});

it("saves ultra as a shared repository effort preference", async () => {
  const save = vi.spyOn(repoConfig, "setDefaultEffort").mockResolvedValue(undefined);
  try {
    render(AutomationRepoFields, { repoPath: "/repo/ultra", fableAvailable: false });
    await page
      .getByRole("combobox", { name: m.automation_default_effort_label() })
      .selectOptions("ultra");
    expect(save).toHaveBeenCalledWith("/repo/ultra", "ultra");
  } finally {
    save.mockRestore();
  }
});
