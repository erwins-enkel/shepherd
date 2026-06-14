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

test("GithubForge.listBranches: returns matching short-names, strips refs/heads/ (#645)", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args.join(" ").includes("git/matching-refs/heads/epic/")) {
      return JSON.stringify([
        { ref: "refs/heads/epic/327-foo" },
        { ref: "refs/heads/epic/efi-valuemap-327" },
        { ref: "refs/tags/v1" }, // non-head ref ignored
      ]);
    }
    return "";
  };
  const forge = new GithubForge("o/r", {}, run);

  const branches = await forge.listBranches!("epic/");
  expect(branches).toEqual(["epic/327-foo", "epic/efi-valuemap-327"]);
  expect(calls.some((c) => c.includes("repos/o/r/git/matching-refs/heads/epic/"))).toBe(true);
});

test("GithubForge.listBranches: empty list → []", async () => {
  const forge = new GithubForge("o/r", {}, async () => "[]");
  expect(await forge.listBranches!("epic/")).toEqual([]);
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
