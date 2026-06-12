import { test, expect, describe } from "bun:test";
import {
  ANTHROPIC_EGRESS_HOSTS,
  GITHUB_EGRESS_HOSTS,
  buildEgressAllowlist,
  hostMatchesAllowlist,
  buildEgressConfig,
  egressMembraneOverrideFlags,
  type EgressConfig,
} from "../src/egress";
import type { ForgeMap } from "../src/forge/types";

// ── helpers ──────────────────────────────────────────────────────────────────

// Use the exported constant — a local copy would drift silently.
const GITHUB_HOSTS = GITHUB_EGRESS_HOSTS;

// ── ANTHROPIC_EGRESS_HOSTS ───────────────────────────────────────────────────

describe("ANTHROPIC_EGRESS_HOSTS", () => {
  test("includes api.anthropic.com", () => {
    expect(ANTHROPIC_EGRESS_HOSTS).toContain("api.anthropic.com");
  });

  test("includes statsig.anthropic.com", () => {
    expect(ANTHROPIC_EGRESS_HOSTS).toContain("statsig.anthropic.com");
  });

  test("is non-empty and read-only array", () => {
    expect(ANTHROPIC_EGRESS_HOSTS.length).toBeGreaterThan(0);
  });
});

// ── buildEgressAllowlist ─────────────────────────────────────────────────────

describe("buildEgressAllowlist", () => {
  test("Anthropic base always present", () => {
    const list = buildEgressAllowlist({ forges: {} });
    for (const h of ANTHROPIC_EGRESS_HOSTS) {
      expect(list).toContain(h);
    }
  });

  test("empty forges => GitHub default set included", () => {
    const list = buildEgressAllowlist({ forges: {} });
    for (const h of GITHUB_HOSTS) {
      expect(list).toContain(h);
    }
  });

  test("github-type forge adds the well-known set + the map key", () => {
    const forges: ForgeMap = {
      "github.com": { type: "github" },
    };
    const list = buildEgressAllowlist({ forges });
    expect(list).toContain("github.com");
    for (const h of GITHUB_HOSTS) {
      expect(list).toContain(h);
    }
  });

  test("gitea forge with baseUrl: key + baseUrl hostname extracted", () => {
    const forges: ForgeMap = {
      "git.example.com": { type: "gitea", baseUrl: "https://git.example.com" },
    };
    const list = buildEgressAllowlist({ forges });
    expect(list).toContain("git.example.com");
    // gitea does NOT add the github well-known set
    expect(list).not.toContain("api.github.com");
  });

  test("gitea baseUrl with different hostname than key: both included", () => {
    const forges: ForgeMap = {
      "git.corp.internal": { type: "gitea", baseUrl: "https://gitea.corp.internal" },
    };
    const list = buildEgressAllowlist({ forges });
    expect(list).toContain("git.corp.internal");
    expect(list).toContain("gitea.corp.internal");
  });

  test("github-type forge with baseUrl: extracts hostname from baseUrl", () => {
    const forges: ForgeMap = {
      "api.mygithub.com": { type: "github", baseUrl: "https://mygithub.com" },
    };
    const list = buildEgressAllowlist({ forges });
    expect(list).toContain("api.mygithub.com");
    expect(list).toContain("mygithub.com");
    // Also adds the well-known set
    expect(list).toContain("api.github.com");
  });

  test("extraHosts appended", () => {
    const list = buildEgressAllowlist({
      forges: {},
      extraHosts: ["custom.example.com", "cdn.myapp.io"],
    });
    expect(list).toContain("custom.example.com");
    expect(list).toContain("cdn.myapp.io");
  });

  test("invalid hosts dropped (empty, no dot, bad chars)", () => {
    const list = buildEgressAllowlist({
      forges: {},
      extraHosts: [
        "", // empty
        "nodot", // no dot
        "bad_chars.com", // underscore not allowed
        "UPPER.COM", // uppercase: normalizes to lower, valid
        "  spaces.com  ", // whitespace trimmed → valid
        "UpperCase.Example.COM", // normalizes to lowercase
      ],
    });
    expect(list).not.toContain("nodot");
    expect(list).not.toContain("bad_chars.com");
    // empty string — just shouldn't be in there
    expect(list.filter((h) => h === "")).toHaveLength(0);
    // uppercase normalizes to lowercase and is valid
    expect(list).toContain("upper.com");
    expect(list).toContain("spaces.com");
    expect(list).toContain("uppercase.example.com");
  });

  test("RFC 1123: leading/trailing-hyphen labels and dot-leading hosts are dropped", () => {
    const list = buildEgressAllowlist({
      forges: {},
      extraHosts: [
        "-foo.com", // leading hyphen in label
        "foo-.com", // trailing hyphen in label
        ".foo.com", // dot-leading host
      ],
    });
    expect(list).not.toContain("-foo.com");
    expect(list).not.toContain("foo-.com");
    expect(list).not.toContain(".foo.com");
  });

  test("deduplication: same host from multiple sources appears once", () => {
    const forges: ForgeMap = {
      "github.com": { type: "github" },
    };
    const list = buildEgressAllowlist({
      forges,
      extraHosts: ["github.com", "api.github.com"],
    });
    const count = (h: string) => list.filter((x) => x === h).length;
    expect(count("github.com")).toBe(1);
    expect(count("api.github.com")).toBe(1);
  });

  test("result is sorted alphabetically", () => {
    const list = buildEgressAllowlist({
      forges: { "github.com": { type: "github" } },
      extraHosts: ["zzz.example.com", "aaa.example.com"],
    });
    const sorted = [...list].sort();
    expect(list).toEqual(sorted);
  });

  test("malformed baseUrl silently skipped", () => {
    const forges: ForgeMap = {
      "git.example.com": { type: "gitea", baseUrl: "not-a-url" },
    };
    // Should not throw, key still included, no garbage host added
    const list = buildEgressAllowlist({ forges });
    expect(list).toContain("git.example.com");
    expect(list.filter((h) => h === "not-a-url")).toHaveLength(0);
  });

  test("multiple forges: only github-typed ones add the well-known set", () => {
    const forges: ForgeMap = {
      "github.com": { type: "github" },
      "git.corp.example.com": { type: "gitea", baseUrl: "https://git.corp.example.com" },
    };
    const list = buildEgressAllowlist({ forges });
    expect(list).toContain("github.com");
    expect(list).toContain("git.corp.example.com");
    // GitHub well-known from github.com entry
    expect(list).toContain("api.github.com");
    // But only once (deduped)
    expect(list.filter((h) => h === "api.github.com")).toHaveLength(1);
  });
});

// ── hostMatchesAllowlist ─────────────────────────────────────────────────────

describe("hostMatchesAllowlist", () => {
  const list = ["anthropic.com", "github.com", "api.example.com"];

  test("exact match returns true", () => {
    expect(hostMatchesAllowlist("anthropic.com", list)).toBe(true);
    expect(hostMatchesAllowlist("github.com", list)).toBe(true);
  });

  test("subdomain match returns true", () => {
    expect(hostMatchesAllowlist("api.anthropic.com", list)).toBe(true);
    expect(hostMatchesAllowlist("statsig.anthropic.com", list)).toBe(true);
    expect(hostMatchesAllowlist("deep.sub.anthropic.com", list)).toBe(true);
  });

  test("non-match returns false", () => {
    expect(hostMatchesAllowlist("evil.com", list)).toBe(false);
    expect(hostMatchesAllowlist("notanthropiccom", list)).toBe(false);
    // Suffix but not a real subdomain (no dot separator)
    expect(hostMatchesAllowlist("notanthropic.com", list)).toBe(false);
  });

  test("exact match on subdomain entry in allowlist", () => {
    expect(hostMatchesAllowlist("api.example.com", list)).toBe(true);
  });

  test("sub-subdomain of subdomain entry", () => {
    expect(hostMatchesAllowlist("v2.api.example.com", list)).toBe(true);
  });

  test("case-insensitive", () => {
    expect(hostMatchesAllowlist("API.ANTHROPIC.COM", list)).toBe(true);
    expect(hostMatchesAllowlist("GITHUB.COM", list)).toBe(true);
  });

  test("empty allowlist => false", () => {
    expect(hostMatchesAllowlist("anthropic.com", [])).toBe(false);
  });
});

// ── buildEgressConfig ────────────────────────────────────────────────────────

describe("buildEgressConfig", () => {
  const allowlist = ["api.anthropic.com", "api.github.com", "github.com"];
  const tmpDir = "/tmp/shepherd-agent-42";

  function config(overrides: Partial<Parameters<typeof buildEgressConfig>[1]> = {}): EgressConfig {
    return buildEgressConfig(allowlist, { tmpDir, ...overrides });
  }

  test("one --server per domain", () => {
    const { dnsmasqArgv } = config();
    const servers = dnsmasqArgv.filter((a) => a.startsWith("--server="));
    expect(servers).toHaveLength(allowlist.length);
    for (const domain of allowlist) {
      expect(servers).toContain(`--server=/${domain}/10.0.2.3`);
    }
  });

  test("one --nftset per domain", () => {
    const { dnsmasqArgv } = config();
    const sets = dnsmasqArgv.filter((a) => a.startsWith("--nftset="));
    expect(sets).toHaveLength(allowlist.length);
    for (const domain of allowlist) {
      expect(sets).toContain(`--nftset=/${domain}/inet#egress#allowed`);
    }
  });

  test("--filter-AAAA present", () => {
    expect(config().dnsmasqArgv).toContain("--filter-AAAA");
  });

  test("default --min-cache-ttl is 600", () => {
    expect(config().dnsmasqArgv).toContain("--min-cache-ttl=600");
  });

  test("custom minCacheTtl overrides default", () => {
    const { dnsmasqArgv } = config({ minCacheTtl: 300 });
    expect(dnsmasqArgv).toContain("--min-cache-ttl=300");
    expect(dnsmasqArgv).not.toContain("--min-cache-ttl=600");
  });

  test("--log-queries present", () => {
    expect(config().dnsmasqArgv).toContain("--log-queries");
  });

  test("--log-facility points into tmpDir", () => {
    const { dnsmasqArgv } = config();
    expect(dnsmasqArgv).toContain(`--log-facility=${tmpDir}/dns.log`);
  });

  test("-d, --no-resolv, --no-hosts present", () => {
    const { dnsmasqArgv } = config();
    expect(dnsmasqArgv).toContain("-d");
    expect(dnsmasqArgv).toContain("--no-resolv");
    expect(dnsmasqArgv).toContain("--no-hosts");
  });

  test("loopback bind flags present", () => {
    const { dnsmasqArgv } = config();
    expect(dnsmasqArgv).toContain("-i");
    expect(dnsmasqArgv[dnsmasqArgv.indexOf("-i") + 1]).toBe("lo");
    expect(dnsmasqArgv).toContain("--bind-interfaces");
  });

  test("nftRuleset contains inet egress table", () => {
    const { nftRuleset } = config();
    expect(nftRuleset).toContain("table inet egress");
  });

  test("nftRuleset has the allowed set with ipv4_addr + timeout", () => {
    const { nftRuleset } = config();
    expect(nftRuleset).toContain("set allowed");
    expect(nftRuleset).toContain("type ipv4_addr");
    expect(nftRuleset).toContain("flags timeout");
  });

  test("nftRuleset default-drop via policy drop", () => {
    const { nftRuleset } = config();
    expect(nftRuleset).toContain("policy drop");
  });

  test("nftRuleset has loopback accept", () => {
    const { nftRuleset } = config();
    expect(nftRuleset).toContain('oifname "lo" accept');
  });

  test("nftRuleset has established,related accept", () => {
    const { nftRuleset } = config();
    expect(nftRuleset).toContain("ct state established,related accept");
  });

  test("nftRuleset references resolver IP for DNS rules", () => {
    const { nftRuleset } = config();
    expect(nftRuleset).toContain("ip daddr 10.0.2.3 udp dport 53 accept");
    expect(nftRuleset).toContain("ip daddr 10.0.2.3 tcp dport 53 accept");
  });

  test("nftRuleset custom resolver IP propagated", () => {
    const { nftRuleset } = config({ resolver: "192.168.100.1" });
    expect(nftRuleset).toContain("ip daddr 192.168.100.1 udp dport 53 accept");
    expect(nftRuleset).toContain("ip daddr 192.168.100.1 tcp dport 53 accept");
  });

  test("nftRuleset has ipv6 reject", () => {
    const { nftRuleset } = config();
    expect(nftRuleset).toContain("meta nfproto ipv6 reject");
  });

  test("nftRuleset has tcp reset reject", () => {
    const { nftRuleset } = config();
    expect(nftRuleset).toContain("meta l4proto tcp reject with tcp reset");
  });

  test("nftRuleset has final catch-all reject", () => {
    const { nftRuleset } = config();
    // bare "reject" must be present
    expect(nftRuleset).toMatch(/^\s*reject\s*$/m);
  });

  test("resolvConf exact content", () => {
    expect(config().resolvConf).toBe("nameserver 127.0.0.1\n");
  });

  test("nsswitchConf exact content", () => {
    expect(config().nsswitchConf).toBe("hosts: files dns\n");
  });

  test("custom resolver changes dnsmasq --server entries", () => {
    const { dnsmasqArgv } = config({ resolver: "1.1.1.1" });
    const servers = dnsmasqArgv.filter((a) => a.startsWith("--server="));
    for (const domain of allowlist) {
      expect(servers).toContain(`--server=/${domain}/1.1.1.1`);
    }
  });

  test("custom nftSet propagated to --nftset entries", () => {
    const { dnsmasqArgv } = config({ nftSet: "ip#myset#addrs" });
    const sets = dnsmasqArgv.filter((a) => a.startsWith("--nftset="));
    for (const domain of allowlist) {
      expect(sets).toContain(`--nftset=/${domain}/ip#myset#addrs`);
    }
  });

  test("empty allowlist => no --server or --nftset entries", () => {
    const { dnsmasqArgv } = buildEgressConfig([], { tmpDir });
    expect(dnsmasqArgv.filter((a) => a.startsWith("--server="))).toHaveLength(0);
    expect(dnsmasqArgv.filter((a) => a.startsWith("--nftset="))).toHaveLength(0);
  });

  test("invalid nftSet throws a clear error", () => {
    expect(() => config({ nftSet: "../../evil; rm -rf /" })).toThrow(/invalid nftSet/);
    expect(() => config({ nftSet: "" })).toThrow(/invalid nftSet/);
  });
});

// ── egressMembraneOverrideFlags ───────────────────────────────────────────────

describe("egressMembraneOverrideFlags", () => {
  const tmpDir = "/tmp/shepherd-agent-99";

  test("always emits nsswitch bind", () => {
    const flags = egressMembraneOverrideFlags(tmpDir, { isSymlink: () => false });
    expect(flags).toContain("--ro-bind");
    expect(flags).toContain(`${tmpDir}/nsswitch.conf`);
    expect(flags).toContain("/etc/nsswitch.conf");
    // nsswitch triple
    const idx = flags.indexOf(`${tmpDir}/nsswitch.conf`);
    expect(idx).toBeGreaterThan(0);
    expect(flags[idx - 1]).toBe("--ro-bind");
    expect(flags[idx + 1]).toBe("/etc/nsswitch.conf");
  });

  test("resolv bind target is /etc/resolv.conf when NOT a symlink", () => {
    const flags = egressMembraneOverrideFlags(tmpDir, {
      isSymlink: () => false,
      realpath: (p) => p,
    });
    const idx = flags.indexOf(`${tmpDir}/resolv.conf`);
    expect(idx).toBeGreaterThan(0);
    expect(flags[idx - 1]).toBe("--ro-bind");
    expect(flags[idx + 1]).toBe("/etc/resolv.conf");
  });

  test("resolv bind target follows realpath when /etc/resolv.conf IS a symlink", () => {
    const fakeRealpath = "/run/systemd/resolve/stub-resolv.conf";
    const flags = egressMembraneOverrideFlags(tmpDir, {
      isSymlink: (p) => p === "/etc/resolv.conf",
      realpath: () => fakeRealpath,
    });
    const idx = flags.indexOf(`${tmpDir}/resolv.conf`);
    expect(idx).toBeGreaterThan(0);
    expect(flags[idx - 1]).toBe("--ro-bind");
    expect(flags[idx + 1]).toBe(fakeRealpath);
  });

  test("isSymlink not invoked for paths other than /etc/resolv.conf", () => {
    const probed: string[] = [];
    egressMembraneOverrideFlags(tmpDir, {
      isSymlink: (p) => {
        probed.push(p);
        return false;
      },
    });
    // Should only probe /etc/resolv.conf
    expect(probed).toContain("/etc/resolv.conf");
    expect(probed.filter((p) => p !== "/etc/resolv.conf")).toHaveLength(0);
  });

  test("result has exactly 6 elements: two --ro-bind triples", () => {
    const flags = egressMembraneOverrideFlags(tmpDir, { isSymlink: () => false });
    expect(flags).toHaveLength(6);
    expect(flags[0]).toBe("--ro-bind");
    expect(flags[3]).toBe("--ro-bind");
  });

  test("realpath dep only called when resolv.conf is a symlink", () => {
    let realpathCalls = 0;
    egressMembraneOverrideFlags(tmpDir, {
      isSymlink: () => false,
      realpath: () => {
        realpathCalls++;
        return "/etc/resolv.conf";
      },
    });
    expect(realpathCalls).toBe(0);
  });

  test("realpath dep called once when resolv.conf IS a symlink", () => {
    let realpathCalls = 0;
    egressMembraneOverrideFlags(tmpDir, {
      isSymlink: () => true,
      realpath: (p) => {
        realpathCalls++;
        return `/resolved${p}`;
      },
    });
    expect(realpathCalls).toBe(1);
  });
});
