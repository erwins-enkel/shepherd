import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../../app.css";
import { getPostgresRepos, putRepoConfig } from "#lib/api.js";
import { repoConfig } from "#lib/reviews.svelte.js";
import { repos } from "#lib/repos.svelte.js";
import type { RepoEntry } from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";
import SettingsPostgresRepos from "./SettingsPostgresRepos.svelte";

vi.mock("#lib/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#lib/api.js")>()),
  getPostgresRepos: vi.fn(),
  putRepoConfig: vi.fn(),
}));

const mockList = vi.mocked(getPostgresRepos);
const mockPut = vi.mocked(putRepoConfig);

// repoConfig is a module singleton, so every test uses its own repo paths.
let n = 0;
let root = "";
const entry = (name: string, extra: Partial<RepoEntry> = {}): RepoEntry => ({
  name,
  path: `${root}/${name}`,
  realPath: `${root}/${name}`,
  display: `~/work/${name}`,
  ...extra,
});

const combo = () => page.getByRole("combobox", { name: m.postgres_repos_add() });
const removeBtn = (repo: string) =>
  page.getByRole("button", { name: m.postgres_repos_remove_aria({ repo }), exact: true });
const option = (name: string) => page.getByRole("option", { name, exact: true });

beforeEach(() => {
  root = `/repo/postgres-picker-${++n}`;
  mockList.mockReset();
  mockPut.mockReset();
  mockList.mockResolvedValue({ repos: [] });
  mockPut.mockImplementation(
    async (_repo, patch) => ({ postgresMode: patch.postgresMode ?? "off" }) as never,
  );
});

afterEach(() => {
  repos.entries = [];
  document.body.innerHTML = "";
});

it("lists the fetched repos by name, including one no longer in the repo list", async () => {
  repos.entries = [entry("web")];
  mockList.mockResolvedValue({
    repos: [
      { repoPath: `${root}/web`, name: "web", mode: "on-request" },
      { repoPath: `${root}/gone`, name: "gone", mode: "on-request" },
    ],
  });
  render(SettingsPostgresRepos, { globalEnabled: true });
  await expect.element(removeBtn("web")).toBeVisible();
  await expect.element(removeBtn("gone")).toBeVisible();
  const names = [...document.querySelectorAll<HTMLElement>("[data-repo]")].map(
    (el) => el.dataset.repo,
  );
  expect(names).toEqual(["gone", "web"]);
  expect(page.getByText(m.postgres_repos_global_off()).query()).toBeNull();
});

it("shows the empty state when no repo has Postgres", async () => {
  repos.entries = [entry("web")];
  render(SettingsPostgresRepos, { globalEnabled: true });
  await expect.element(page.getByText(m.postgres_repos_none())).toBeVisible();
});

it("adds the active option with Enter, clears the field and keeps focus", async () => {
  repos.entries = [entry("api"), entry("apps"), entry("web")];
  render(SettingsPostgresRepos, { globalEnabled: true });
  await combo().fill("ap");
  await expect.element(option("api")).toBeVisible();
  await expect.element(option("apps")).toBeVisible();
  expect(option("web").query()).toBeNull();
  await userEvent.keyboard("{ArrowDown}{Enter}");
  expect(mockPut).toHaveBeenCalledWith(`${root}/apps`, { postgresMode: "on-request" });
  await expect.element(removeBtn("apps")).toBeVisible();
  await expect.element(combo()).toHaveValue("");
  expect(document.activeElement).toBe(combo().element());
});

it("adds an option on click", async () => {
  repos.entries = [entry("api"), entry("web")];
  render(SettingsPostgresRepos, { globalEnabled: true });
  await combo().fill("web");
  await option("web").click();
  expect(mockPut).toHaveBeenCalledWith(`${root}/web`, { postgresMode: "on-request" });
  await expect.element(removeBtn("web")).toBeVisible();
  await expect.element(combo()).toHaveValue("");
  expect(page.getByRole("listbox").query()).toBeNull();
});

it("✕ turns Postgres off and drops the row", async () => {
  repos.entries = [entry("web")];
  mockList.mockResolvedValue({
    repos: [{ repoPath: `${root}/web`, name: "web", mode: "on-request" }],
  });
  render(SettingsPostgresRepos, { globalEnabled: true });
  await removeBtn("web").click();
  expect(mockPut).toHaveBeenCalledWith(`${root}/web`, { postgresMode: "off" });
  await expect.element(removeBtn("web")).not.toBeInTheDocument();
  await expect.element(page.getByText(m.postgres_repos_none())).toBeVisible();
});

it("a failed save restores the row and says so", async () => {
  repos.entries = [entry("api"), entry("web")];
  mockList.mockResolvedValue({
    repos: [{ repoPath: `${root}/web`, name: "web", mode: "on-request" }],
  });
  mockPut.mockRejectedValue(new Error("500"));
  render(SettingsPostgresRepos, { globalEnabled: true });

  await removeBtn("web").click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent(m.postgres_repos_save_failed({ repo: "web" }));
  await expect.element(removeBtn("web")).toBeVisible();

  await combo().fill("api");
  await option("api").click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent(m.postgres_repos_save_failed({ repo: "api" }));
  await expect.element(removeBtn("api")).not.toBeInTheDocument();

  mockPut.mockImplementation(async (_repo, patch) => patch as never);
  await combo().fill("api");
  await option("api").click();
  await expect.element(removeBtn("api")).toBeVisible();
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
});

it("stays editable with the global switch off and says when listed repos get Postgres", async () => {
  repos.entries = [entry("web")];
  render(SettingsPostgresRepos, { globalEnabled: false });
  await expect.element(page.getByText(m.postgres_repos_global_off())).toBeVisible();
  await expect.element(combo()).toBeEnabled();
  await combo().fill("web");
  await option("web").click();
  expect(mockPut).toHaveBeenCalledWith(`${root}/web`, { postgresMode: "on-request" });
});

it("follows the repo-config store, e.g. the Repo settings toggle", async () => {
  repos.entries = [entry("api"), entry("web")];
  mockList.mockResolvedValue({
    repos: [{ repoPath: `${root}/web`, name: "web", mode: "on-request" }],
  });
  render(SettingsPostgresRepos, { globalEnabled: true });
  await expect.element(removeBtn("web")).toBeVisible();
  repoConfig.overlay(`${root}/api`, { postgresMode: "on-request" });
  repoConfig.overlay(`${root}/web`, { postgresMode: "off" });
  await expect.element(removeBtn("api")).toBeVisible();
  await expect.element(removeBtn("web")).not.toBeInTheDocument();
});

it("offers a hidden repo but not one that already has Postgres", async () => {
  repos.entries = [entry("web-old", { hidden: true }), entry("web")];
  mockList.mockResolvedValue({
    repos: [{ repoPath: `${root}/web`, name: "web", mode: "on-request" }],
  });
  render(SettingsPostgresRepos, { globalEnabled: true });
  await expect.element(removeBtn("web")).toBeVisible();
  await combo().fill("web");
  await expect.element(option("web-old")).toBeVisible();
  expect(option("web").query()).toBeNull();
});

it("still lets the operator add a repo when the list fails to load", async () => {
  repos.entries = [entry("web")];
  mockList.mockRejectedValue(new Error("offline"));
  render(SettingsPostgresRepos, { globalEnabled: true });
  await expect.element(page.getByText(m.postgres_repos_load_failed())).toBeVisible();
  expect(page.getByText(m.postgres_repos_none()).query()).toBeNull();
  await combo().fill("web");
  await option("web").click();
  await expect.element(removeBtn("web")).toBeVisible();
});

// #4238: an auto repo (a database at every spawn) is listed with its tag; the store's mode wins.
it("tags an auto repo, following the store's mode over the fetched one", async () => {
  repos.entries = [entry("api"), entry("web")];
  mockList.mockResolvedValue({
    repos: [
      { repoPath: `${root}/api`, name: "api", mode: "on-request" },
      { repoPath: `${root}/web`, name: "web", mode: "auto" },
    ],
  });
  render(SettingsPostgresRepos, { globalEnabled: true });
  const tagIn = (repo: string) =>
    document
      .querySelector(`[data-repo="${repo}"]`)
      ?.textContent?.includes(m.postgres_repos_auto_tag());
  await expect.element(removeBtn("web")).toBeVisible();
  await expect.element(removeBtn("api")).toBeVisible();
  expect(tagIn("web")).toBe(true);
  expect(tagIn("api")).toBe(false);

  repoConfig.overlay(`${root}/api`, { postgresMode: "auto" });
  repoConfig.overlay(`${root}/web`, { postgresMode: "on-request" });
  await expect.poll(() => tagIn("api")).toBe(true);
  expect(tagIn("web")).toBe(false);
  await expect.element(removeBtn("web")).toBeVisible();
});
