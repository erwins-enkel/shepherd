import { test, expect } from "bun:test";
import { GithubForge } from "../../src/forge/github";

const SHA = "abc123def456";

test("GithubForge.ensureBranch: absent ref → resolves fromRef sha + creates the branch", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    // Probe for the target branch ref → not found (gh exits non-zero).
    if (args.join(" ").includes("git/ref/heads/epic/327-x")) {
      throw new Error("HTTP 404: Not Found");
    }
    // Resolve the base ref's sha.
    if (args.join(" ").includes("git/ref/heads/main")) {
      return JSON.stringify({ object: { sha: SHA } });
    }
    return "";
  };
  const forge = new GithubForge("o/r", {}, run);

  await forge.ensureBranch!("epic/327-x", "main");

  const create = calls.find((c) => c.includes("repos/o/r/git/refs"));
  expect(create).toBeDefined();
  expect(create).toEqual([
    "api",
    "--method",
    "POST",
    "repos/o/r/git/refs",
    "-f",
    "ref=refs/heads/epic/327-x",
    "-f",
    `sha=${SHA}`,
  ]);
});

test("GithubForge.ensureBranch: present ref → no-op, never creates (tip not reset)", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    // Probe for the target branch ref → found.
    if (args.join(" ").includes("git/ref/heads/epic/327-x")) {
      return JSON.stringify({ object: { sha: "existing-tip" } });
    }
    return "";
  };
  const forge = new GithubForge("o/r", {}, run);

  await forge.ensureBranch!("epic/327-x", "main");

  expect(calls.some((c) => c.includes("repos/o/r/git/refs"))).toBe(false);
});
