import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  openSync,
  fstatSync,
  closeSync,
  constants as fsConstants,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CI_ARTIFACT_MAX_BYTES,
  CiDownloads,
  parseCiDownloadArgs,
  placeIntoWorktree,
  type CiDownloadForge,
} from "../src/ci-download";
import type { ForgeRunArtifact } from "../src/forge/types";

let base: string;
let wt: string;
let outside: string;
let tmpRoot: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "ci-download-"));
  wt = join(base, "wt");
  outside = join(base, "outside");
  tmpRoot = join(base, "staging");
  mkdirSync(wt);
  mkdirSync(outside);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const session = () => ({ id: "s1", repoPath: "/repo", worktreePath: wt });

function fakeForge(over: Partial<CiDownloadForge> = {}): CiDownloadForge & { calls: string[] } {
  const calls: string[] = [];
  const artifacts: ForgeRunArtifact[] = [
    { id: 9, name: "playwright-report", sizeBytes: 3, expired: false },
    { id: 10, name: "old", sizeBytes: 3, expired: true },
    { id: 11, name: "huge", sizeBytes: CI_ARTIFACT_MAX_BYTES + 1, expired: false },
  ];
  return {
    slug: "o/r",
    calls,
    listRunArtifacts: async (runId) => {
      calls.push(`list ${runId}`);
      return artifacts;
    },
    runLogText: async (runId, o) => {
      calls.push(`log ${runId} ${o.jobId ?? "failed"}`);
      return o.jobId ? "job log" : "FAILED GITHUB_TOKEN=abc123secret";
    },
    downloadArtifactZip: async (id, dest) => {
      calls.push(`zip ${id}`);
      await writeFile(dest, "PK!", { flag: "wx" });
      return 3;
    },
    ...over,
  };
}

const broker = (forge: CiDownloadForge, extra: object = {}) =>
  new CiDownloads({ forgeFor: () => forge, tmpRoot, waitMs: 50, ...extra });

const srcFile = () => {
  const p = join(base, "src.bin");
  writeFileSync(p, "payload");
  return p;
};

test("parseCiDownloadArgs: runId required, at most one target", () => {
  expect(parseCiDownloadArgs({})).toBeString();
  expect(parseCiDownloadArgs({ runId: 1.5 })).toBeString();
  expect(parseCiDownloadArgs({ runId: 1, artifact: "a", jobId: 2 })).toBeString();
  expect(parseCiDownloadArgs({ runId: 1, artifact: "" })).toBeString();
  expect(parseCiDownloadArgs({ runId: 1, jobId: -2 })).toBeString();
  expect(parseCiDownloadArgs({ runId: 1 })).toEqual({ runId: 1, target: { kind: "failed" } });
  expect(parseCiDownloadArgs({ runId: 1, jobId: 2 })).toEqual({
    runId: 1,
    target: { kind: "job", jobId: 2 },
  });
});

test("artifact: raw zip lands under .shepherd-ci/run-<id>/ named by artifact id", async () => {
  const forge = fakeForge();
  const r = await broker(forge).request(session(), { runId: 501, artifact: "playwright-report" });
  const path = join(wt, ".shepherd-ci", "run-501", "artifact-9.zip");
  expect(r).toEqual({ ok: true, data: { status: "done", path, bytes: 3 } });
  expect(readFileSync(path, "utf8")).toBe("PK!");
  expect(forge.calls).toEqual(["list 501", "zip 9"]);
  expect(readdirSync(tmpRoot)).toEqual([]); // staging removed
});

test("failed logs and job logs are redacted text files", async () => {
  const b = broker(fakeForge());
  const failed = await b.request(session(), { runId: 7 });
  expect(failed.ok).toBe(true);
  const text = readFileSync(join(wt, ".shepherd-ci", "run-7", "failed.log"), "utf8");
  expect(text).not.toContain("abc123secret");
  expect(text).toContain("<redacted>");
  await b.request(session(), { runId: 7, jobId: 42 });
  expect(readFileSync(join(wt, ".shepherd-ci", "run-7", "job-42.log"), "utf8")).toBe("job log");
});

test("unknown artifact lists the available names fenced; expired and oversize refuse pre-download", async () => {
  const forge = fakeForge();
  const b = broker(forge);
  const unknown = await b.request(session(), { runId: 1, artifact: "nope" });
  expect(unknown.ok).toBe(false);
  if (!unknown.ok) {
    expect(unknown.error).toContain("⟦UNTRUSTED:artifact-names");
    expect(unknown.error).toContain("playwright-report (3 bytes)");
  }
  const expired = await b.request(session(), { runId: 1, artifact: "old" });
  expect(!expired.ok && expired.error).toContain("expired");
  const huge = await b.request(session(), { runId: 1, artifact: "huge" });
  expect(!huge.ok && huge.error).toContain("cap");
  expect(forge.calls.filter((c) => c.startsWith("zip"))).toEqual([]);
});

test("a gh 404 reads as not-found in the repo", async () => {
  const forge = fakeForge({
    runLogText: async () => {
      throw Object.assign(new Error("x"), { stderr: "HTTP 404: Not Found" });
    },
  });
  const r = await broker(forge).request(session(), { runId: 3 });
  expect(!r.ok && r.error).toContain("not found in o/r");
});

test("long-poll: pending past the wait window, done on the re-call; a different target is busy", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const forge = fakeForge({
    runLogText: async () => {
      await gate;
      return "late";
    },
  });
  const b = broker(forge, { waitMs: 10 });
  const first = await b.request(session(), { runId: 5 });
  expect(first.ok && first.data.status).toBe("pending");
  const busy = await b.request(session(), { runId: 5, jobId: 1 });
  expect(busy.ok).toBe(false);
  release();
  await Bun.sleep(5);
  const second = await b.request(session(), { runId: 5 });
  expect(second.ok && second.data.status).toBe("done");
  // Consumed: a new target now starts fresh.
  const next = await b.request(session(), { runId: 5, jobId: 1 });
  expect(next.ok && next.data.status).toBe("done");
});

test("place: a symlinked .shepherd-ci is refused and nothing lands outside", async () => {
  symlinkSync(outside, join(wt, ".shepherd-ci"));
  await expect(placeIntoWorktree(wt, 1, "failed.log", srcFile())).rejects.toThrow(
    /not a real directory/,
  );
  expect(readdirSync(outside)).toEqual([]);
});

test("place: a symlinked run dir is refused and nothing lands outside", async () => {
  mkdirSync(join(wt, ".shepherd-ci"));
  symlinkSync(outside, join(wt, ".shepherd-ci", "run-1"));
  await expect(placeIntoWorktree(wt, 1, "failed.log", srcFile())).rejects.toThrow(
    /not a real directory/,
  );
  expect(readdirSync(outside)).toEqual([]);
});

test("place: a planted target symlink is replaced; the outside file is untouched", async () => {
  const victim = join(outside, "victim");
  writeFileSync(victim, "precious");
  mkdirSync(join(wt, ".shepherd-ci", "run-1"), { recursive: true });
  const target = join(wt, ".shepherd-ci", "run-1", "failed.log");
  symlinkSync(victim, target);
  expect(await placeIntoWorktree(wt, 1, "failed.log", srcFile())).toBe(7);
  // One no-follow open: a symlink would fail with ELOOP; fstat + read go through the same fd.
  const fd = openSync(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    expect(fstatSync(fd).isFile()).toBe(true);
    expect(readFileSync(fd, "utf8")).toBe("payload");
  } finally {
    closeSync(fd);
  }
  expect(readFileSync(victim, "utf8")).toBe("precious");
});

test("place: swapping .shepherd-ci for a symlink after the dir is held can't redirect the write", async () => {
  const swap = () => {
    renameSync(join(wt, ".shepherd-ci"), join(wt, "moved"));
    symlinkSync(outside, join(wt, ".shepherd-ci"));
    mkdirSync(join(outside, "run-1"));
  };
  await placeIntoWorktree(wt, 1, "failed.log", srcFile(), swap);
  expect(readFileSync(join(wt, "moved", "run-1", "failed.log"), "utf8")).toBe("payload");
  expect(existsSync(join(outside, "run-1", "failed.log"))).toBe(false);
});

test("place: swapping the run dir for a symlink after it is held can't redirect the write", async () => {
  const swap = () => {
    renameSync(join(wt, ".shepherd-ci", "run-1"), join(wt, "moved-run"));
    symlinkSync(outside, join(wt, ".shepherd-ci", "run-1"));
  };
  await placeIntoWorktree(wt, 1, "failed.log", srcFile(), swap);
  expect(readFileSync(join(wt, "moved-run", "failed.log"), "utf8")).toBe("payload");
  expect(readdirSync(outside)).toEqual([]);
});

test("an unclaimed finished download expires: a later identical call fetches fresh", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let fetches = 0;
  const forge = fakeForge({
    runLogText: async () => {
      fetches++;
      await gate;
      return `log ${fetches}`;
    },
  });
  let clock = 0;
  const b = broker(forge, { waitMs: 10, retentionMs: 1000, now: () => clock });
  expect((await b.request(session(), { runId: 8 })).ok).toBe(true); // pending, never re-called
  release();
  await Bun.sleep(5);
  clock = 5000; // past retention
  const r = await b.request(session(), { runId: 8 });
  expect(r.ok && r.data.status).toBe("done");
  expect(fetches).toBe(2);
  expect(readFileSync(join(wt, ".shepherd-ci", "run-8", "failed.log"), "utf8")).toBe("log 2");
});
