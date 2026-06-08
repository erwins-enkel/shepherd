import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasHostPermission,
  hostKind,
  originPattern,
  requestHostPermission,
} from "../src/lib/remote-host";

function installPermissionsStub(opts: { contains?: boolean; request?: boolean } = {}) {
  const contains = vi.fn(async () => opts.contains ?? false);
  const request = vi.fn(async () => opts.request ?? false);
  (globalThis as any).chrome = { permissions: { contains, request } };
  return { contains, request };
}

afterEach(() => {
  delete (globalThis as any).chrome;
});

describe("hostKind", () => {
  it("classifies localhost as local", () => {
    expect(hostKind("http://localhost:7330")).toBe("local");
    expect(hostKind("http://localhost:7330/")).toBe("local");
  });

  it("classifies an https ts.net host as remote", () => {
    expect(hostKind("https://shepherd.tail1234.ts.net")).toBe("remote");
    expect(hostKind("https://box.ts.net/")).toBe("remote");
  });

  it("rejects http (insecure) ts.net, arbitrary hosts, and garbage", () => {
    expect(hostKind("http://box.ts.net")).toBe("unsupported");
    expect(hostKind("https://example.com")).toBe("unsupported");
    expect(hostKind("https://evil-ts.net.attacker.com")).toBe("unsupported");
    expect(hostKind("https://127.0.0.1")).toBe("unsupported");
    expect(hostKind("not a url")).toBe("unsupported");
    expect(hostKind("")).toBe("unsupported");
  });
});

describe("originPattern", () => {
  it("derives the origin/* match pattern, dropping any path", () => {
    expect(originPattern("https://box.ts.net")).toBe("https://box.ts.net/*");
    expect(originPattern("https://box.ts.net/api/x")).toBe("https://box.ts.net/*");
    expect(originPattern("http://localhost:7330")).toBe("http://localhost:7330/*");
  });
});

describe("hasHostPermission", () => {
  it("short-circuits true for local/unsupported without querying chrome", async () => {
    const { contains } = installPermissionsStub();
    expect(await hasHostPermission("http://localhost:7330")).toBe(true);
    expect(await hasHostPermission("https://example.com")).toBe(true);
    expect(contains).not.toHaveBeenCalled();
  });

  it("queries chrome.permissions.contains for a remote host", async () => {
    const { contains } = installPermissionsStub({ contains: true });
    expect(await hasHostPermission("https://box.ts.net")).toBe(true);
    expect(contains).toHaveBeenCalledWith({ origins: ["https://box.ts.net/*"] });
  });
});

describe("requestHostPermission", () => {
  it("short-circuits true for local without prompting", async () => {
    const { request } = installPermissionsStub();
    expect(await requestHostPermission("http://localhost:7330")).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it("requests the remote origin and propagates the grant decision", async () => {
    const { request } = installPermissionsStub({ request: true });
    expect(await requestHostPermission("https://box.ts.net")).toBe(true);
    expect(request).toHaveBeenCalledWith({ origins: ["https://box.ts.net/*"] });
  });

  it("returns false when the user denies the prompt", async () => {
    installPermissionsStub({ request: false });
    expect(await requestHostPermission("https://box.ts.net")).toBe(false);
  });
});
