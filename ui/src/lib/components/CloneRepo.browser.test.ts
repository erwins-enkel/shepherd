import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import CloneRepo from "./CloneRepo.svelte";
import {
  CloneFailedError,
  type GithubAccess,
  type GithubRepo,
  type GithubReposResult,
  type GitHelperInfo,
} from "#lib/api.js";
import type { RepoEntry } from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";

const getGithubRepos = vi.fn<() => Promise<GithubReposResult>>();
const cloneRepo = vi.fn<(url: string) => Promise<RepoEntry>>();
const getGithubAccess = vi.fn<(url: string) => Promise<GithubAccess>>();
const setupGitViaGh = vi.fn<() => Promise<GitHelperInfo>>();

vi.mock("#lib/api.js", async (orig) => ({
  ...((await orig()) as object),
  getGithubRepos: () => getGithubRepos(),
  cloneRepo: (url: string) => cloneRepo(url),
  getGithubAccess: (url: string) => getGithubAccess(url),
  setupGitViaGh: () => setupGitViaGh(),
}));

function repo(nameWithOwner: string, isPrivate = false): GithubRepo {
  const [owner, name] = nameWithOwner.split("/");
  return {
    nameWithOwner,
    owner,
    name,
    url: `https://github.com/${nameWithOwner}.git`,
    isPrivate,
    isFork: false,
    isArchived: false,
    pushedAt: null,
    cloned: false,
  };
}

const STORE: GitHelperInfo = { kind: "store", usesGh: false };

function listing(repos: GithubRepo[], git: GitHelperInfo = STORE): GithubReposResult {
  return { repos, login: "octocat", available: true, git };
}

function refused(detail = "remote: Write access to repository not granted.") {
  return new CloneFailedError(422, "clonerepo_failed_auth", detail, true);
}

function access(gh: GithubAccess["gh"], extra: Partial<GithubAccess> = {}): GithubAccess {
  return { repo: "acme/calendar", protocol: "https", git: STORE, gh, ...extra };
}

const GH_CAN_READ: GithubAccess["gh"] = { state: "ok", login: "octocat", pull: true, push: true };

const entry: RepoEntry = {
  name: "calendar",
  path: "/r/calendar",
  display: "~/r/calendar",
  realPath: "/r/calendar",
};

beforeEach(() => {
  vi.resetAllMocks();
  try {
    localStorage.clear();
  } catch {
    /* no storage in this context */
  }
});

const button = (name: string) => page.getByRole("button", { name, exact: true });
/** A list row — its accessible name also carries the private-repo lock glyph. */
const repoRow = (name: string) => page.getByRole("button", { name: new RegExp(`^${name}\\b`) });

describe("CloneRepo", () => {
  it("lists each owner's repos alphabetically, not in the server's most-recently-pushed order", async () => {
    // Server order is by push recency — deliberately un-alphabetical, and interleaved
    // across owners so grouping and sorting are both exercised.
    getGithubRepos.mockResolvedValue({
      repos: [repo("me/zeta"), repo("acme/widget"), repo("me/alpha"), repo("acme/anvil")],
      login: "me",
      available: true,
    });

    render(CloneRepo, { props: { ondone: vi.fn() } });

    await expect.element(page.getByRole("button", { name: "alpha" })).toBeVisible();

    const rows = [...document.querySelectorAll(".repolist .repo .rname")].map((e) => e.textContent);
    // Own account first (alphabetical within), then the org (alphabetical within).
    expect(rows).toEqual(["alpha", "zeta", "anvil", "widget"]);
  });

  it("a refused list clone checks gh, then names both credentials and offers the gh fix", async () => {
    getGithubRepos.mockResolvedValue(listing([repo("acme/calendar", true)]));
    cloneRepo.mockRejectedValue(refused());
    let answer!: (a: GithubAccess) => void;
    getGithubAccess.mockReturnValue(new Promise((r) => (answer = r)));

    render(CloneRepo, { props: { ondone: vi.fn() } });
    await repoRow("calendar").click();

    // While gh is being checked: the list collapses to the refused repo.
    await expect.element(page.getByText(m.cloneaccess_checking_title())).toBeVisible();
    expect(getGithubAccess).toHaveBeenCalledWith("https://github.com/acme/calendar.git");
    expect(document.querySelector(".repolist")).toBeNull();
    await expect.element(button(m.cloneaccess_back())).toBeVisible();

    answer(access(GH_CAN_READ));

    await expect.element(page.getByText(m.cloneaccess_mismatch_title())).toBeVisible();
    await expect.element(page.getByText(m.cloneaccess_helper_store())).toBeVisible();
    await expect
      .element(page.getByText(m.cloneaccess_gh_account({ login: "octocat" })))
      .toBeVisible();
    await expect.element(button(m.cloneaccess_fix_gh_action())).toBeVisible();
    await expect.element(page.getByText(m.cloneaccess_fix_token_title())).toBeVisible();
    // The misleading one-liner is gone.
    expect(document.body.textContent).not.toContain(m.clonerepo_failed_auth());
  });

  it("confirming the gh fix shows the exact config, runs setup, then clones again", async () => {
    getGithubRepos.mockResolvedValue(listing([repo("acme/calendar", true)]));
    cloneRepo.mockRejectedValueOnce(refused()).mockResolvedValueOnce(entry);
    getGithubAccess.mockResolvedValue(access(GH_CAN_READ));
    setupGitViaGh.mockResolvedValue({ kind: "gh", usesGh: true });
    const ondone = vi.fn();

    render(CloneRepo, { props: { ondone } });
    await repoRow("calendar").click();
    await button(m.cloneaccess_fix_gh_action()).click();

    await expect.element(page.getByText(m.cloneaccess_confirm_title())).toBeVisible();
    expect(document.body.textContent).toContain("helper = !gh auth git-credential");
    expect(document.body.textContent).toContain(
      "git config --global --unset-all credential.https://github.com.helper",
    );
    expect(setupGitViaGh).not.toHaveBeenCalled();

    await button(m.cloneaccess_confirm_go()).click();

    await vi.waitFor(() => expect(ondone).toHaveBeenCalledWith(entry));
    expect(setupGitViaGh).toHaveBeenCalledTimes(1);
    expect(cloneRepo).toHaveBeenCalledTimes(2);
  });

  it("when gh can't see the repo either, it says so and lists what to check", async () => {
    getGithubRepos.mockResolvedValue(listing([repo("acme/calendar", true)]));
    cloneRepo.mockRejectedValue(refused());
    getGithubAccess.mockResolvedValue(
      access({ state: "ok", login: "octocat", pull: false, push: false }),
    );

    render(CloneRepo, { props: { ondone: vi.fn() } });
    await repoRow("calendar").click();

    await expect.element(page.getByText(m.cloneaccess_denied_title())).toBeVisible();
    await expect.element(page.getByText(m.cloneaccess_check_sso({ owner: "acme" }))).toBeVisible();
    expect(document.body.textContent).not.toContain(m.cloneaccess_fix_gh_action());
  });

  it("when gh is signed out, it offers the token fix and re-checks gh on demand", async () => {
    getGithubRepos.mockResolvedValue(listing([repo("acme/calendar", true)]));
    cloneRepo.mockRejectedValue(refused());
    getGithubAccess
      .mockResolvedValueOnce(access({ state: "logged_out" }))
      .mockResolvedValueOnce(access(GH_CAN_READ));

    render(CloneRepo, { props: { ondone: vi.fn() } });
    await repoRow("calendar").click();

    await expect.element(page.getByText(m.cloneaccess_gh_logged_out())).toBeVisible();
    await expect.element(page.getByText("gh auth login", { exact: true })).toBeVisible();
    await expect.element(page.getByText(m.cloneaccess_fix_token_title())).toBeVisible();

    await button(m.cloneaccess_check_gh()).click();

    await expect.element(button(m.cloneaccess_fix_gh_action())).toBeVisible();
    expect(getGithubAccess).toHaveBeenCalledTimes(2);
  });

  it("shows git's own output under technical details", async () => {
    getGithubRepos.mockResolvedValue(listing([repo("acme/calendar", true)]));
    cloneRepo.mockRejectedValue(refused("fatal: unable to access …: error: 403"));
    getGithubAccess.mockResolvedValue(access(GH_CAN_READ));

    render(CloneRepo, { props: { ondone: vi.fn() } });
    await repoRow("calendar").click();
    await button(m.cloneaccess_details()).click();

    await expect
      .element(page.getByText("git clone: fatal: unable to access …: error: 403"))
      .toBeVisible();
  });

  it("warns up front when git doesn't clone through gh, until dismissed", async () => {
    getGithubRepos.mockResolvedValue(listing([repo("acme/calendar")]));

    render(CloneRepo, { props: { ondone: vi.fn() } });

    await expect.element(page.getByText(m.cloneaccess_note_title())).toBeVisible();
    await button(m.cloneaccess_note_dismiss()).click();

    await expect.element(page.getByText(m.cloneaccess_note_title())).not.toBeInTheDocument();
    expect(localStorage.getItem("shepherd:clone-git-note-dismissed")).toBe("1");
  });

  it("no up-front note when git already authenticates through gh", async () => {
    getGithubRepos.mockResolvedValue(
      listing([repo("acme/calendar")], { kind: "gh", usesGh: true }),
    );

    render(CloneRepo, { props: { ondone: vi.fn() } });

    await expect.element(repoRow("calendar")).toBeVisible();
    expect(document.body.textContent).not.toContain(m.cloneaccess_note_title());
  });

  it("a refused clone from another host keeps the plain message and never asks gh", async () => {
    getGithubRepos.mockResolvedValue({ repos: [], login: null, available: false });
    cloneRepo.mockRejectedValue(refused());

    render(CloneRepo, { props: { ondone: vi.fn() } });
    await page.getByRole("textbox").fill("https://gitlab.com/acme/calendar.git");
    await button(m.clonerepo_submit()).click();

    await expect.element(page.getByText(m.clonerepo_failed_auth())).toBeVisible();
    expect(getGithubAccess).not.toHaveBeenCalled();
  });
});
