import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyArtifactPublish,
  readTitleInWorktree,
  recordArtifactPublish,
  TITLE_READ_LIMITS,
  type SessionArtifact,
} from "../src/session-artifacts";
import { SessionStore } from "../src/store";

const URL_A = "https://claude.ai/artifact/AAAAAAAAAAAAAAAAAAAAA1";
const URL_B = "https://claude.ai/code/artifact/BBBBBBBBBBBBBBBBBBBBB2";
const LIMITS = { ...TITLE_READ_LIMITS };
afterEach(() => Object.assign(TITLE_READ_LIMITS, LIMITS));

describe("applyArtifactPublish", () => {
  test("a new url appends an entry starting at seq, else 1", () => {
    const one = applyArtifactPublish(
      [],
      { url: URL_A, title: "Canvas", titleIsFallback: false, toolUseId: "t1" },
      100,
    );
    expect(one).toEqual([
      {
        url: URL_A,
        title: "Canvas",
        versions: 1,
        firstSeenAt: 100,
        updatedAt: 100,
        toolUseId: "t1",
      },
    ]);
    const two = applyArtifactPublish(
      one,
      { url: URL_B, title: "B", titleIsFallback: false, seq: 4 },
      200,
    );
    expect(two[1]).toEqual({
      url: URL_B,
      title: "B",
      versions: 4,
      firstSeenAt: 200,
      updatedAt: 200,
      toolUseId: null,
    });
  });

  test("the same url keeps one entry and counts its version up, to seq when higher", () => {
    let list = applyArtifactPublish(
      [],
      { url: URL_A, title: "Canvas", titleIsFallback: false, seq: 1 },
      100,
    );
    list = applyArtifactPublish(
      list,
      { url: URL_A, title: "Canvas", titleIsFallback: false, seq: 1, toolUseId: "t2" },
      200,
    );
    expect(list).toEqual([
      {
        url: URL_A,
        title: "Canvas",
        versions: 2,
        firstSeenAt: 100,
        updatedAt: 200,
        toolUseId: "t2",
      },
    ]);
    list = applyArtifactPublish(
      list,
      { url: URL_A, title: "Canvas", titleIsFallback: false, seq: 8 },
      300,
    );
    expect(list[0]?.versions).toBe(8);
    expect(list[0]?.toolUseId).toBeNull();
  });

  test("a fallback title never replaces a title the entry has; a real one does", () => {
    let list = applyArtifactPublish([], { url: URL_A, title: "Canvas", titleIsFallback: false }, 1);
    list = applyArtifactPublish(
      list,
      { url: URL_A, title: "claude.ai/artifact/AAAA…AA1", titleIsFallback: true },
      2,
    );
    expect(list[0]?.title).toBe("Canvas");
    list = applyArtifactPublish(
      list,
      { url: URL_A, title: "Canvas v2", titleIsFallback: false },
      3,
    );
    expect(list[0]?.title).toBe("Canvas v2");
  });

  test("nothing is dropped: 60 urls stay, and the first continues its version", () => {
    let list: SessionArtifact[] = [];
    for (let i = 0; i < 60; i++) {
      const url = `https://claude.ai/artifact/Url${String(i).padStart(4, "0")}`;
      list = applyArtifactPublish(list, { url, title: `t${i}`, titleIsFallback: false, seq: 3 }, i);
    }
    expect(list).toHaveLength(60);
    list = applyArtifactPublish(
      list,
      { url: "https://claude.ai/artifact/Url0000", title: "t0", titleIsFallback: false },
      99,
    );
    expect(list).toHaveLength(60);
    expect(list[0]).toMatchObject({ versions: 4, firstSeenAt: 0, updatedAt: 99 });
  });
});

describe("readTitleInWorktree", () => {
  let base: string;
  let wt: string;
  let outside: string;
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "artifact-title-"));
    wt = join(base, "wt");
    outside = join(base, "outside");
    mkdirSync(join(wt, "pages"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(wt, "pages", "page.html"), "<html><head><title>Inside &amp; ok</title>");
    writeFileSync(join(outside, "secret.html"), "<title>Secret</title>");
    symlinkSync(join(outside, "secret.html"), join(wt, "link.html"));
    symlinkSync(outside, join(wt, "linkdir"));
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  test("an absolute path inside the worktree is read", async () => {
    expect(await readTitleInWorktree(wt, join(wt, "pages", "page.html"))).toBe("Inside & ok");
  });

  test("a relative path is read against the worktree", async () => {
    expect(await readTitleInWorktree(wt, "pages/page.html")).toBe("Inside & ok");
    expect(await readTitleInWorktree(wt, "./pages/../pages/page.html")).toBe("Inside & ok");
  });

  test("a path outside the worktree is never read", async () => {
    expect(await readTitleInWorktree(wt, join(outside, "secret.html"))).toBeNull();
    expect(await readTitleInWorktree(wt, "../outside/secret.html")).toBeNull();
    expect(await readTitleInWorktree(wt, join(wt, "..", "outside", "secret.html"))).toBeNull();
  });

  test("a symlinked file or parent directory leading out is never read", async () => {
    expect(await readTitleInWorktree(wt, join(wt, "link.html"))).toBeNull();
    expect(await readTitleInWorktree(wt, join(wt, "linkdir", "secret.html"))).toBeNull();
  });

  test("a FIFO is refused without hanging", async () => {
    const fifo = join(wt, "pipe.html");
    Bun.spawnSync(["mkfifo", fifo]);
    expect(await readTitleInWorktree(wt, fifo)).toBeNull();
  });

  test("a title behind a long prelude, straddling a chunk boundary, is found", async () => {
    const file = join(wt, "long.html");
    const prelude = "x".repeat(2 * 1024 * 1024 - 3); // `<title` starts 3 bytes before a 64 KiB boundary
    writeFileSync(file, `${prelude}<title data-x="1">Late title</title>`);
    expect(await readTitleInWorktree(wt, file)).toBe("Late title");
  });

  test("no title within the byte bound, or no end tag, is no title", async () => {
    const big = join(wt, "big.html");
    writeFileSync(big, `${"y".repeat(TITLE_READ_LIMITS.maxBytes)}<title>Too late</title>`);
    expect(await readTitleInWorktree(wt, big)).toBeNull();
    const open = join(wt, "open.html");
    writeFileSync(open, `<title>${"z".repeat(TITLE_READ_LIMITS.maxTitleChars + 10)}`);
    expect(await readTitleInWorktree(wt, open)).toBeNull();
    const plain = join(wt, "canvas.json");
    writeFileSync(plain, '{"artboards":[]}');
    expect(await readTitleInWorktree(wt, plain)).toBeNull();
  });

  test("a file that keeps growing while it is read still ends", async () => {
    const file = join(wt, "growing.html");
    writeFileSync(file, "g".repeat(1024 * 1024));
    const grow = setInterval(() => appendFileSync(file, "g".repeat(64 * 1024)), 1);
    try {
      expect(await readTitleInWorktree(wt, file)).toBeNull();
    } finally {
      clearInterval(grow);
    }
  });

  test("a read past its time limit gives up with no title", async () => {
    const file = join(wt, "slow.html");
    writeFileSync(file, `${"s".repeat(3 * 1024 * 1024)}<title>Found too late</title>`);
    TITLE_READ_LIMITS.chunkBytes = 256;
    TITLE_READ_LIMITS.timeoutMs = 5;
    expect(await readTitleInWorktree(wt, file)).toBeNull();
  });
});

describe("recordArtifactPublish", () => {
  let wt: string;
  beforeAll(() => {
    wt = mkdtempSync(join(tmpdir(), "artifact-record-"));
    writeFileSync(join(wt, "page.html"), "<title>From the file</title>");
  });
  afterAll(() => rmSync(wt, { recursive: true, force: true }));

  function harness() {
    const store = new SessionStore(":memory:");
    const session = store.create({
      name: "t",
      prompt: "p",
      repoPath: wt,
      baseBranch: "main",
      branch: "shepherd/t",
      worktreePath: wt,
      isolated: false,
      herdrSession: "h",
      herdrAgentId: "a",
      model: null,
    });
    const pushed: { id: string; artifacts: SessionArtifact[] }[] = [];
    const sink = {
      store,
      emit: (id: string, artifacts: SessionArtifact[]) => pushed.push({ id, artifacts }),
    };
    return { store, session, sink, pushed };
  }

  test("title order: the call's title, else the file's <title>, else the shortened url", async () => {
    const { store, session, sink, pushed } = harness();
    await recordArtifactPublish(
      sink,
      session,
      { url: URL_A, inputTitle: "Given", filePath: join(wt, "page.html") },
      1,
    );
    await recordArtifactPublish(sink, session, { url: URL_B, filePath: join(wt, "page.html") }, 2);
    await recordArtifactPublish(
      sink,
      session,
      { url: "https://claude.ai/artifact/CCCCCCCCCCCCCCCCCCCCC3" },
      3,
    );
    expect(store.get(session.id)?.artifacts?.map((a) => a.title)).toEqual([
      "Given",
      "From the file",
      "claude.ai/artifact/CCCC…CC3",
    ]);
    expect(pushed).toHaveLength(3);
    expect(pushed[2]?.artifacts).toEqual(store.get(session.id)?.artifacts ?? []);
  });

  test("publishes of one session apply in arrival order, also after a timed-out read", async () => {
    const { store, session, sink } = harness();
    const slow = join(wt, "slow.html");
    writeFileSync(slow, `${"s".repeat(3 * 1024 * 1024)}<title>Late</title>`);
    TITLE_READ_LIMITS.chunkBytes = 256;
    TITLE_READ_LIMITS.timeoutMs = 5;
    const first = recordArtifactPublish(sink, session, { url: URL_A, filePath: slow, seq: 1 }, 10);
    const second = recordArtifactPublish(
      sink,
      session,
      { url: URL_A, inputTitle: "Named", seq: 1 },
      20,
    );
    await Promise.all([first, second]);
    expect(store.get(session.id)?.artifacts).toEqual([
      { url: URL_A, title: "Named", versions: 2, firstSeenAt: 10, updatedAt: 20, toolUseId: null },
    ]);
  });

  test("an unknown session records nothing", async () => {
    const { sink, pushed } = harness();
    await recordArtifactPublish(sink, { id: "missing", worktreePath: wt }, { url: URL_A }, 1);
    expect(pushed).toEqual([]);
  });
});
