import { describe, expect, test } from "bun:test";
import {
  checkDestination,
  cookieMatchesHosts,
  isDeniedAddress,
  resolvePreviewPort,
  type LookupFn,
  type OriginPolicy,
} from "../src/browser-origin-policy";

const DNS: Record<string, string[]> = {
  "app.example.com": ["93.184.216.34", "2606:2800:220:1::1"],
  "internal.example.com": ["192.168.1.10"],
  "rebind.example.com": ["93.184.216.34", "127.0.0.1"],
  "tail.example.com": ["100.101.102.103"],
  "mapped.example.com": ["::ffff:10.0.0.1"],
  "ula.example.com": ["fd12::1"],
};
const lookup: LookupFn = async (host) => {
  const addrs = DNS[host];
  if (!addrs) throw new Error("ENOTFOUND");
  return addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
};

function policy(hosts: string[], previewPort: number | null = 7400): OriginPolicy {
  return { allowedHosts: () => hosts, previewPort: () => previewPort };
}

const ALL = Object.keys(DNS);

describe("checkDestination", () => {
  test("allowlisted public host on 443/80 → the vetted address", async () => {
    expect(await checkDestination(policy(ALL), "app.example.com", 443, lookup)).toEqual({
      allow: true,
      address: "93.184.216.34",
      port: 443,
    });
    expect((await checkDestination(policy(ALL), "APP.example.com.", 80, lookup)).allow).toBe(true);
  });

  test("unlisted host, other ports and failed lookups are denied", async () => {
    expect((await checkDestination(policy([]), "app.example.com", 443, lookup)).allow).toBe(false);
    expect((await checkDestination(policy(ALL), "app.example.com", 8443, lookup)).allow).toBe(
      false,
    );
    expect(
      (await checkDestination(policy(["nx.example.com"]), "nx.example.com", 443, lookup)).allow,
    ).toBe(false);
  });

  test("a listed host resolving anywhere non-public is denied", async () => {
    for (const host of [
      "internal.example.com",
      "rebind.example.com",
      "tail.example.com",
      "mapped.example.com",
      "ula.example.com",
    ])
      expect((await checkDestination(policy(ALL), host, 443, lookup)).allow).toBe(false);
  });

  test("the session's Preview port is the only loopback exception", async () => {
    for (const host of ["localhost", "127.0.0.1", "::1", "[::1]", "::ffff:127.0.0.1"])
      expect(await checkDestination(policy([]), host, 7400, lookup)).toEqual({
        allow: true,
        address: "127.0.0.1",
        port: 7400,
      });
    for (const port of [7330, 7331, 7401, 5173])
      expect((await checkDestination(policy([]), "localhost", port, lookup)).allow).toBe(false);
    expect((await checkDestination(policy([], null), "localhost", 7400, lookup)).allow).toBe(false);
    expect((await checkDestination(policy([]), "127.0.0.2", 7400, lookup)).allow).toBe(false);
    expect((await checkDestination(policy([]), "app.localhost", 7400, lookup)).allow).toBe(false);
  });

  test("the in-netns dev port tunnels to its forwarded host port; other loopback ports stay denied", async () => {
    const asked: number[] = [];
    const p: OriginPolicy = {
      ...policy([]),
      devForward: async (port) => {
        asked.push(port);
        return port === 5173 ? 41234 : null;
      },
    };
    for (const host of ["localhost", "127.0.0.1", "[::1]"])
      expect(await checkDestination(p, host, 5173, lookup)).toEqual({
        allow: true,
        address: "127.0.0.1",
        port: 41234,
      });
    for (const port of [7330, 7331, 7401, 41234])
      expect((await checkDestination(p, "localhost", port, lookup)).allow).toBe(false);
    // The Preview port wins without consulting the forwarder.
    asked.length = 0;
    expect((await checkDestination(p, "localhost", 7400, lookup)).allow).toBe(true);
    expect(asked).toEqual([]);
    // A throwing forwarder denies.
    const broken: OriginPolicy = {
      ...policy([]),
      devForward: () => Promise.reject(new Error("x")),
    };
    expect((await checkDestination(broken, "localhost", 5173, lookup)).allow).toBe(false);
    // Never consulted for non-loopback names.
    asked.length = 0;
    expect((await checkDestination(p, "app.localhost", 5173, lookup)).allow).toBe(false);
    expect(asked).toEqual([]);
  });

  test("IP literals are denied even when public", async () => {
    for (const host of ["93.184.216.34", "10.0.0.1", "169.254.169.254", "0.0.0.0", "fe80::1"])
      expect((await checkDestination(policy(ALL), host, 443, lookup)).allow).toBe(false);
  });
});

describe("isDeniedAddress", () => {
  test("special ranges denied, public allowed", () => {
    for (const a of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.0.1",
      "100.64.0.1",
      "169.254.169.254",
      "0.0.0.0",
      "::",
      "::1",
      "fe80::1",
      "fc00::1",
      "::ffff:192.168.0.1",
      "64:ff9b::a00:1",
      "not-an-ip",
    ])
      expect(isDeniedAddress(a)).toBe(true);
    for (const a of ["93.184.216.34", "2606:2800:220:1::1", "::ffff:8.8.8.8"])
      expect(isDeniedAddress(a)).toBe(false);
  });
});

describe("resolvePreviewPort", () => {
  const base = { rangeBase: 7400, rangeCount: 10, denyPorts: [7330, 7331] };
  test("in-range preview port relaying to a non-Shepherd dev port", () => {
    expect(resolvePreviewPort({ ...base, previewPort: 7403, devPort: 5173 })).toBe(7403);
    expect(resolvePreviewPort({ ...base, previewPort: 7403, devPort: null })).toBe(7403);
  });
  test("out of range, missing, Shepherd port or relay to Shepherd → null", () => {
    expect(resolvePreviewPort({ ...base, previewPort: 7410, devPort: 5173 })).toBeNull();
    expect(resolvePreviewPort({ ...base, previewPort: 7399, devPort: 5173 })).toBeNull();
    expect(resolvePreviewPort({ ...base, previewPort: null, devPort: 5173 })).toBeNull();
    expect(
      resolvePreviewPort({ ...base, rangeBase: 7330, previewPort: 7330, devPort: 5173 }),
    ).toBeNull();
    expect(resolvePreviewPort({ ...base, previewPort: 7403, devPort: 7330 })).toBeNull();
    expect(resolvePreviewPort({ ...base, previewPort: 7403, devPort: 7331 })).toBeNull();
  });
});

describe("cookieMatchesHosts", () => {
  test("exact and parent-domain cookies of allowed hosts", () => {
    expect(cookieMatchesHosts("app.example.com", ["app.example.com"], false)).toBe(true);
    expect(cookieMatchesHosts(".example.com", ["app.example.com"], false)).toBe(true);
    expect(cookieMatchesHosts("other.example.com", ["app.example.com"], false)).toBe(false);
    expect(cookieMatchesHosts("evil-example.com", ["example.com"], false)).toBe(false);
    expect(cookieMatchesHosts("sub.app.example.com", ["app.example.com"], false)).toBe(false);
  });
  test("localhost cookies only when the Preview origin is allowed", () => {
    expect(cookieMatchesHosts("localhost", [], true)).toBe(true);
    expect(cookieMatchesHosts("localhost", [], false)).toBe(false);
  });
});
