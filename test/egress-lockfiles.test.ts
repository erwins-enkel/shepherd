import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostsFromLockfile, suggestLockfileHosts } from "../src/egress-lockfiles";

const CRATES = ["crates.io", "static.crates.io", "index.crates.io"];

test("package-lock.json: resolved hosts, else the npm registry", () => {
  const custom = `{"packages":{"node_modules/a":{"resolved":"https://npm.corp.example/a/-/a-1.tgz","funding":{"url":"https://opencollective.com/a"}},"node_modules/b":{"resolved": "https://registry.npmjs.org/b/-/b-1.tgz"}}}`;
  expect(hostsFromLockfile("package-lock.json", custom)).toEqual([
    "npm.corp.example",
    "registry.npmjs.org",
  ]);
  expect(hostsFromLockfile("package-lock.json", `{"packages":{"":{"name":"x"}}}`)).toEqual([
    "registry.npmjs.org",
  ]);
});

test("bun.lock: empty registry slot = npm registry, URL slot = its host", () => {
  const text = `{
  "lockfileVersion": 1,
  "workspaces": { "": { "name": "x" } },
  "trustedDependencies": ["esbuild", "sharp"],
  "packages": {
    "a": ["a@1.0.0", "", {}, "sha512-x"],
    "@s/b": ["@s/b@2.0.0", "https://npm.pkg.github.com/", {}, "sha512-y"],
    "c": ["c@github:o/c#abc", {}, "o-c-abc"],
  }
}`;
  expect(hostsFromLockfile("bun.lock", text)).toEqual(["registry.npmjs.org", "npm.pkg.github.com"]);
  expect(hostsFromLockfile("bun.lock", `{"packages":{"c":["c@github:o/c#abc",{},"x"]}}`)).toEqual(
    [],
  );
});

test("pnpm-lock.yaml: tarball hosts plus npm registry for integrity-only entries", () => {
  const text = `packages:
  a@1.0.0:
    resolution: {integrity: sha512-x}
  b@1.0.0:
    resolution: {integrity: sha512-y, tarball: https://npm.corp.example/b-1.0.0.tgz}
`;
  expect(hostsFromLockfile("pnpm-lock.yaml", text)).toEqual([
    "npm.corp.example",
    "registry.npmjs.org",
  ]);
  const onlyTarball = `packages:\n  b@1.0.0:\n    resolution: {integrity: sha512-y, tarball: https://npm.corp.example/b.tgz}\n`;
  expect(hostsFromLockfile("pnpm-lock.yaml", onlyTarball)).toEqual(["npm.corp.example"]);
});

test("yarn.lock: v1 resolved hosts; berry = yarnpkg registry", () => {
  const v1 = `a@^1.0.0:\n  version "1.0.0"\n  resolved "https://registry.yarnpkg.com/a/-/a-1.0.0.tgz#abc"\n`;
  expect(hostsFromLockfile("yarn.lock", v1)).toEqual(["registry.yarnpkg.com"]);
  const berry = `__metadata:\n  version: 8\n\n"a@npm:^1.0.0":\n  resolution: "a@npm:1.0.0"\n`;
  expect(hostsFromLockfile("yarn.lock", berry)).toEqual(["registry.yarnpkg.com"]);
});

test("Cargo.lock: crates.io index (git or sparse) = crates trio; other registry/git hosts", () => {
  const text = `[[package]]
name = "a"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "b"
source = "sparse+https://index.crates.io/"

[[package]]
name = "c"
source = "git+https://gitlab.example/o/c?rev=1#abc"

[[package]]
name = "d"
source = "sparse+https://cargo.corp.example/index/"
`;
  expect(hostsFromLockfile("Cargo.lock", text)).toEqual([
    ...CRATES,
    "gitlab.example",
    "cargo.corp.example",
  ]);
});

test("uv.lock: registry, sdist/wheel and git hosts", () => {
  const text = `[[package]]
name = "a"
source = { registry = "https://pypi.org/simple" }
sdist = { url = "https://files.pythonhosted.org/packages/a.tar.gz", hash = "sha256:x" }
wheels = [{ url = "https://download.pytorch.org/whl/a.whl" }]

[[package]]
name = "b"
source = { git = "https://gitlab.example/o/b?rev=1#abc" }

[[package]]
name = "c"
source = { editable = "." }
`;
  expect(hostsFromLockfile("uv.lock", text)).toEqual([
    "pypi.org",
    "files.pythonhosted.org",
    "download.pytorch.org",
    "gitlab.example",
  ]);
});

test("poetry.lock: PyPI pair plus explicit source urls", () => {
  const text = `[[package]]
name = "a"

[package.source]
type = "legacy"
url = "https://pypi.corp.example/simple"
reference = "corp"

[[package]]
name = "b"

[package.source]
type = "directory"
url = "../b"
`;
  expect(hostsFromLockfile("poetry.lock", text)).toEqual([
    "pypi.org",
    "files.pythonhosted.org",
    "pypi.corp.example",
  ]);
});

test("go.sum: Go proxy + checksum DB when non-empty", () => {
  expect(hostsFromLockfile("go.sum", "golang.org/x/net v0.1.0 h1:abc=\n")).toEqual([
    "proxy.golang.org",
    "sum.golang.org",
  ]);
  expect(hostsFromLockfile("go.sum", "  \n")).toEqual([]);
});

test("invalid hosts and non-http URLs are dropped; unknown names yield nothing", () => {
  const text = `{"packages":{"a":{"resolved":"http://localhost:4873/a.tgz"},"b":{"resolved":"file:../b"},"c":{"resolved":"https://under_score.example/c.tgz"}}}`;
  expect(hostsFromLockfile("package-lock.json", text)).toEqual([]);
  expect(hostsFromLockfile("Gemfile.lock", "remote: https://rubygems.org/")).toEqual([]);
});

// ── scan ──────────────────────────────────────────────────────────────────────

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function git(cwd: string, ...args: string[]) {
  // GIT_DIR/GIT_WORK_TREE scrubbed: a hook-run test must not touch the real repo.
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  execFileSync("git", args, { cwd, env, stdio: "ignore" });
}

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "egress-lock-"));
  dirs.push(dir);
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  return dir;
}

const BUN = `{"packages":{"a":["a@1.0.0","",{},"sha512-x"]}}`;
const CARGO = `[[package]]\nsource = "sparse+https://index.crates.io/"\n`;

test("scan: tracked lockfiles at any depth, sources per host, untracked ignored", async () => {
  const dir = repo({ "bun.lock": BUN, "ui/bun.lock": BUN, "cli/Cargo.lock": CARGO });
  writeFileSync(join(dir, "go.sum"), "golang.org/x/net v0.1.0 h1:abc=\n"); // untracked
  expect(await suggestLockfileHosts(dir)).toEqual([
    { host: "registry.npmjs.org", sources: ["bun.lock", "ui/bun.lock"] },
    { host: "crates.io", sources: ["cli/Cargo.lock"] },
    { host: "static.crates.io", sources: ["cli/Cargo.lock"] },
    { host: "index.crates.io", sources: ["cli/Cargo.lock"] },
  ]);
});

test("scan: skips symlinks, oversize files and files missing from the tree", async () => {
  const dir = repo({ "a/bun.lock": BUN, "b/Cargo.lock": CARGO, "c/go.sum": "x v1 h1:y=\n" });
  rmSync(join(dir, "a/bun.lock"));
  symlinkSync(join(dir, "b/Cargo.lock"), join(dir, "a/bun.lock"));
  rmSync(join(dir, "c/go.sum"));
  expect(await suggestLockfileHosts(dir, { maxFileBytes: 10 })).toEqual([]);
  expect((await suggestLockfileHosts(dir)).map((h) => h.host)).toEqual(CRATES);
});

test("scan: a non-repo dir yields nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "egress-lock-"));
  dirs.push(dir);
  writeFileSync(join(dir, "bun.lock"), BUN);
  expect(await suggestLockfileHosts(dir)).toEqual([]);
});
