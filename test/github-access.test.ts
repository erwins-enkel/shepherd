import { test, expect } from "bun:test";
import {
  githubSlugFromUrl,
  gitHelperKind,
  gitCredentialHelper,
  diagnoseGithubAccess,
  setupGitViaGh,
  type CmdRunner,
} from "../src/github-access";

/** An execFile-shaped rejection: `code` is the exit status (or "ENOENT"), stderr the text. */
function execError(code: string | number, stderr = ""): Error {
  return Object.assign(new Error(`exit ${code}`), { code, stderr });
}

// ── githubSlugFromUrl ─────────────────────────────────────────────────────────

test("githubSlugFromUrl: https clone URL with and without .git", () => {
  expect(githubSlugFromUrl("https://github.com/acme/widget.git")).toEqual({
    slug: "acme/widget",
    protocol: "https",
  });
  expect(githubSlugFromUrl("https://github.com/acme/widget")).toEqual({
    slug: "acme/widget",
    protocol: "https",
  });
  expect(githubSlugFromUrl("https://github.com/acme/widget/")).toEqual({
    slug: "acme/widget",
    protocol: "https",
  });
});

test("githubSlugFromUrl: https URL carrying userinfo still resolves", () => {
  expect(githubSlugFromUrl("https://me@github.com/acme/widget.git")?.slug).toBe("acme/widget");
});

test("githubSlugFromUrl: scp-style and ssh:// URLs are ssh", () => {
  expect(githubSlugFromUrl("git@github.com:acme/widget.git")).toEqual({
    slug: "acme/widget",
    protocol: "ssh",
  });
  expect(githubSlugFromUrl("ssh://git@github.com/acme/widget")).toEqual({
    slug: "acme/widget",
    protocol: "ssh",
  });
});

test("githubSlugFromUrl: other hosts, deeper paths and junk → null", () => {
  expect(githubSlugFromUrl("https://gitlab.com/acme/widget.git")).toBeNull();
  expect(githubSlugFromUrl("https://github.com.evil.example/acme/widget")).toBeNull();
  expect(githubSlugFromUrl("https://github.com/acme/widget/tree/main")).toBeNull();
  expect(githubSlugFromUrl("https://github.com/acme")).toBeNull();
  expect(githubSlugFromUrl("/home/me/projects/widget")).toBeNull();
  expect(githubSlugFromUrl("")).toBeNull();
});

// ── gitHelperKind ─────────────────────────────────────────────────────────────

test("gitHelperKind: classifies the common helpers", () => {
  expect(gitHelperKind("!/usr/bin/gh auth git-credential")).toBe("gh");
  expect(gitHelperKind("!gh auth git-credential")).toBe("gh");
  expect(gitHelperKind("store")).toBe("store");
  expect(gitHelperKind("store --file ~/.my-credentials")).toBe("store");
  expect(gitHelperKind("cache --timeout=3600")).toBe("cache");
  expect(gitHelperKind("osxkeychain")).toBe("osxkeychain");
  expect(gitHelperKind("manager")).toBe("manager");
  expect(gitHelperKind("manager-core")).toBe("manager");
  expect(gitHelperKind("/usr/lib/git-core/git-credential-libsecret")).toBe("libsecret");
  expect(gitHelperKind(null)).toBe("none");
  expect(gitHelperKind("")).toBe("none");
});

test("gitHelperKind: an inline script is 'other' — its text is never echoed back", () => {
  expect(gitHelperKind('!f() { echo "password=s3cret"; }; f')).toBe("other");
});

// ── gitCredentialHelper ───────────────────────────────────────────────────────

test("gitCredentialHelper: asks git for the helper that applies to github.com", async () => {
  const calls: string[][] = [];
  const git: CmdRunner = async (args) => {
    calls.push(args);
    return "store\n";
  };
  expect(await gitCredentialHelper(git)).toEqual({ kind: "store", usesGh: false });
  expect(calls).toEqual([["config", "--get-urlmatch", "credential.helper", "https://github.com"]]);
});

test("gitCredentialHelper: gh helper → usesGh", async () => {
  const git: CmdRunner = async () => "!/usr/bin/gh auth git-credential\n";
  expect(await gitCredentialHelper(git)).toEqual({ kind: "gh", usesGh: true });
});

test("gitCredentialHelper: no helper configured (git exits 1) → none", async () => {
  const git: CmdRunner = async () => {
    throw execError(1);
  };
  expect(await gitCredentialHelper(git)).toEqual({ kind: "none", usesGh: false });
});

// ── diagnoseGithubAccess ──────────────────────────────────────────────────────

const storeGit: CmdRunner = async () => "store\n";

test("diagnoseGithubAccess: gh logged in and can read + push", async () => {
  const gh: CmdRunner = async (args) => {
    if (args[1] === "user") return "octocat\n";
    expect(args.slice(0, 2)).toEqual(["api", "repos/acme/widget"]);
    return JSON.stringify({ admin: false, maintain: false, push: true, triage: true, pull: true });
  };
  expect(await diagnoseGithubAccess("acme/widget", { gh, git: storeGit })).toEqual({
    repo: "acme/widget",
    git: { kind: "store", usesGh: false },
    gh: { state: "ok", login: "octocat", pull: true, push: true },
  });
});

test("diagnoseGithubAccess: gh logged in but the repo is invisible (404) → pull false", async () => {
  const gh: CmdRunner = async (args) => {
    if (args[1] === "user") return "octocat\n";
    throw execError(1, "gh: Not Found (HTTP 404)");
  };
  const r = await diagnoseGithubAccess("acme/secret", { gh, git: storeGit });
  expect(r.gh).toEqual({ state: "ok", login: "octocat", pull: false, push: false });
});

test("diagnoseGithubAccess: an org's SSO wall (403) also counts as no access", async () => {
  const gh: CmdRunner = async (args) => {
    if (args[1] === "user") return "octocat\n";
    throw execError(1, "gh: Resource protected by organization SAML enforcement (HTTP 403)");
  };
  const r = await diagnoseGithubAccess("acme/secret", { gh, git: storeGit });
  expect(r.gh).toEqual({ state: "ok", login: "octocat", pull: false, push: false });
});

test("diagnoseGithubAccess: gh not installed → missing", async () => {
  const gh: CmdRunner = async () => {
    throw execError("ENOENT");
  };
  const r = await diagnoseGithubAccess("acme/widget", { gh, git: storeGit });
  expect(r.gh).toEqual({ state: "missing" });
});

test("diagnoseGithubAccess: gh installed but logged out (exit 4) → logged_out", async () => {
  const gh: CmdRunner = async () => {
    throw execError(4, "To get started with GitHub CLI, please run:  gh auth login");
  };
  const r = await diagnoseGithubAccess("acme/widget", { gh, git: storeGit });
  expect(r.gh).toEqual({ state: "logged_out" });
});

test("diagnoseGithubAccess: any other gh failure → error with a redacted detail", async () => {
  const gh: CmdRunner = async (args) => {
    if (args[1] === "user") return "octocat\n";
    throw execError(
      1,
      "dial tcp: lookup api.github.com: no such host ghp_abcdefghijklmnopqrstuvwxyz",
    );
  };
  const r = await diagnoseGithubAccess("acme/widget", { gh, git: storeGit });
  expect(r.gh.state).toBe("error");
  expect(r.gh.state === "error" && r.gh.detail).toContain("no such host");
  expect(JSON.stringify(r)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
});

// ── setupGitViaGh ─────────────────────────────────────────────────────────────

test("setupGitViaGh: runs `gh auth setup-git`, then reports the new helper", async () => {
  const ghCalls: string[][] = [];
  let configured = false;
  const gh: CmdRunner = async (args) => {
    ghCalls.push(args);
    configured = true;
    return "";
  };
  const git: CmdRunner = async () =>
    configured ? "!/usr/bin/gh auth git-credential\n" : "store\n";
  expect(await setupGitViaGh({ gh, git })).toEqual({ ok: true, git: { kind: "gh", usesGh: true } });
  expect(ghCalls).toEqual([["auth", "setup-git"]]);
});

test("setupGitViaGh: gh logged out → logged_out", async () => {
  const gh: CmdRunner = async () => {
    throw execError(4, "You are not logged into any GitHub hosts. To log in, run: gh auth login");
  };
  expect(await setupGitViaGh({ gh, git: storeGit })).toEqual({ ok: false, error: "logged_out" });
});

test("setupGitViaGh: gh missing → missing", async () => {
  const gh: CmdRunner = async () => {
    throw execError("ENOENT");
  };
  expect(await setupGitViaGh({ gh, git: storeGit })).toEqual({ ok: false, error: "missing" });
});

test("setupGitViaGh: setup-git succeeded but git still doesn't use gh → failed", async () => {
  const gh: CmdRunner = async () => "";
  expect(await setupGitViaGh({ gh, git: storeGit })).toEqual({ ok: false, error: "failed" });
});
