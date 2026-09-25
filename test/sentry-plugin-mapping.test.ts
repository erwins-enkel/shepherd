// Sentry plugin (#2464): repo → Sentry project mapping suggestions.

import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectFromFiles,
  matchCodeMappings,
  originUrl,
  parseBundlerConfig,
  parseSentryclirc,
  parseSentryProperties,
  repoSlugFromUrl,
} from "../src/plugins/bundled/sentry/mapping";

const FIX = join(import.meta.dir, "fixtures/sentry");

function withRepo(fn: (repo: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const repo = mkdtempSync(join(tmpdir(), "shep-sentry-map-"));
    try {
      await fn(repo);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  };
}

test(
  "detects org/project from a SvelteKit vite config fixture",
  withRepo(async (repo) => {
    writeFileSync(join(repo, "vite.config.ts"), readFileSync(join(FIX, "vite.config.ts.txt")));
    expect(await detectFromFiles(repo)).toEqual({
      repo,
      org: "ltdovr",
      project: "flowagent",
      source: "sentry-config",
    });
  }),
);

test(
  "falls back to .sentryclirc, then sentry.properties; none → null",
  withRepo(async (repo) => {
    expect(await detectFromFiles(repo)).toBeNull();
    writeFileSync(join(repo, "sentry.properties"), "defaults.org=acme\ndefaults.project=api\n");
    expect(await detectFromFiles(repo)).toMatchObject({
      project: "api",
      source: "sentry-properties",
    });
    writeFileSync(
      join(repo, ".sentryclirc"),
      "[auth]\ntoken=x\n[defaults]\norg = acme\nproject = web\n",
    );
    expect(await detectFromFiles(repo)).toMatchObject({
      org: "acme",
      project: "web",
      source: "sentryclirc",
    });
  }),
);

test("parsers ignore non-Sentry configs and invalid slugs", () => {
  expect(parseBundlerConfig(`export default { project: "web" }`)).toBeNull();
  expect(parseBundlerConfig(`sentryVitePlugin({ project: "Bad Slug!" })`)).toBeNull();
  expect(parseSentryclirc("[auth]\nproject=web\n")).toBeNull();
  expect(parseSentryProperties("defaults.org=acme\n")).toBeNull();
});

test("repoSlugFromUrl handles https and scp-style remotes", () => {
  expect(repoSlugFromUrl("https://github.com/LtdOvr/FlowAgent.git")).toBe("ltdovr/flowagent");
  expect(repoSlugFromUrl("git@github.com:ltdovr/flowagent.git")).toBe("ltdovr/flowagent");
  expect(repoSlugFromUrl("nonsense")).toBeNull();
});

test(
  "originUrl reads .git/config, including through a linked worktree's commondir",
  withRepo(async (root) => {
    const main = join(root, "main");
    mkdirSync(join(main, ".git/worktrees/wt"), { recursive: true });
    writeFileSync(
      join(main, ".git/config"),
      '[core]\n\tbare = false\n[remote "upstream"]\n\turl = x\n[remote "origin"]\n\turl = git@github.com:ltdovr/flowagent.git\n',
    );
    expect(await originUrl(main)).toBe("git@github.com:ltdovr/flowagent.git");
    const wt = join(root, "wt");
    mkdirSync(wt);
    writeFileSync(join(wt, ".git"), `gitdir: ${join(main, ".git/worktrees/wt")}\n`);
    writeFileSync(join(main, ".git/worktrees/wt/commondir"), "../..\n");
    expect(await originUrl(wt)).toBe("git@github.com:ltdovr/flowagent.git");
    expect(await originUrl(join(root, "nope"))).toBeNull();
  }),
);

test("matchCodeMappings matches the recorded response by repo slug; junk → []", () => {
  const data = JSON.parse(readFileSync(join(FIX, "recorded-code-mappings.json"), "utf8"));
  expect(
    matchCodeMappings(data, [
      { path: "/r/flowagent", slug: "ltdovr/flowagent" },
      { path: "/r/other", slug: "ltdovr/other" },
    ]),
  ).toEqual([{ repo: "/r/flowagent", org: null, project: "flowagent", source: "code-mappings" }]);
  expect(matchCodeMappings({ detail: "forbidden" }, [])).toEqual([]);
});
