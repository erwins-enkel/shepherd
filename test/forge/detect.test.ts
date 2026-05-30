import { test, expect } from "bun:test";
import { forgeFor } from "../../src/forge";
import { GithubForge } from "../../src/forge/github";
import { GiteaForge } from "../../src/forge/gitea";
import type { ForgeMap } from "../../src/forge/types";

const MAP: ForgeMap = {
  "git.example.com": { type: "gitea", baseUrl: "https://git.example.com", token: "t" },
  "github.com": { deployWorkflow: "deploy.yml" },
};

test("forgeFor: github.com remote → GithubForge with slug + host cfg", () => {
  const f = forgeFor("https://github.com/o/r.git", MAP);
  expect(f).toBeInstanceOf(GithubForge);
  expect(f!.slug).toBe("o/r");
});

test("forgeFor: github works even without a config entry", () => {
  const f = forgeFor("git@github.com:o/r.git", {});
  expect(f).toBeInstanceOf(GithubForge);
});

test("forgeFor: configured self-hosted host → GiteaForge", () => {
  const f = forgeFor("https://git.example.com/team/proj.git", MAP);
  expect(f).toBeInstanceOf(GiteaForge);
  expect(f!.slug).toBe("team/proj");
});

test("forgeFor: unknown self-hosted host (no config) → null", () => {
  expect(forgeFor("https://git.other.com/a/b.git", MAP)).toBeNull();
});

test("forgeFor: unparseable remote → null", () => {
  expect(forgeFor("garbage", MAP)).toBeNull();
});

test("forgeFor: explicit type=github on a non-github host", () => {
  const f = forgeFor("https://ghe.corp/o/r.git", { "ghe.corp": { type: "github" } });
  expect(f).toBeInstanceOf(GithubForge);
});
