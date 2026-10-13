import { describe, expect, test } from "bun:test";
import { IncomingMirrors, parseMirrorClaim } from "../src/remote-instances/incoming";
import { mirrorIdentityHeaders } from "../src/remote-instances/identity";

// Who mirrors this Shepherd (#3056): what a peer claims in its headers, and how the open sockets
// are listed. The claim is display only; "both directions" comes from this side's own probe.

const B = "0b6f2c1e-7c1d-4e53-9d1a-3c1f2e4b5a6d";
const C = "1c7f3d2f-8d2e-4f64-8e2b-4d2f3f5c6b7e";

const claim = (headers: Record<string, string>) => parseMirrorClaim(new Headers(headers));

describe("parseMirrorClaim", () => {
  test("reads what mirrorIdentityHeaders sends, any character in the name", () => {
    const sent = mirrorIdentityHeaders({ instanceId: B, name: "Müllers Mac 🍎" });
    expect(claim(sent)).toEqual({ instanceId: B, name: "Müllers Mac 🍎" });
  });

  test("an older peer sends nothing: both absent", () => {
    expect(claim({})).toEqual({ instanceId: null, name: null });
  });

  test("an ID that is not a UUID is no ID", () => {
    expect(claim({ "x-shepherd-instance-id": "../../etc" }).instanceId).toBeNull();
    expect(claim({ "x-shepherd-instance-id": `${B}x` }).instanceId).toBeNull();
  });

  test("a name is decoded, cleaned of control and format characters, trimmed and capped", () => {
    const name = (raw: string) => claim({ "x-shepherd-instance-name": raw }).name;
    expect(name("%E0%A4%A")).toBeNull(); // malformed escape
    expect(name(encodeURIComponent("  pi\u0000-lab‮​  "))).toBe("pi-lab");
    expect(name(encodeURIComponent(" \u0007 "))).toBeNull();
    expect(name(encodeURIComponent("é".repeat(100)))).toBe("é".repeat(64));
    expect(name("a".repeat(64 * 12 + 1))).toBeNull(); // far beyond any real name: not decoded
  });
});

describe("IncomingMirrors", () => {
  const deps = (connected: string[] = []) => ({
    confirmed: (id: string) => connected.includes(id),
    tokenName: (id: string) => ({ t1: "linux", t2: "pi-lab" })[id] ?? null,
  });

  test("direction: both only when this side's probe confirms the claimed ID", () => {
    const mirrors = new IncomingMirrors();
    mirrors.open({}, { instanceId: B, name: "linux", tokenId: "t1", since: 1 });
    mirrors.open({}, { instanceId: C, name: "pi-lab", tokenId: "t2", since: 2 });
    mirrors.open({}, { instanceId: null, name: null, tokenId: null, since: 3 });
    expect(mirrors.list(deps([B]))).toEqual([
      { instanceId: B, name: "linux", tokenName: "linux", since: 1, direction: "both" },
      { instanceId: C, name: "pi-lab", tokenName: "pi-lab", since: 2, direction: "one" },
      { instanceId: null, name: null, tokenName: null, since: 3, direction: "unknown" },
    ]);
  });

  test("an entry lives as long as its socket; a reconnect overlap is listed once, oldest", () => {
    const mirrors = new IncomingMirrors();
    const old = {};
    const fresh = {};
    mirrors.open(fresh, { instanceId: B, name: "linux", tokenId: "t1", since: 20 });
    mirrors.open(old, { instanceId: B, name: "linux", tokenId: "t1", since: 10 });
    expect(mirrors.list(deps()).map((e) => e.since)).toEqual([10]);
    mirrors.close(old);
    expect(mirrors.list(deps()).map((e) => e.since)).toEqual([20]);
    mirrors.close(fresh);
    expect(mirrors.list(deps())).toEqual([]);
  });

  test("refresh renames only the open entries of the same token and ID", () => {
    const mirrors = new IncomingMirrors();
    mirrors.open({}, { instanceId: B, name: "linux", tokenId: "t1", since: 1 });
    mirrors.open({}, { instanceId: B, name: "linux", tokenId: "t2", since: 2 });
    mirrors.refresh("t1", { instanceId: B, name: "build-box" });
    mirrors.refresh("t1", { instanceId: C, name: "other" });
    mirrors.refresh("t1", { instanceId: B, name: null });
    expect(mirrors.list(deps()).map((e) => e.name)).toEqual(["build-box", "linux"]);
  });
});
