import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn as nodeSpawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactTooLarge, downloadGithubArtifactZip } from "../../src/forge/github-artifact";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gh-artifact-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A spawn that records gh's argv and runs `script` in sh instead. */
function fakeSpawn(script: string, calls: string[][] = []): typeof nodeSpawn {
  return ((cmd: string, args: string[], opts: object) => {
    calls.push([cmd, ...args]);
    return nodeSpawn("sh", ["-c", script], opts);
  }) as unknown as typeof nodeSpawn;
}

const openRest = () => ({
  blocked: () => false,
  noteLimitError: () => {},
  snapshot: () => ({ pausedUntil: null }) as never,
});

test("streams gh's stdout into the dest file and returns the byte count", async () => {
  const calls: string[][] = [];
  const dest = join(dir, "a.zip");
  const n = await downloadGithubArtifactZip(
    "o/r",
    9,
    dest,
    { maxBytes: 1000 },
    { spawn: fakeSpawn("printf 'PK-zip-bytes'", calls), rest: openRest() },
  );
  expect(n).toBe(12);
  expect(readFileSync(dest, "utf8")).toBe("PK-zip-bytes");
  expect(statSync(dest).mode & 0o777).toBe(0o600);
  expect(calls).toEqual([["gh", "api", "repos/o/r/actions/artifacts/9/zip"]]);
});

test("kills gh and rejects once the stream passes maxBytes", async () => {
  const p = downloadGithubArtifactZip(
    "o/r",
    9,
    join(dir, "a.zip"),
    { maxBytes: 4096 },
    { spawn: fakeSpawn("head -c 1000000 /dev/zero"), rest: openRest() },
  );
  await expect(p).rejects.toBeInstanceOf(ArtifactTooLarge);
});

test("refuses without spawning while the REST read backoff is engaged", async () => {
  const calls: string[][] = [];
  const rest = { ...openRest(), blocked: () => true };
  await expect(
    downloadGithubArtifactZip(
      "o/r",
      9,
      join(dir, "a.zip"),
      { maxBytes: 10 },
      {
        spawn: fakeSpawn("true", calls),
        rest,
      },
    ),
  ).rejects.toThrow(/rate limit backoff/);
  expect(calls).toEqual([]);
});

test("a gh rate-limit failure engages the REST backoff", async () => {
  let noted = 0;
  const rest = { ...openRest(), noteLimitError: () => void noted++ };
  await expect(
    downloadGithubArtifactZip(
      "o/r",
      9,
      join(dir, "a.zip"),
      { maxBytes: 10 },
      {
        spawn: fakeSpawn("echo 'HTTP 403: API rate limit exceeded' >&2; exit 1"),
        rest,
      },
    ),
  ).rejects.toThrow(/gh exited 1/);
  expect(noted).toBe(1);
});

test("never overwrites an existing dest file", async () => {
  const dest = join(dir, "a.zip");
  await Bun.write(dest, "keep");
  await expect(
    downloadGithubArtifactZip(
      "o/r",
      9,
      dest,
      { maxBytes: 10 },
      {
        spawn: fakeSpawn("printf x"),
        rest: openRest(),
      },
    ),
  ).rejects.toThrow(/EEXIST/);
  expect(readFileSync(dest, "utf8")).toBe("keep");
});
