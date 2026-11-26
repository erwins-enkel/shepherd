import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CredentialMirror } from "../src/credential-mirror";
import { credentialMirrorPath } from "../src/credential-mirror-path";

let root: string;
let claudeDir: string;
let mirrorRoot: string;
let logs: string[];

const cred = (accessToken: string, expiresAt: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    claudeAiOauth: { accessToken, refreshToken: `r-${accessToken}`, expiresAt },
    ...extra,
  });

const hostFile = () => join(claudeDir, ".credentials.json");
const mirrorFile = () => credentialMirrorPath(claudeDir, mirrorRoot);
const read = (p: string) => readFileSync(p, "utf8").trimEnd();
/** Host Claude's refresh: tmp + rename → a new inode. */
function hostRefresh(content: string): void {
  writeFileSync(`${hostFile()}.tmp`, content, { mode: 0o600 });
  renameSync(`${hostFile()}.tmp`, hostFile());
}
/** In-sandbox Claude's refresh: in place into the bound (mirror) inode. */
function sandboxRefresh(content: string): void {
  writeFileSync(mirrorFile(), content);
}

function makeMirror(masked = false): CredentialMirror {
  return new CredentialMirror({
    root: () => mirrorRoot,
    masked: () => masked,
    every: () => () => {},
    log: (m) => logs.push(m),
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cred-mirror-"));
  claudeDir = join(root, "home", ".claude");
  mirrorRoot = join(root, "run", "membrane-creds");
  mkdirSync(claudeDir, { recursive: true });
  logs = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("credentialMirrorPath", () => {
  test("is deterministic per claudeDir and distinct across dirs", () => {
    expect(credentialMirrorPath("/a", "/r")).toBe(credentialMirrorPath("/a", "/r"));
    expect(credentialMirrorPath("/a", "/r")).not.toBe(credentialMirrorPath("/b", "/r"));
    expect(credentialMirrorPath("/a", "/r")).toMatch(/^\/r\/[A-Za-z0-9_-]+\/\.credentials\.json$/);
  });
});

describe("CredentialMirror.ensure", () => {
  test("creates a 0600 mirror (0700 dir) with the host content", async () => {
    writeFileSync(hostFile(), cred("a", 1), { mode: 0o600 });
    await makeMirror().ensure(claudeDir);
    expect(read(mirrorFile())).toBe(cred("a", 1));
    expect(statSync(mirrorFile()).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(mirrorFile())).mode & 0o777).toBe(0o700);
  });

  test("no host credential → no mirror", async () => {
    await makeMirror().ensure(claudeDir);
    expect(existsSync(mirrorFile())).toBe(false);
  });

  test("api-key mode → no mirror", async () => {
    writeFileSync(hostFile(), cred("a", 1));
    await makeMirror(true).ensure(claudeDir);
    expect(existsSync(mirrorFile())).toBe(false);
  });

  test("an existing stale mirror is synced to the newer host credential, inode kept", async () => {
    writeFileSync(hostFile(), cred("old", 1));
    await makeMirror().ensure(claudeDir);
    const ino = statSync(mirrorFile()).ino;
    hostRefresh(cred("new", 2));
    await makeMirror().ensure(claudeDir); // fresh instance: no lastSynced
    expect(read(mirrorFile())).toBe(cred("new", 2));
    expect(statSync(mirrorFile()).ino).toBe(ino);
  });
});

describe("CredentialMirror.reconcile", () => {
  test("host refresh (new inode) → mirror rewritten IN PLACE", async () => {
    writeFileSync(hostFile(), cred("a", 1));
    const m = makeMirror();
    await m.ensure(claudeDir);
    const ino = statSync(mirrorFile()).ino;
    hostRefresh(cred("b", 2));
    await m.reconcile(claudeDir);
    expect(read(mirrorFile())).toBe(cred("b", 2));
    expect(statSync(mirrorFile()).ino).toBe(ino);
  });

  test("sandbox refresh → host replaced by rename (0600)", async () => {
    writeFileSync(hostFile(), cred("a", 1), { mode: 0o600 });
    const m = makeMirror();
    await m.ensure(claudeDir);
    const hostIno = statSync(hostFile()).ino;
    sandboxRefresh(cred("s", 2));
    await m.reconcile(claudeDir);
    expect(read(hostFile())).toBe(cred("s", 2));
    expect(statSync(hostFile()).ino).not.toBe(hostIno);
    expect(statSync(hostFile()).mode & 0o777).toBe(0o600);
  });

  test("only one side changed wins even with an older expiresAt", async () => {
    writeFileSync(hostFile(), cred("a", 5));
    const m = makeMirror();
    await m.ensure(claudeDir);
    sandboxRefresh(cred("logout-login", 3));
    await m.reconcile(claudeDir);
    expect(read(hostFile())).toBe(cred("logout-login", 3));
  });

  test("both changed → the later expiresAt wins", async () => {
    writeFileSync(hostFile(), cred("a", 1));
    const m = makeMirror();
    await m.ensure(claudeDir);
    hostRefresh(cred("h", 2));
    sandboxRefresh(cred("s", 3));
    await m.reconcile(claudeDir);
    expect(read(hostFile())).toBe(cred("s", 3));
    expect(read(mirrorFile())).toBe(cred("s", 3));
  });

  test("a partial (unparseable) mirror write is skipped, then synced once complete", async () => {
    writeFileSync(hostFile(), cred("a", 1));
    const m = makeMirror();
    await m.ensure(claudeDir);
    sandboxRefresh('{"claudeAiOauth":{"acc');
    await m.reconcile(claudeDir);
    expect(read(hostFile())).toBe(cred("a", 1));
    sandboxRefresh(cred("s", 2));
    await m.reconcile(claudeDir);
    expect(read(hostFile())).toBe(cred("s", 2));
  });

  test("host logged out → mirror never resurrects it", async () => {
    writeFileSync(hostFile(), cred("a", 1));
    const m = makeMirror();
    await m.ensure(claudeDir);
    rmSync(hostFile());
    sandboxRefresh(cred("s", 2));
    await m.reconcile(claudeDir);
    expect(existsSync(hostFile())).toBe(false);
  });

  test("padding from an in-place shrink does not count as a change", async () => {
    writeFileSync(hostFile(), cred("long-token-value", 1));
    const m = makeMirror();
    await m.ensure(claudeDir);
    hostRefresh(cred("s", 2)); // shorter → mirror padded with newlines
    await m.reconcile(claudeDir);
    const hostIno = statSync(hostFile()).ino;
    await m.reconcile(claudeDir);
    expect(statSync(hostFile()).ino).toBe(hostIno);
    expect(JSON.parse(readFileSync(mirrorFile(), "utf8"))).toEqual(JSON.parse(cred("s", 2)));
  });
});

describe("CredentialMirror.start", () => {
  test("rediscovers mirrors via their source sidecar after a restart and syncs them", async () => {
    writeFileSync(hostFile(), cred("a", 1));
    await makeMirror().ensure(claudeDir);
    hostRefresh(cred("b", 2));
    let ticks = 0;
    const fresh = new CredentialMirror({
      root: () => mirrorRoot,
      masked: () => false,
      every: () => {
        ticks++;
        return () => {};
      },
      log: (m) => logs.push(m),
    });
    await fresh.start();
    expect(read(mirrorFile())).toBe(cred("b", 2));
    expect(ticks).toBe(1);
  });

  test("ignores a sidecar that does not hash to its own dir", async () => {
    const bogus = join(mirrorRoot, "bm90LXRoZS1kaXI");
    mkdirSync(bogus, { recursive: true });
    writeFileSync(join(bogus, "source"), claudeDir);
    writeFileSync(join(bogus, ".credentials.json"), cred("evil", 9));
    writeFileSync(hostFile(), cred("a", 1));
    await makeMirror().start();
    expect(read(hostFile())).toBe(cred("a", 1));
  });
});
