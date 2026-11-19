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
import { TOOLS_MAX } from "../src/agent-messages";
import {
  applyArtifactPublish,
  applyArtifactsHide,
  applyArtifactsUnhide,
  readTitleInWorktree,
  recordArtifactPublish,
  setSessionArtifactsHidden,
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
        toolUseIds: ["t1"],
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
        toolUseIds: ["t2"],
      },
    ]);
    list = applyArtifactPublish(
      list,
      { url: URL_A, title: "Canvas", titleIsFallback: false, seq: 8 },
      300,
    );
    expect(list[0]?.versions).toBe(8);
    expect(list[0]?.toolUseId).toBeNull();
    expect(list[0]?.toolUseIds).toEqual(["t2"]);
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

describe("publish ids (#3877)", () => {
  const publish = (list: SessionArtifact[], url: string, toolUseId: string, now: number) =>
    applyArtifactPublish(list, { url, title: "T", titleIsFallback: false, toolUseId }, now);

  test("two versions of one url keep both ids; toolUseId names the latest", () => {
    const list = publish(publish([], URL_A, "t1", 1), URL_A, "t2", 2);
    expect(list[0]).toMatchObject({ toolUseId: "t2", toolUseIds: ["t1", "t2"], versions: 2 });
  });

  test("an entry recorded before #3877 is seeded from its toolUseId", () => {
    const legacy: SessionArtifact = {
      url: URL_A,
      title: "T",
      versions: 1,
      firstSeenAt: 1,
      updatedAt: 1,
      toolUseId: "t1",
    };
    expect(publish([legacy], URL_A, "t2", 2)[0]?.toolUseIds).toEqual(["t1", "t2"]);
  });

  test("a known id moves to the end; the list keeps the newest TOOLS_MAX", () => {
    let list: SessionArtifact[] = [];
    for (let i = 0; i < TOOLS_MAX + 5; i++) list = publish(list, URL_A, `t${i}`, i);
    const ids = list[0]?.toolUseIds ?? [];
    expect(ids).toHaveLength(TOOLS_MAX);
    expect(ids[0]).toBe("t5");
    expect(ids.at(-1)).toBe(`t${TOOLS_MAX + 4}`);
    list = publish(list, URL_A, "t10", 999);
    expect(list[0]?.toolUseIds?.filter((t) => t === "t10")).toHaveLength(1);
    expect(list[0]?.toolUseIds?.at(-1)).toBe("t10");
  });
});

describe("hide for this session (#3877)", () => {
  const two = (): SessionArtifact[] => {
    let list = applyArtifactPublish(
      [],
      { url: URL_A, title: "A", titleIsFallback: false, toolUseId: "t1" },
      10,
    );
    list = applyArtifactPublish(
      list,
      { url: URL_B, title: "B", titleIsFallback: false, toolUseId: "t2" },
      20,
    );
    return list;
  };

  test("a hide stamps every entry; stamps rise strictly, also within one millisecond", () => {
    const first = applyArtifactsHide(two(), 100);
    expect(first.hiddenAt).toBe(100);
    expect(first.list.map((a) => a.hiddenAt)).toEqual([100, 100]);
    const second = applyArtifactsHide(first.list, 100);
    expect(second.hiddenAt).toBe(101);
    expect(second.list.map((a) => a.hiddenAt)).toEqual([101, 101]);
  });

  test("a re-publish keeps the stamp; a new url enters without one", () => {
    const { list } = applyArtifactsHide(two(), 100);
    const again = applyArtifactPublish(
      list,
      { url: URL_A, title: "A", titleIsFallback: false, toolUseId: "t3" },
      200,
    );
    expect(again[0]).toMatchObject({ hiddenAt: 100, toolUseIds: ["t1", "t3"] });
    const added = applyArtifactPublish(
      again,
      {
        url: "https://claude.ai/artifact/CCCCCCCCCCCCCCCCCCCCC3",
        title: "C",
        titleIsFallback: false,
      },
      300,
    );
    expect(added[2]?.hiddenAt).toBeUndefined();
  });

  test("an undo of the newest hide clears every stamp and keeps the publish ids", () => {
    const { list, hiddenAt } = applyArtifactsHide(two(), 100);
    const cleared = applyArtifactsUnhide(list, hiddenAt);
    expect(cleared?.some((a) => "hiddenAt" in a)).toBe(false);
    expect(cleared?.map((a) => a.toolUseIds)).toEqual([["t1"], ["t2"]]);
  });

  test("hide (A) → new url → hide (B) → undo A is superseded and changes nothing", () => {
    const a = applyArtifactsHide(two(), 100);
    const withNew = applyArtifactPublish(
      a.list,
      {
        url: "https://claude.ai/artifact/CCCCCCCCCCCCCCCCCCCCC3",
        title: "C",
        titleIsFallback: false,
      },
      150,
    );
    const b = applyArtifactsHide(withNew, 200);
    expect(applyArtifactsUnhide(b.list, a.hiddenAt)).toBeNull();
    expect(applyArtifactsUnhide(b.list, b.hiddenAt)?.every((x) => x.hiddenAt === undefined)).toBe(
      true,
    );
  });

  test("an undo with nothing hidden is superseded", () => {
    expect(applyArtifactsUnhide(two(), 100)).toBeNull();
  });

  test("setSessionArtifactsHidden persists and pushes; unknown and stale are told apart", () => {
    const store = new SessionStore(":memory:");
    const session = store.create({
      name: "t",
      prompt: "p",
      repoPath: "/tmp",
      baseBranch: "main",
      branch: "shepherd/t",
      worktreePath: "/tmp",
      isolated: false,
      herdrSession: "h",
      herdrAgentId: "a",
      model: null,
    });
    store.setSessionArtifacts(session.id, two());
    const pushed: SessionArtifact[][] = [];
    const sink = { store, emit: (_id: string, list: SessionArtifact[]) => pushed.push(list) };
    const hidden = setSessionArtifactsHidden(sink, session.id, { hidden: true }, 500);
    expect(hidden).toMatchObject({ hiddenAt: 500 });
    expect(store.get(session.id)?.artifacts?.map((a) => a.hiddenAt)).toEqual([500, 500]);
    expect(pushed).toHaveLength(1);
    expect(setSessionArtifactsHidden(sink, session.id, { hidden: false, hiddenAt: 499 }, 600)).toBe(
      "superseded",
    );
    expect(pushed).toHaveLength(1);
    expect(setSessionArtifactsHidden(sink, "missing", { hidden: true }, 600)).toBe("not-found");
    const undone = setSessionArtifactsHidden(
      sink,
      session.id,
      { hidden: false, hiddenAt: 500 },
      700,
    );
    expect(undone).toMatchObject({ hiddenAt: null });
    expect(store.get(session.id)?.artifacts?.some((a) => a.hiddenAt !== undefined)).toBe(false);
    expect(pushed).toHaveLength(2);
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

describe("readTitleInWorktree: the HTML document title", () => {
  let wt: string;
  beforeAll(() => {
    wt = mkdtempSync(join(tmpdir(), "artifact-html-"));
  });
  afterAll(() => rmSync(wt, { recursive: true, force: true }));
  const titleOf = async (html: string) => {
    writeFileSync(join(wt, "page.html"), html);
    return readTitleInWorktree(wt, join(wt, "page.html"));
  };

  test("title-shaped text in a comment, script, style, svg or attribute is not the title", async () => {
    expect(
      await titleOf(
        [
          "<!doctype html><html><head>",
          "<!-- <title>Commented out</title> -->",
          '<script>const t = "<title>From script</title>";</script>',
          "<style>/* <title>From style</title> */</style>",
          '<meta name="x" content="<title>From attribute</title>">',
          "<svg><title>Icon</title></svg>",
          "<TITLE lang='en'>The real &quot;one&quot;</TITLE>",
        ].join("\n"),
      ),
    ).toBe('The real "one"');
  });

  test("a comment or script that never ends hides any later title", async () => {
    expect(await titleOf("<!-- <title>x</title>")).toBeNull();
    expect(await titleOf("<script><title>x</title>")).toBeNull();
  });

  test("markup split at every chunk boundary is still read right", async () => {
    TITLE_READ_LIMITS.chunkBytes = 3;
    expect(
      await titleOf(
        "<!-- a --><script>x</script><svg><title>no</title></svg><title>Small chunks</title>",
      ),
    ).toBe("Small chunks");
  });

  test("only a complete end tag ends a skipped element or the title", async () => {
    const html =
      '<script>const s = "</scripture>"; const t = "<title>Fake</title>";</script>' +
      "<title>Real </titlecase> part</title >";
    expect(await titleOf(html)).toBe("Real </titlecase> part");
    TITLE_READ_LIMITS.chunkBytes = 3;
    expect(await titleOf(html)).toBe("Real </titlecase> part");
    expect(await titleOf("<title>Cut at </title")).toBeNull();
  });

  test("a plain document without markup around its title still yields it", async () => {
    expect(await titleOf("<title>Bare</title>")).toBe("Bare");
    expect(await titleOf("no markup at all")).toBeNull();
  });
});

describe("publish order within one millisecond", () => {
  test("a re-publish in the same millisecond is newer than every other entry", () => {
    let list = applyArtifactPublish([], { url: URL_A, title: "A", titleIsFallback: false }, 50);
    list = applyArtifactPublish(list, { url: URL_B, title: "B", titleIsFallback: false }, 50);
    list = applyArtifactPublish(list, { url: URL_A, title: "A", titleIsFallback: false }, 50);
    const [a, b] = list;
    expect(b!.updatedAt).toBeGreaterThan(50 - 1);
    expect(a!.updatedAt).toBeGreaterThan(b!.updatedAt);
    expect(a!.firstSeenAt).toBe(50);
  });
});
