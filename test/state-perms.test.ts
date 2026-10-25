import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/store";
import { openPrivateStore, tightenPath } from "../src/state-perms";

const mode = (p: string) => statSync(p).mode & 0o777;
const open = (p: string) => new SessionStore(p);

describe("openPrivateStore (#3404)", () => {
  let root: string;
  let prevUmask: number;
  beforeEach(() => {
    prevUmask = process.umask(0o022);
    root = mkdtempSync(join(tmpdir(), "state-perms-"));
  });
  afterEach(() => {
    process.umask(prevUmask);
    rmSync(root, { recursive: true, force: true });
  });

  it("creates a fresh state dir 0700 and db 0600 under umask 022", () => {
    const dir = join(root, "state");
    const db = join(dir, "shepherd.db");
    openPrivateStore(db, join(dir, "shepherd.log"), open);
    expect(mode(dir)).toBe(0o700);
    expect(mode(db)).toBe(0o600);
    expect(process.umask()).toBe(0o022); // restored
  });

  it("tightens an existing 0755 dir, 0644 db and 0644 log", () => {
    const dir = join(root, "state");
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    const db = join(dir, "shepherd.db");
    const log = join(dir, "shepherd.log");
    open(db);
    chmodSync(db, 0o644);
    writeFileSync(log, "banner\n", { mode: 0o644 });
    writeFileSync(`${log}.1.gz`, "x", { mode: 0o644 });
    writeFileSync(`${log}.7.gz`, "x", { mode: 0o644 });
    openPrivateStore(db, log, open);
    expect(mode(dir)).toBe(0o700);
    expect(mode(db)).toBe(0o600);
    expect(mode(log)).toBe(0o600);
    expect(mode(`${log}.1.gz`)).toBe(0o600);
    expect(mode(`${log}.7.gz`)).toBe(0o600);
  });

  it("never follows a symlinked state dir", () => {
    const target = join(root, "real");
    mkdirSync(target, { mode: 0o755 });
    chmodSync(target, 0o755);
    const link = join(root, "link");
    symlinkSync(target, link);
    tightenPath(link, 0o700);
    expect(mode(target)).toBe(0o755);
  });
});
