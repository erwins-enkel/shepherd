import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  listRepos,
  listReposPathForReal,
  readTodo,
  writeTodo,
  cloneRepo,
  classifyCloneError,
  createProject,
  classifyProjectError,
  listGithubOwners,
  listGithubRepos,
  forkRepo,
  classifyForkError,
  type GhRunner,
  type GhOutRunner,
} from "../src/repos";
import { realpathSync } from "node:fs";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "shepherd-repos-test-"));
  mkdirSync(join(root, "alpha"));
  mkdirSync(join(root, "beta"));
  writeFileSync(join(root, "README"), "not a dir");
  mkdirSync(join(root, ".hidden"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

// ── listRepos ─────────────────────────────────────────────────────────────────

test("listRepos returns sorted dirs, excludes file and dotdir", () => {
  const repos = listRepos(root);
  expect(repos.map((r) => r.name)).toEqual(["alpha", "beta"]);
  expect(repos[0]!.path).toBe(join(root, "alpha"));
  expect(repos[1]!.path).toBe(join(root, "beta"));
});

test("listRepos returns [] for nonexistent root", () => {
  expect(listRepos(join(root, "nonexistent"))).toEqual([]);
});

// ── listReposPathForReal (post-merge backlog refresh key reconciliation) ───────

test("listReposPathForReal maps a realpath back to listRepos' join(repoRoot, name) key", () => {
  // A symlinked repoRoot is exactly where the merge path's realpath-resolved dir
  // diverges from the raw join(repoRoot, name) the counts cache + buildBacklogPayload
  // key by. linkRoot → root, so listRepos enumerates under linkRoot while the merge
  // path (safeRepoDir) hands us the real path.
  const linkRoot = join(tmpdir(), `shepherd-repos-link-${process.pid}-${root.split("-").pop()}`);
  symlinkSync(root, linkRoot, "dir");
  try {
    const enumerated = join(linkRoot, "alpha"); // the key listRepos / readers use
    const realDir = realpathSync(enumerated); // what safeRepoDir would yield
    // Precondition: the two forms genuinely diverge under the symlink, so this
    // test would fail if the reconciliation were a no-op.
    expect(realDir).not.toBe(enumerated);

    // The fix: realpath → the enumerated key the readers (and warmer) cache by, so
    // refresh writes the same entry buildBacklogPayload later reads.
    expect(listReposPathForReal(realDir, linkRoot)).toBe(enumerated);
  } finally {
    rmSync(linkRoot, { force: true });
  }
});

test("listReposPathForReal returns the dir unchanged when no enumerated repo matches", () => {
  const outside = join(tmpdir(), "definitely-not-under-repoRoot");
  expect(listReposPathForReal(outside, root)).toBe(outside);
});

// ── readTodo ──────────────────────────────────────────────────────────────────

test("readTodo: no TODO.md → ok:true exists:false content:''", () => {
  const r = readTodo(join(root, "alpha"), root);
  expect(r).toEqual({ ok: true, exists: false, content: "" });
});

test("readTodo: outside repoRoot → ok:false", () => {
  const r = readTodo("/etc", root);
  expect(r.ok).toBe(false);
});

// ── writeTodo + round-trip ────────────────────────────────────────────────────

test("writeTodo writes and readTodo reads back (round-trip)", () => {
  const repoPath = join(root, "alpha");
  const wrote = writeTodo(repoPath, root, "- [ ] x");
  expect(wrote).toBe(true);
  const r = readTodo(repoPath, root);
  expect(r).toEqual({ ok: true, exists: true, content: "- [ ] x" });
});

test("writeTodo: outside repoRoot → false", () => {
  expect(writeTodo("/etc", root, "x")).toBe(false);
});

test("writeTodo: content > 100_000 chars → false", () => {
  expect(writeTodo(join(root, "alpha"), root, "x".repeat(100_001))).toBe(false);
});

test("writeTodo: content exactly 100_000 chars → true", () => {
  expect(writeTodo(join(root, "alpha"), root, "x".repeat(100_000))).toBe(true);
});

// ── symlink containment (security) ─────────────────────────────────────────────

test("a symlink inside repoRoot pointing outside is rejected (realpath containment)", () => {
  const outside = mkdtempSync(join(tmpdir(), "shepherd-outside-"));
  try {
    symlinkSync(outside, join(root, "escape"), "dir");
    // lexically join(root,"escape") looks inside root, but realpath is outside → reject
    expect(readTodo(join(root, "escape"), root).ok).toBe(false);
    expect(writeTodo(join(root, "escape"), root, "pwned")).toBe(false);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

// ── cloneRepo ─────────────────────────────────────────────────────────────────

/** Create a minimal bare git repo so we can clone from a file:// URL. */
function makeBareSrc(parent: string): string {
  const bare = join(parent, "bare-src.git");
  execFileSync("git", ["init", "--bare", bare], { stdio: "pipe" });
  return bare;
}

test("cloneRepo happy path: clones repo, returns entry with correct name/path, dir exists", () => {
  const cloneRoot = mkdtempSync(join(tmpdir(), "shepherd-clone-root-"));
  try {
    const bareSrc = makeBareSrc(cloneRoot);
    const url = `file://${bareSrc}`;
    const result = cloneRepo(url, "my-clone", cloneRoot);
    expect(result.ok).toBe(true);
    if (!result.ok) return; // narrow type
    expect(result.entry.name).toBe("my-clone");
    expect(result.entry.path).toBe(join(cloneRoot, "my-clone"));
    expect(existsSync(result.entry.path)).toBe(true);
  } finally {
    rmSync(cloneRoot, { recursive: true, force: true });
  }
});

test("cloneRepo: returns clonerepo_failed_exists when target dir already exists", () => {
  const cloneRoot = mkdtempSync(join(tmpdir(), "shepherd-clone-root-"));
  try {
    const bareSrc = makeBareSrc(cloneRoot);
    const url = `file://${bareSrc}`;
    // pre-create the target
    mkdirSync(join(cloneRoot, "already-there"));
    const result = cloneRepo(url, "already-there", cloneRoot);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("clonerepo_failed_exists");
  } finally {
    rmSync(cloneRoot, { recursive: true, force: true });
  }
});

test("cloneRepo: returns clonerepo_failed_outside for a name containing '..'", () => {
  const cloneRoot = mkdtempSync(join(tmpdir(), "shepherd-clone-root-"));
  try {
    const bareSrc = makeBareSrc(cloneRoot);
    const url = `file://${bareSrc}`;
    const result = cloneRepo(url, "../escape", cloneRoot);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("clonerepo_failed_outside");
  } finally {
    rmSync(cloneRoot, { recursive: true, force: true });
  }
});

// ── classifyCloneError ────────────────────────────────────────────────────────

test("classifyCloneError: killed+SIGTERM → clonerepo_failed_timeout", () => {
  expect(classifyCloneError({ killed: true, signal: "SIGTERM" })).toBe("clonerepo_failed_timeout");
});

test("classifyCloneError: stderr 'Authentication failed' → clonerepo_failed_auth", () => {
  expect(classifyCloneError({ stderr: Buffer.from("fatal: Authentication failed") })).toBe(
    "clonerepo_failed_auth",
  );
});

test("classifyCloneError: stderr 'destination path … already exists' → clonerepo_failed_exists", () => {
  expect(
    classifyCloneError({
      stderr: Buffer.from(
        "fatal: destination path 'x' already exists and is not an empty directory",
      ),
    }),
  ).toBe("clonerepo_failed_exists");
});

test("classifyCloneError: stderr 'repository not found' → clonerepo_failed_url", () => {
  expect(classifyCloneError({ stderr: Buffer.from("ERROR: Repository not found.") })).toBe(
    "clonerepo_failed_url",
  );
});

test("classifyCloneError: empty error object → clonerepo_failed_url (fallback)", () => {
  expect(classifyCloneError({})).toBe("clonerepo_failed_url");
});

// ── createProject ─────────────────────────────────────────────────────────────

/** Helper: create a temp repoRoot and return path + cleanup fn. */
function makeTempRoot(): { repoRoot: string; cleanup: () => void } {
  const repoRoot = mkdtempSync(join(tmpdir(), "shepherd-newproject-root-"));
  return { repoRoot, cleanup: () => rmSync(repoRoot, { recursive: true, force: true }) };
}

/** Happy local-only path: creates dir + .git + one commit + bootstrap files with idea. */
test("createProject: happy local-only path — dir, .git, one commit on main, bootstrap files", async () => {
  const { repoRoot, cleanup } = makeTempRoot();
  try {
    const result = await createProject(
      { name: "my-app", idea: "a todo app", createRemote: false, visibility: "private" },
      repoRoot,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.name).toBe("my-app");
    const target = join(repoRoot, "my-app");
    expect(result.entry.path).toBe(target);
    expect(existsSync(join(target, ".git"))).toBe(true);

    // Exactly one commit with the right message
    const log = execFileSync("git", ["log", "--oneline"], { cwd: target, stdio: "pipe" })
      .toString()
      .trim();
    const lines = log.split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("chore: project bootstrap");

    // Branch should be main
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: target,
      stdio: "pipe",
    })
      .toString()
      .trim();
    expect(branch).toBe("main");

    // Bootstrap files exist and contain idea text
    const readme = readFileSync(join(target, "README.md"), "utf8");
    expect(readme).toContain("my-app");
    expect(readme).toContain("a todo app");

    const gitignore = readFileSync(join(target, ".gitignore"), "utf8");
    expect(gitignore).toContain("node_modules/");
    expect(gitignore).toContain(".env");

    const claude = readFileSync(join(target, "CLAUDE.md"), "utf8");
    expect(claude).toContain("my-app");
    expect(claude).toContain("a todo app");
  } finally {
    cleanup();
  }
});

/** Happy local-only path with empty idea: uses fallback placeholder text. */
test("createProject: empty idea uses fallback placeholder in bootstrap files", async () => {
  const { repoRoot, cleanup } = makeTempRoot();
  try {
    const result = await createProject(
      { name: "bare-proj", idea: "", createRemote: false, visibility: "private" },
      repoRoot,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const target = join(repoRoot, "bare-proj");
    const readme = readFileSync(join(target, "README.md"), "utf8");
    expect(readme).toContain("_No description yet._");
    const claude = readFileSync(join(target, "CLAUDE.md"), "utf8");
    expect(claude).toContain("(to be defined)");
  } finally {
    cleanup();
  }
});

/** Target already exists → newproject_failed_exists. */
test("createProject: returns newproject_failed_exists when target dir pre-exists", async () => {
  const { repoRoot, cleanup } = makeTempRoot();
  try {
    mkdirSync(join(repoRoot, "already-there"));
    const result = await createProject(
      { name: "already-there", idea: "", createRemote: false, visibility: "private" },
      repoRoot,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("newproject_failed_exists");
  } finally {
    cleanup();
  }
});

/** Containment escape → newproject_failed_outside. */
test("createProject: returns newproject_failed_outside for a crafted escaping name", async () => {
  const { repoRoot, cleanup } = makeTempRoot();
  try {
    // Directly call with a pathological name that bypasses the slug validator
    // (slug regex prevents this at the API level, but createProject re-checks as defense-in-depth)
    const result = await createProject(
      { name: "../escape", idea: "", createRemote: false, visibility: "private" },
      repoRoot,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("newproject_failed_outside");
    // Confirm nothing was created outside
    expect(existsSync(join(repoRoot, "..", "escape"))).toBe(false);
  } finally {
    cleanup();
  }
});

/**
 * Identity pre-check failure: inject a stub that returns false →
 * newproject_failed_identity + directory NOT created (identity check runs before mkdirSync).
 * Note: Bun's process.env mutations don't reliably propagate to child processes,
 * so we use the injectable _identityCheck parameter instead of env manipulation.
 */
test("createProject: newproject_failed_identity when git identity unset, dir removed", async () => {
  const { repoRoot, cleanup } = makeTempRoot();
  try {
    const result = await createProject(
      { name: "no-identity", idea: "", createRemote: false, visibility: "private" },
      repoRoot,
      undefined, // default ghRunner (not used — fails before remote step)
      () => false, // stub: identity absent
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("newproject_failed_identity");
    // Identity check runs before mkdirSync, so the directory must not exist
    expect(existsSync(join(repoRoot, "no-identity"))).toBe(false);
  } finally {
    cleanup();
  }
});

/** Remote path with a stub GhRunner that resolves → ok:true no warning. */
test("createProject: remote success with stub runner → ok:true, no warning", async () => {
  const { repoRoot, cleanup } = makeTempRoot();
  try {
    const calls: string[][] = [];
    const stubRunner: GhRunner = async (args) => {
      calls.push(args);
      // resolve void — success
    };

    const result = await createProject(
      { name: "with-remote", idea: "test", createRemote: true, visibility: "private" },
      repoRoot,
      stubRunner,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warning).toBeUndefined();
    // auth check + repo create should have been called
    expect(calls.length).toBe(2);
    expect(calls[0]![0]).toBe("auth");
    expect(calls[1]![0]).toBe("repo");
    // dir must be kept
    expect(existsSync(join(repoRoot, "with-remote"))).toBe(true);
  } finally {
    cleanup();
  }
});

/** An explicit owner creates the repo as `<owner>/<name>`. */
test("createProject: owner set → gh repo create uses 'owner/name'", async () => {
  const { repoRoot, cleanup } = makeTempRoot();
  try {
    const calls: string[][] = [];
    const stubRunner: GhRunner = async (args) => {
      calls.push(args);
    };

    const result = await createProject(
      { name: "team-app", idea: "", createRemote: true, visibility: "private", owner: "acme-corp" },
      repoRoot,
      stubRunner,
    );
    expect(result.ok).toBe(true);
    // repo create is the second call; the positional repo arg is owner/name
    expect(calls[1]![0]).toBe("repo");
    expect(calls[1]![2]).toBe("acme-corp/team-app");
  } finally {
    cleanup();
  }
});

/** An empty owner lets gh default to the personal account (bare name). */
test("createProject: empty owner → gh repo create uses bare name", async () => {
  const { repoRoot, cleanup } = makeTempRoot();
  try {
    const calls: string[][] = [];
    const stubRunner: GhRunner = async (args) => {
      calls.push(args);
    };

    const result = await createProject(
      { name: "solo-app", idea: "", createRemote: true, visibility: "private", owner: "" },
      repoRoot,
      stubRunner,
    );
    expect(result.ok).toBe(true);
    expect(calls[1]![2]).toBe("solo-app");
  } finally {
    cleanup();
  }
});

/** listGithubOwners: login + orgs parsed from gh stdout. */
test("listGithubOwners: returns login and orgs", async () => {
  const runner: GhOutRunner = async (args) => {
    if (args[1] === "user") return "octocat\n";
    if (args[1] === "user/orgs") return "acme-corp\nwidgets-inc\n";
    return "";
  };
  const owners = await listGithubOwners(runner);
  expect(owners.login).toBe("octocat");
  expect(owners.orgs).toEqual(["acme-corp", "widgets-inc"]);
});

/** listGithubOwners: an org-list failure degrades to login + no orgs. */
test("listGithubOwners: org-list failure → login with empty orgs", async () => {
  const runner: GhOutRunner = async (args) => {
    if (args[1] === "user") return "octocat\n";
    throw Object.assign(new Error("missing read:org scope"), { stderr: "HTTP 403" });
  };
  const owners = await listGithubOwners(runner);
  expect(owners.login).toBe("octocat");
  expect(owners.orgs).toEqual([]);
});

/** listGithubRepos: login + repos parsed from gh stdout (one jq object per line). */
test("listGithubRepos: parses login and repos from gh stdout", async () => {
  const runner: GhOutRunner = async (args) => {
    if (args[1] === "user") return "octocat\n";
    // args[1] is "user/repos?..." — return two jq-emitted objects, one per line.
    return [
      JSON.stringify({
        nameWithOwner: "octocat/hello",
        owner: "octocat",
        name: "hello",
        url: "https://github.com/octocat/hello.git",
        isPrivate: false,
        isFork: false,
        isArchived: false,
        pushedAt: "2026-06-01T00:00:00Z",
      }),
      JSON.stringify({
        nameWithOwner: "acme/widget",
        owner: "acme",
        name: "widget",
        url: "https://github.com/acme/widget.git",
        isPrivate: true,
        isFork: false,
        isArchived: false,
        pushedAt: "2026-05-01T00:00:00Z",
      }),
      "",
    ].join("\n");
  };
  const { login, repos } = await listGithubRepos(runner);
  expect(login).toBe("octocat");
  expect(repos.map((r) => r.nameWithOwner)).toEqual(["octocat/hello", "acme/widget"]);
  expect(repos[1]!.isPrivate).toBe(true);
});

/** listGithubRepos: dedups repeated slugs and skips malformed jq lines. */
test("listGithubRepos: dedups and skips malformed lines", async () => {
  const ok = JSON.stringify({
    nameWithOwner: "octocat/hello",
    owner: "octocat",
    name: "hello",
    url: "https://github.com/octocat/hello.git",
  });
  const runner: GhOutRunner = async (args) => {
    if (args[1] === "user") return "octocat\n";
    return [ok, "not json", ok].join("\n");
  };
  const { repos } = await listGithubRepos(runner);
  expect(repos).toHaveLength(1);
  expect(repos[0]!.nameWithOwner).toBe("octocat/hello");
});

/** listGithubRepos: a failed login lookup still returns repos (login null). */
test("listGithubRepos: login failure degrades to null login", async () => {
  const runner: GhOutRunner = async (args) => {
    if (args[1] === "user") throw new Error("not authed for user");
    return JSON.stringify({
      nameWithOwner: "acme/widget",
      owner: "acme",
      name: "widget",
      url: "https://github.com/acme/widget.git",
    });
  };
  const { login, repos } = await listGithubRepos(runner);
  expect(login).toBeNull();
  expect(repos).toHaveLength(1);
});

/** Stub rejects with "name already exists" → ok:true + warning:newproject_failed_gh_exists + dir kept. */
test("createProject: gh repo create 'name already exists' → ok:true + warning gh_exists + dir kept", async () => {
  const { repoRoot, cleanup } = makeTempRoot();
  try {
    let call = 0;
    const stubRunner: GhRunner = async () => {
      call++;
      if (call === 1) return; // auth ok
      // repo create fails with name already exists
      const err = Object.assign(new Error("GraphQL: Name already exists on this account"), {
        stderr: "GraphQL: Name already exists on this account",
      });
      throw err;
    };

    const result = await createProject(
      { name: "dupe-remote", idea: "", createRemote: true, visibility: "private" },
      repoRoot,
      stubRunner,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warning).toBe("newproject_failed_gh_exists");
    // local dir must be kept
    expect(existsSync(join(repoRoot, "dupe-remote"))).toBe(true);
  } finally {
    cleanup();
  }
});

/** Stub auth rejects → ok:true + warning:newproject_failed_gh_auth. */
test("createProject: gh auth failure → ok:true + warning gh_auth + dir kept", async () => {
  const { repoRoot, cleanup } = makeTempRoot();
  try {
    const stubRunner: GhRunner = async () => {
      throw Object.assign(new Error("not logged in"), {
        stderr: "You are not logged into any GitHub hosts. Run gh auth login to authenticate.",
      });
    };

    const result = await createProject(
      { name: "auth-fail", idea: "", createRemote: true, visibility: "private" },
      repoRoot,
      stubRunner,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warning).toBe("newproject_failed_gh_auth");
    expect(existsSync(join(repoRoot, "auth-fail"))).toBe(true);
  } finally {
    cleanup();
  }
});

/** Stub returns ENOENT (gh not installed) → ok:true + warning:newproject_failed_gh_missing. */
test("createProject: gh not installed (ENOENT) → ok:true + warning gh_missing + dir kept", async () => {
  const { repoRoot, cleanup } = makeTempRoot();
  try {
    const stubRunner: GhRunner = async () => {
      const err = Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
      throw err;
    };

    const result = await createProject(
      { name: "no-gh", idea: "", createRemote: true, visibility: "private" },
      repoRoot,
      stubRunner,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warning).toBe("newproject_failed_gh_missing");
    expect(existsSync(join(repoRoot, "no-gh"))).toBe(true);
  } finally {
    cleanup();
  }
});

// ── classifyProjectError ──────────────────────────────────────────────────────

test("classifyProjectError: code _timeout → newproject_failed_timeout", () => {
  expect(classifyProjectError({ code: "_timeout" })).toBe("newproject_failed_timeout");
});

test("classifyProjectError: killed+SIGTERM → newproject_failed_timeout", () => {
  expect(classifyProjectError({ killed: true, signal: "SIGTERM" })).toBe(
    "newproject_failed_timeout",
  );
});

test("classifyProjectError: ENOENT → newproject_failed_gh_missing", () => {
  expect(classifyProjectError({ code: "ENOENT" })).toBe("newproject_failed_gh_missing");
});

test("classifyProjectError: stderr 'command not found' → newproject_failed_gh_missing", () => {
  expect(classifyProjectError({ stderr: "gh: command not found" })).toBe(
    "newproject_failed_gh_missing",
  );
});

test("classifyProjectError: stderr 'not logged' → newproject_failed_gh_auth", () => {
  expect(classifyProjectError({ stderr: "You are not logged into any GitHub hosts." })).toBe(
    "newproject_failed_gh_auth",
  );
});

test("classifyProjectError: stderr 'gh auth login' → newproject_failed_gh_auth", () => {
  expect(classifyProjectError({ stderr: "Run gh auth login to authenticate." })).toBe(
    "newproject_failed_gh_auth",
  );
});

test("classifyProjectError: stderr 'name already exists' → newproject_failed_gh_exists", () => {
  expect(classifyProjectError({ stderr: "GraphQL: Name already exists on this account" })).toBe(
    "newproject_failed_gh_exists",
  );
});

test("classifyProjectError: stderr 'fatal:' (local git) → newproject_failed_git", () => {
  expect(classifyProjectError({ stderr: "fatal: not a git repository" })).toBe(
    "newproject_failed_git",
  );
});

test("classifyProjectError: stderr 'Author identity unknown' → newproject_failed_git", () => {
  expect(classifyProjectError({ stderr: "Author identity unknown" })).toBe("newproject_failed_git");
});

test("classifyProjectError: non-empty other stderr → newproject_failed_remote", () => {
  expect(classifyProjectError({ stderr: "some unexpected gh error" })).toBe(
    "newproject_failed_remote",
  );
});

test("classifyProjectError: empty/no stderr → newproject_failed_generic (fallback)", () => {
  expect(classifyProjectError({})).toBe("newproject_failed_generic");
});

/** Regression: "remote: Repository not found" must NOT classify as gh_missing. */
test("classifyProjectError: stderr 'remote: Repository not found' → newproject_failed_remote (not gh_missing)", () => {
  expect(classifyProjectError({ stderr: "remote: Repository not found." })).toBe(
    "newproject_failed_remote",
  );
});

/** Runner timeout on repo create → ok:true + warning:newproject_failed_timeout + dir kept. */
test("createProject: runner _timeout on repo create → ok:true + warning timeout + dir kept", async () => {
  const { repoRoot, cleanup } = makeTempRoot();
  try {
    let call = 0;
    const stubRunner: GhRunner = async () => {
      call++;
      if (call === 1) return; // auth ok
      // repo create times out
      const err = Object.assign(new Error("timed out"), { code: "_timeout" });
      throw err;
    };

    const result = await createProject(
      { name: "timeout-remote", idea: "", createRemote: true, visibility: "private" },
      repoRoot,
      stubRunner,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warning).toBe("newproject_failed_timeout");
    // local dir must be kept
    expect(existsSync(join(repoRoot, "timeout-remote"))).toBe(true);
  } finally {
    cleanup();
  }
});

// ── forkRepo ──────────────────────────────────────────────────────────────────

/** Happy path: auth ok + fork ok → ok:true, entry, and the exact gh args. */
test("forkRepo: happy path → ok:true, entry, runs auth then `repo fork --clone -- <target>`", async () => {
  const { repoRoot, cleanup } = makeTempRoot();
  try {
    const calls: string[][] = [];
    const stubRunner: GhRunner = async (args) => {
      calls.push(args);
      // resolve void — success for both auth status and repo fork
    };
    const result = await forkRepo({ repo: "dannymcc/may", name: "may" }, repoRoot, stubRunner);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.name).toBe("may");
    expect(result.entry.path).toBe(join(repoRoot, "may"));
    expect(calls.length).toBe(2);
    expect(calls[0]).toEqual(["auth", "status"]);
    expect(calls[1]).toEqual([
      "repo",
      "fork",
      "dannymcc/may",
      "--clone",
      "--",
      join(repoRoot, "may"),
    ]);
  } finally {
    cleanup();
  }
});

/** Not logged in: auth status rejects → ok:false + forkrepo_failed_auth, no fork attempted. */
test("forkRepo: gh not logged in → forkrepo_failed_auth", async () => {
  const { repoRoot, cleanup } = makeTempRoot();
  try {
    const calls: string[][] = [];
    const stubRunner: GhRunner = async (args) => {
      calls.push(args);
      const err = Object.assign(new Error("You are not logged into any GitHub hosts"), {
        stderr: "You are not logged into any GitHub hosts. Run gh auth login",
      });
      throw err;
    };
    const result = await forkRepo({ repo: "dannymcc/may", name: "may" }, repoRoot, stubRunner);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("forkrepo_failed_auth");
    expect(calls.length).toBe(1); // fork never attempted
  } finally {
    cleanup();
  }
});

/** gh not installed: auth status rejects ENOENT → forkrepo_failed_gh_missing. */
test("forkRepo: gh missing → forkrepo_failed_gh_missing", async () => {
  const { repoRoot, cleanup } = makeTempRoot();
  try {
    const stubRunner: GhRunner = async () => {
      throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
    };
    const result = await forkRepo({ repo: "dannymcc/may", name: "may" }, repoRoot, stubRunner);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("forkrepo_failed_gh_missing");
  } finally {
    cleanup();
  }
});

/** Existence guard: target dir already exists → forkrepo_failed_exists (no gh call). */
test("forkRepo: target dir exists → forkrepo_failed_exists", async () => {
  const { repoRoot, cleanup } = makeTempRoot();
  try {
    mkdirSync(join(repoRoot, "may"));
    let called = false;
    const stubRunner: GhRunner = async () => {
      called = true;
    };
    const result = await forkRepo({ repo: "dannymcc/may", name: "may" }, repoRoot, stubRunner);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("forkrepo_failed_exists");
    expect(called).toBe(false);
  } finally {
    cleanup();
  }
});

/** Containment guard: an escaping name → forkrepo_failed_outside (no gh call). */
test("forkRepo: escaping name → forkrepo_failed_outside", async () => {
  const { repoRoot, cleanup } = makeTempRoot();
  try {
    let called = false;
    const stubRunner: GhRunner = async () => {
      called = true;
    };
    const result = await forkRepo(
      { repo: "dannymcc/may", name: "../escape" },
      repoRoot,
      stubRunner,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("forkrepo_failed_outside");
    expect(called).toBe(false);
  } finally {
    cleanup();
  }
});

/** Fork step fails with "repository not found" → forkrepo_failed_url (auth passed). */
test("forkRepo: fork step 'repository not found' → forkrepo_failed_url", async () => {
  const { repoRoot, cleanup } = makeTempRoot();
  try {
    let call = 0;
    const stubRunner: GhRunner = async () => {
      call++;
      if (call === 1) return; // auth ok
      throw Object.assign(new Error("not found"), {
        stderr:
          "GraphQL: Could not resolve to a Repository with the name 'dannymcc/nope'. (not found)",
      });
    };
    const result = await forkRepo({ repo: "dannymcc/nope", name: "nope" }, repoRoot, stubRunner);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("forkrepo_failed_url");
  } finally {
    cleanup();
  }
});

test("classifyForkError: timeout, gh-missing, auth, url, generic", () => {
  expect(classifyForkError(Object.assign(new Error("t"), { code: "_timeout" }))).toBe(
    "forkrepo_failed_timeout",
  );
  expect(classifyForkError(Object.assign(new Error("x"), { code: "ENOENT" }))).toBe(
    "forkrepo_failed_gh_missing",
  );
  expect(classifyForkError({ stderr: "you are not logged in" })).toBe("forkrepo_failed_auth");
  expect(classifyForkError({ stderr: "HTTP 403: forbidden (permission)" })).toBe(
    "forkrepo_failed_auth",
  );
  expect(classifyForkError({ stderr: "could not resolve host github.com" })).toBe(
    "forkrepo_failed_url",
  );
  expect(classifyForkError({ stderr: "something weird" })).toBe("forkrepo_failed_generic");
});
