// The doc agent's docs-manifest regen runs on the host, outside the agent's membrane, so it must
// execute only the server install's generator against the worktree as data, with an allowlisted
// env (audit run-2 R2-F04). These drive the REAL defaultGenDocs against a throwaway repo.
import { test, expect, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultGenDocs, genDocsEnv, SERVER_INSTALL_ROOT } from "../src/doc-agent";
import { execGit } from "../src/safe-git";
// @ts-expect-error — .mjs data module without types
import { PAGES } from "../docs-site/scripts/sync-docs.mjs";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function put(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

/** A minimal Shepherd-shaped repo whose own generator is replaced by one that drops a marker. */
async function plantedRepo(): Promise<{ root: string; marker: string }> {
  const root = mkdtempSync(join(tmpdir(), "gendocs-wt-"));
  const marker = join(mkdtempSync(join(tmpdir(), "gendocs-marker-")), "ran");
  dirs.push(root, dirname(marker));
  put(root, "docs-site/src/content/docs/planted.md", "---\ntitle: Planted Page\n---\n## Alpha\n");
  for (const p of PAGES as { srcDir: string; src: string }[]) {
    put(root, join(p.srcDir, p.src), "# Page\n## Heading\n");
  }
  put(
    root,
    "ui/scripts/gen-docs-manifest.ts",
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "x");\n`,
  );
  mkdirSync(join(root, "ui/src/lib"), { recursive: true });
  // Scrub any ambient GIT_DIR (e.g. inside a git hook) so init/add target the temp repo only.
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
  await execGit(["init", "-q"], { cwd: root, env });
  await execGit(["add", "-A"], { cwd: root, env });
  return { root, marker };
}

test("defaultGenDocs runs the install's generator, never the worktree's copy", async () => {
  const { root, marker } = await plantedRepo();
  await defaultGenDocs({ worktreePath: root, pin: null });

  expect(existsSync(marker)).toBe(false);
  const manifest = readFileSync(join(root, "ui/src/lib/docs-manifest.ts"), "utf8");
  expect(manifest).toContain("Planted Page");
  // The install's own manifest is untouched.
  expect(
    readFileSync(join(SERVER_INSTALL_ROOT, "ui/src/lib/docs-manifest.ts"), "utf8"),
  ).not.toContain("Planted Page");
});

test("genDocsEnv: allowlist only — no server secrets, pin forwarded", () => {
  const env = genDocsEnv(
    { gitDir: "/r/.git/worktrees/w", workTree: "/w" },
    { PATH: "/bin", HOME: "/h", GH_TOKEN: "x", ANTHROPIC_API_KEY: "y", SHEPHERD_SECRET: "z" },
  );
  expect(Object.keys(env).sort()).toEqual(
    ["GIT_DIR", "GIT_WORK_TREE", "HOME", "PATH", "SHEPHERD_PRETTIER_MODULE"].sort(),
  );
  expect(env.GIT_DIR).toBe("/r/.git/worktrees/w");
  expect(Object.keys(genDocsEnv(null, { PATH: "/bin", GH_TOKEN: "x" })).sort()).toEqual(
    ["HOME", "PATH", "SHEPHERD_PRETTIER_MODULE"].sort(),
  );
});
