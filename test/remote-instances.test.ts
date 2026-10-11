import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/store";
import {
  FEDERATION_API_VERSION,
  defaultInstanceName,
  instanceIdentity,
  instancePlatform,
  parseInstanceNamePatch,
  setInstanceName,
} from "../src/remote-instances/identity";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("instance identity", () => {
  test("the instance id is generated once and survives reopening the database", () => {
    const dir = mkdtempSync(join(tmpdir(), "shepherd-identity-"));
    tmpDirs.push(dir);
    const dbPath = join(dir, "shepherd.db");
    const first = instanceIdentity(new SessionStore(dbPath));
    expect(first.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    const reopened = new SessionStore(dbPath);
    expect(instanceIdentity(reopened).instanceId).toBe(first.instanceId);
    expect(instanceIdentity(reopened).instanceId).toBe(first.instanceId);
  });

  test("two stores get two different ids", () => {
    const a = instanceIdentity(new SessionStore(":memory:"));
    const b = instanceIdentity(new SessionStore(":memory:"));
    expect(a.instanceId).not.toBe(b.instanceId);
  });

  test("reports version, federation level, platform and arch", () => {
    const id = instanceIdentity(new SessionStore(":memory:"));
    expect(id.federationApi).toBe(FEDERATION_API_VERSION);
    expect(id.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(id.platform).toBe(instancePlatform());
    expect(id.arch).toBe(process.arch);
  });

  test("the name defaults to the host name, can be changed and reset", () => {
    const store = new SessionStore(":memory:");
    expect(instanceIdentity(store).name).toBe(defaultInstanceName());
    setInstanceName(store, "MacBook");
    expect(instanceIdentity(store).name).toBe("MacBook");
    setInstanceName(store, null);
    expect(instanceIdentity(store).name).toBe(defaultInstanceName());
  });

  test("platform names map node's identifiers onto the contract's", () => {
    expect(instancePlatform("darwin")).toBe("macos");
    expect(instancePlatform("win32")).toBe("windows");
    expect(instancePlatform("linux")).toBe("linux");
    expect(instancePlatform("freebsd")).toBe("freebsd");
  });

  test("the default name is the first host label", () => {
    expect(defaultInstanceName("Kais-MBP.local")).toBe("Kais-MBP");
    expect(defaultInstanceName("moes-tavern")).toBe("moes-tavern");
    expect(defaultInstanceName("")).toBe("shepherd");
  });

  test("parseInstanceNamePatch accepts a name or null and rejects everything else", () => {
    expect(parseInstanceNamePatch({ name: "  Linux box " })).toEqual({ name: "Linux box" });
    expect(parseInstanceNamePatch({ name: null })).toEqual({ name: null });
    expect(parseInstanceNamePatch({ name: "   " })).toEqual({ name: null });
    expect(parseInstanceNamePatch({ name: "x".repeat(65) })).toHaveProperty("error");
    expect(parseInstanceNamePatch({ name: 3 })).toHaveProperty("error");
    expect(parseInstanceNamePatch({ name: "a", extra: 1 })).toHaveProperty("error");
    expect(parseInstanceNamePatch(null)).toHaveProperty("error");
  });
});
