import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpdateService } from "../src/update";

// The Node signature (src/update.ts) and the update.sh signature must be byte-for-byte
// identical, and both must depend only on real content (not on the repo's diff config).

const HAVE_SHA256SUM = (() => {
  try {
    execFileSync("bash", ["-c", "command -v sha256sum"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

function newRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "shepherd-parity-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "commit.gpgsign", "false");
  return repo;
}

/** The exact framed signature update.sh computes (three subhashes → hash the hex). */
function shellSig(repo: string): string {
  const script = [
    `cd "${repo}"`,
    `s1=$(git status --porcelain -z --untracked-files=no | sha256sum | cut -d' ' -f1)`,
    `s2=$(git diff --cached --binary --no-color --no-ext-diff --no-textconv | sha256sum | cut -d' ' -f1)`,
    `s3=$(git diff --binary --no-color --no-ext-diff --no-textconv | sha256sum | cut -d' ' -f1)`,
    `printf '%s%s%s' "$s1" "$s2" "$s3" | sha256sum | cut -d' ' -f1`,
  ].join("\n");
  return execFileSync("bash", ["-c", script], { encoding: "utf8" }).trim();
}

async function nodeSig(repo: string): Promise<string | null> {
  return (await new UpdateService({ repoDir: repo, launch: () => {} }).dirtyStatus()).sig;
}

test.if(HAVE_SHA256SUM)(
  "Node signature matches the update.sh signature byte-for-byte",
  async () => {
    const repo = newRepo();
    writeFileSync(join(repo, "a.txt"), "one\n");
    writeFileSync(join(repo, "with space.txt"), "two\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "init");
    writeFileSync(join(repo, "a.txt"), "one-EDIT\n"); // unstaged modify
    writeFileSync(join(repo, "with space.txt"), "two-EDIT\n");
    git(repo, "add", "with space.txt"); // staged modify

    expect(await nodeSig(repo)).toBe(shellSig(repo));
  },
);

test.if(HAVE_SHA256SUM)("signature changes on a content edit under the same status", async () => {
  const repo = newRepo();
  writeFileSync(join(repo, "f.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");

  writeFileSync(join(repo, "f.txt"), "base\nedit1\n");
  const status1 = git(repo, "status", "--porcelain");
  const sig1 = await nodeSig(repo);
  expect(sig1).toBe(shellSig(repo));

  writeFileSync(join(repo, "f.txt"), "base\nedit1\nedit2\n"); // still ' M f.txt'
  const status2 = git(repo, "status", "--porcelain");
  const sig2 = await nodeSig(repo);
  expect(sig2).toBe(shellSig(repo));

  expect(status2).toBe(status1); // status unchanged…
  expect(sig2).not.toBe(sig1); // …but the content signature moved
});

test.if(HAVE_SHA256SUM)(
  "textconv/ext-diff config can't collapse or diverge the signature",
  async () => {
    const repo = newRepo();
    // a textconv driver that maps ANY content to a constant + an external differ
    writeFileSync(join(repo, ".gitattributes"), "*.dat diff=lossy\n");
    git(repo, "config", "diff.lossy.textconv", "printf CONST");
    git(repo, "config", "diff.external", "true");
    writeFileSync(join(repo, "x.dat"), "AAAA\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "init");

    writeFileSync(join(repo, "x.dat"), "AAAA-content-B\n");
    const sigB = await nodeSig(repo);
    expect(sigB).toBe(shellSig(repo)); // Node == shell despite the hostile config

    writeFileSync(join(repo, "x.dat"), "AAAA-different-C\n"); // a textconv would collapse B and C
    const sigC = await nodeSig(repo);
    expect(sigC).toBe(shellSig(repo));
    expect(sigC).not.toBe(sigB); // --no-textconv keeps distinct content distinct
  },
);
