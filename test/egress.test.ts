import { test, expect, describe, beforeEach } from "bun:test";
import {
  ANTHROPIC_EGRESS_HOSTS,
  GITHUB_EGRESS_HOSTS,
  buildEgressAllowlist,
  hostMatchesAllowlist,
  buildEgressConfig,
  egressMembraneOverrideFlags,
  detectEgressBackend,
  resetEgressBackendCache,
  detectEgressHostLoopback,
  resetEgressHostLoopbackCache,
  SLIRP_HOST_GATEWAY,
  egressRunnerPath,
  egressTmpDir,
  writeEgressConfigFiles,
  wrapEgress,
  removeEgressTmp,
  sweepEgressTmp,
  type EgressConfig,
  type EgressBackendProbeDeps,
} from "../src/egress";
import type { ForgeMap } from "../src/forge/types";
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  test("github.com with type OMITTED still adds the well-known set (matches kindFor)", () => {
    // A valid forges.json like {"github.com":{"token":"…"}} resolves to github via kindFor
    // even without an explicit type — the allowlist must include the REST/clone/upload hosts
    // so `gh pr create` and clones work under the firewall.
    const forges: ForgeMap = {
      "github.com": { token: "ghp_x" },
    };
    const list = buildEgressAllowlist({ forges });
    expect(list).toContain("github.com");
    expect(list).toContain("api.github.com");
    expect(list).toContain("codeload.github.com");
    expect(list).toContain("objects.githubusercontent.com");
    expect(list).toContain("uploads.github.com");
  });

  test("github.com explicitly typed gitea is NOT treated as github (explicit type wins)", () => {
    const forges: ForgeMap = {
      "github.com": { type: "gitea", baseUrl: "https://github.com" },
    };
    const list = buildEgressAllowlist({ forges });
    expect(list).toContain("github.com");
    expect(list).not.toContain("api.github.com");
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

  test("-d (not -k), --no-resolv, --no-hosts present", () => {
    const { dnsmasqArgv } = config();
    // -d (--no-daemon): the only foreground mode that starts inside the rootless
    // user+net namespace — -k would EPERM on dropping the unmapped "nobody"
    // supplementary group. -d's stderr logging is suppressed by the runner
    // redirecting dnsmasq's stdio to /dev/null, so nothing leaks to the agent PTY.
    expect(dnsmasqArgv).toContain("-d");
    expect(dnsmasqArgv).not.toContain("-k");
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

  test("hostGateway: emits one allow rule after @allowed accept, before ipv6 reject", () => {
    const { nftRuleset } = config({ hostGateway: { ip: SLIRP_HOST_GATEWAY, port: 7330 } });
    expect(nftRuleset).toContain("ip daddr 10.0.2.2 tcp dport 7330 accept");
    const idxRule = nftRuleset.indexOf("ip daddr 10.0.2.2 tcp dport 7330 accept");
    const idxAllowed = nftRuleset.indexOf("ip daddr @allowed accept");
    const idxIpv6 = nftRuleset.indexOf("meta nfproto ipv6 reject");
    expect(idxAllowed).toBeGreaterThan(-1);
    expect(idxRule).toBeGreaterThan(idxAllowed);
    expect(idxRule).toBeLessThan(idxIpv6);
  });

  test("hostGateway absent: ruleset has no host gateway and is byte-identical to no-hostGateway", () => {
    const withGw = config({ hostGateway: { ip: SLIRP_HOST_GATEWAY, port: 7330 } });
    const without = config();
    expect(without.nftRuleset).not.toContain("10.0.2.2");
    // Default config (no hostGateway) must be unchanged vs. an explicitly-omitted one.
    expect(config({}).nftRuleset).toBe(without.nftRuleset);
    expect(withGw.nftRuleset).not.toBe(without.nftRuleset);
  });

  test("hostGateway: invalid port throws a clear error", () => {
    for (const port of [0, -1, 70000, 1.5]) {
      expect(() => config({ hostGateway: { ip: SLIRP_HOST_GATEWAY, port } })).toThrow(
        /invalid hostGateway\.port/,
      );
    }
  });
});

// ── detectEgressHostLoopback ─────────────────────────────────────────────────

describe("detectEgressHostLoopback", () => {
  beforeEach(() => {
    resetEgressHostLoopbackCache();
  });

  test("true for 'slirp4netns version 1.3.3'", () => {
    expect(detectEgressHostLoopback({ versionOutput: () => "slirp4netns version 1.3.3" })).toBe(
      true,
    );
  });

  test("true for exactly the floor '1.0.0'", () => {
    expect(detectEgressHostLoopback({ versionOutput: () => "1.0.0" })).toBe(true);
  });

  test("false for below-floor 'slirp4netns version 0.4.7'", () => {
    expect(detectEgressHostLoopback({ versionOutput: () => "slirp4netns version 0.4.7" })).toBe(
      false,
    );
  });

  test("numeric (not string) comparison: '1.10.0' >= '1.0.0' => true", () => {
    expect(detectEgressHostLoopback({ versionOutput: () => "1.10.0" })).toBe(true);
  });

  test("false for null capture", () => {
    expect(detectEgressHostLoopback({ versionOutput: () => null })).toBe(false);
  });

  test("false for unparseable garbage", () => {
    expect(detectEgressHostLoopback({ versionOutput: () => "no version here" })).toBe(false);
  });

  test("never throws even when versionOutput throws", () => {
    expect(() =>
      detectEgressHostLoopback({
        versionOutput: () => {
          throw new Error("spawn ENOENT");
        },
      }),
    ).not.toThrow();
    resetEgressHostLoopbackCache();
    expect(
      detectEgressHostLoopback({
        versionOutput: () => {
          throw new Error("spawn ENOENT");
        },
      }),
    ).toBe(false);
  });

  test("caches result: second call ignores new deps", () => {
    let calls = 0;
    expect(
      detectEgressHostLoopback({
        versionOutput: () => {
          calls++;
          return "1.3.3";
        },
      }),
    ).toBe(true);
    // Second call with a would-be-false dep still returns the cached true and does not re-probe.
    expect(detectEgressHostLoopback({ versionOutput: () => "0.4.7" })).toBe(true);
    expect(calls).toBe(1);
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

// ── detectEgressBackend ──────────────────────────────────────────────────────

describe("detectEgressBackend", () => {
  // Stable probe dir used by all injected mkdtemp.
  const PROBE_TMP = "/tmp/shepherd-egress-probe-test";
  // Fake runner path that "exists".
  const FAKE_RUNNER = "/fake/scripts/egress-runner.sh";

  /** Build a spy-tracking run function. Calls is an array of [cmd, args[]] pairs. */
  function makeRunSpy(
    exitMap: Record<string, number> = {},
    defaultStatus = 0,
  ): { run: (cmd: string, args: string[]) => { status: number }; calls: [string, string[]][] } {
    const calls: [string, string[]][] = [];
    const run = (cmd: string, args: string[]): { status: number } => {
      calls.push([cmd, [...args]]);
      const status = cmd in exitMap ? (exitMap[cmd] ?? defaultStatus) : defaultStatus;
      return { status };
    };
    return { run, calls };
  }

  /** Minimal passing deps: all tools present, runner returns 0. */
  function passingDeps(runnerExitStatus = 0): EgressBackendProbeDeps {
    const { run } = makeRunSpy({ [FAKE_RUNNER]: runnerExitStatus });
    return {
      run,
      exists: (p: string) => p === FAKE_RUNNER,
      runnerPath: FAKE_RUNNER,
      home: "/home/testuser",
      claudeDir: "/home/testuser/.claude",
      nodeBinReal: "/usr/bin/node",
      writeFile: () => {},
      mkdtemp: () => PROBE_TMP,
      rmdir: () => {},
      isSymlink: () => false,
      realpath: (p: string) => p,
    };
  }

  beforeEach(() => {
    resetEgressBackendCache();
  });

  test("returns 'slirp4netns' when all tools present and runner exits 0", () => {
    const result = detectEgressBackend(passingDeps(0));
    expect(result).toBe("slirp4netns");
  });

  test("returns null when a required tool fails --version", () => {
    // Make 'nft' fail --version; runner should NEVER be called.
    const runnerCalls: string[] = [];
    let mkdtempCalls = 0;
    const deps: EgressBackendProbeDeps = {
      run: (cmd, args) => {
        if (cmd === FAKE_RUNNER) runnerCalls.push(cmd);
        // nft --version returns 1
        if (cmd === "nft" && args[0] === "--version") return { status: 1 };
        return { status: 0 };
      },
      exists: (p) => p === FAKE_RUNNER,
      runnerPath: FAKE_RUNNER,
      home: "/home/testuser",
      claudeDir: "/home/testuser/.claude",
      nodeBinReal: "/usr/bin/node",
      writeFile: () => {},
      mkdtemp: () => {
        mkdtempCalls++;
        return PROBE_TMP;
      },
      rmdir: () => {},
      isSymlink: () => false,
      realpath: (p) => p,
    };
    const result = detectEgressBackend(deps);
    expect(result).toBe(null);
    // Runner must never be invoked when the presence gate fails.
    expect(runnerCalls).toHaveLength(0);
    // Expensive probe (mkdtemp) must be skipped entirely.
    expect(mkdtempCalls).toBe(0);
  });

  test("run throws during --version presence gate: returns null, does not throw, runner never invoked", () => {
    // C2: injected run throws (not returns {status:nonzero}) during tool --version probe.
    let runnerInvoked = false;
    const deps: EgressBackendProbeDeps = {
      run: (cmd) => {
        if (cmd === FAKE_RUNNER) {
          runnerInvoked = true;
          return { status: 0 };
        }
        // throws during the first --version probe
        throw new Error("spawn ENOENT");
      },
      exists: (p) => p === FAKE_RUNNER,
      runnerPath: FAKE_RUNNER,
      home: "/home/testuser",
      claudeDir: "/home/testuser/.claude",
      nodeBinReal: "/usr/bin/node",
      writeFile: () => {},
      mkdtemp: () => PROBE_TMP,
      rmdir: () => {},
      isSymlink: () => false,
      realpath: (p) => p,
    };
    expect(() => detectEgressBackend(deps)).not.toThrow();
    expect(detectEgressBackend(deps)).toBe(null);
    expect(runnerInvoked).toBe(false);
  });

  test("returns null when runner exits nonzero", () => {
    const result = detectEgressBackend(passingDeps(1));
    expect(result).toBe(null);
  });

  test("returns null when runner script does not exist", () => {
    const runnerCalls: string[] = [];
    let mkdtempCalls = 0;
    const deps: EgressBackendProbeDeps = {
      ...passingDeps(0),
      exists: () => false, // runner not found
      run: (cmd) => {
        if (cmd === FAKE_RUNNER) runnerCalls.push(cmd);
        return { status: 0 };
      },
      mkdtemp: () => {
        mkdtempCalls++;
        return PROBE_TMP;
      },
    };
    const result = detectEgressBackend(deps);
    expect(result).toBe(null);
    expect(runnerCalls).toHaveLength(0);
    // Expensive probe (mkdtemp) must be skipped when runner is absent.
    expect(mkdtempCalls).toBe(0);
  });

  test("caches result: second call does not re-run anything", () => {
    const { run, calls } = makeRunSpy({ [FAKE_RUNNER]: 0 });
    const deps: EgressBackendProbeDeps = {
      run,
      exists: (p) => p === FAKE_RUNNER,
      runnerPath: FAKE_RUNNER,
      home: "/home/testuser",
      claudeDir: "/home/testuser/.claude",
      nodeBinReal: "/usr/bin/node",
      writeFile: () => {},
      mkdtemp: () => PROBE_TMP,
      rmdir: () => {},
      isSymlink: () => false,
      realpath: (p) => p,
    };

    const first = detectEgressBackend(deps);
    const callsAfterFirst = calls.length;
    const second = detectEgressBackend(deps);

    expect(first).toBe("slirp4netns");
    expect(second).toBe("slirp4netns");
    // No additional calls on the second invocation.
    expect(calls.length).toBe(callsAfterFirst);
  });

  test("resetEgressBackendCache forces a re-probe", () => {
    const { run, calls } = makeRunSpy({ [FAKE_RUNNER]: 0 });
    const deps: EgressBackendProbeDeps = {
      run,
      exists: (p) => p === FAKE_RUNNER,
      runnerPath: FAKE_RUNNER,
      home: "/home/testuser",
      claudeDir: "/home/testuser/.claude",
      nodeBinReal: "/usr/bin/node",
      writeFile: () => {},
      mkdtemp: () => PROBE_TMP,
      rmdir: () => {},
      isSymlink: () => false,
      realpath: (p) => p,
    };

    detectEgressBackend(deps);
    const callsAfterFirst = calls.length;

    resetEgressBackendCache();
    detectEgressBackend(deps);
    const callsAfterSecond = calls.length;

    // After reset, the probe must have re-run (more calls total).
    expect(callsAfterSecond).toBeGreaterThan(callsAfterFirst);
  });

  test("runner invoked as: <runner> --tmp <dir> -- bwrap <flags> -- /bin/sh -c exit 0", () => {
    const runnerArgvCapture: { cmd: string; args: string[] }[] = [];
    const deps: EgressBackendProbeDeps = {
      run: (cmd, args) => {
        if (cmd === FAKE_RUNNER) runnerArgvCapture.push({ cmd, args: [...args] });
        return { status: 0 };
      },
      exists: (p) => p === FAKE_RUNNER,
      runnerPath: FAKE_RUNNER,
      home: "/home/testuser",
      claudeDir: "/home/testuser/.claude",
      nodeBinReal: "/usr/bin/node",
      writeFile: () => {},
      mkdtemp: () => PROBE_TMP,
      rmdir: () => {},
      isSymlink: () => false,
      realpath: (p) => p,
    };

    detectEgressBackend(deps);

    expect(runnerArgvCapture).toHaveLength(1);
    const captured = runnerArgvCapture[0];
    if (!captured) throw new Error("runner was not invoked");
    const { args } = captured;

    // First two args: --tmp <probeDir>
    expect(args[0]).toBe("--tmp");
    expect(args[1]).toBe(PROBE_TMP);
    // Third arg: --
    expect(args[2]).toBe("--");
    // Inner argv starts with bwrap
    expect(args[3]).toBe("bwrap");

    // Inner argv must contain the egress override flags:
    // --ro-bind <tmpDir>/nsswitch.conf /etc/nsswitch.conf
    // --ro-bind <tmpDir>/resolv.conf /etc/resolv.conf
    expect(args).toContain(`${PROBE_TMP}/nsswitch.conf`);
    expect(args).toContain(`${PROBE_TMP}/resolv.conf`);

    // Tail: -- /bin/sh -c exit 0
    const lastFour = args.slice(-4);
    expect(lastFour).toEqual(["--", "/bin/sh", "-c", "exit 0"]);
  });

  test("runner is never called when missing tool causes early return", () => {
    const runCalls: string[] = [];
    const deps: EgressBackendProbeDeps = {
      run: (cmd) => {
        runCalls.push(cmd);
        // slirp4netns missing
        if (cmd === "slirp4netns") return { status: 127 };
        return { status: 0 };
      },
      exists: (p) => p === FAKE_RUNNER,
      runnerPath: FAKE_RUNNER,
      home: "/home/testuser",
      claudeDir: "/home/testuser/.claude",
      nodeBinReal: "/usr/bin/node",
      writeFile: () => {},
      mkdtemp: () => PROBE_TMP,
      rmdir: () => {},
      isSymlink: () => false,
      realpath: (p) => p,
    };
    detectEgressBackend(deps);
    expect(runCalls).not.toContain(FAKE_RUNNER);
  });

  test("handles thrown exceptions from run gracefully (returns null)", () => {
    const deps: EgressBackendProbeDeps = {
      run: (cmd) => {
        if (cmd === FAKE_RUNNER) throw new Error("unexpected spawn failure");
        return { status: 0 };
      },
      exists: (p) => p === FAKE_RUNNER,
      runnerPath: FAKE_RUNNER,
      home: "/home/testuser",
      claudeDir: "/home/testuser/.claude",
      nodeBinReal: "/usr/bin/node",
      writeFile: () => {},
      mkdtemp: () => PROBE_TMP,
      rmdir: () => {},
      isSymlink: () => false,
      realpath: (p) => p,
    };
    expect(() => detectEgressBackend(deps)).not.toThrow();
    expect(detectEgressBackend(deps)).toBe(null);
  });

  test("rmdir is always called (cleanup even on runner failure)", () => {
    let cleaned = false;
    const deps: EgressBackendProbeDeps = {
      ...passingDeps(1), // runner fails
      rmdir: () => {
        cleaned = true;
      },
    };
    detectEgressBackend(deps);
    expect(cleaned).toBe(true);
  });

  test("rmdir called even when runner throws", () => {
    let cleaned = false;
    const deps: EgressBackendProbeDeps = {
      run: (cmd) => {
        if (cmd === FAKE_RUNNER) throw new Error("crash");
        return { status: 0 };
      },
      exists: (p) => p === FAKE_RUNNER,
      runnerPath: FAKE_RUNNER,
      home: "/home/testuser",
      claudeDir: "/home/testuser/.claude",
      nodeBinReal: "/usr/bin/node",
      writeFile: () => {},
      mkdtemp: () => PROBE_TMP,
      rmdir: () => {
        cleaned = true;
      },
      isSymlink: () => false,
      realpath: (p) => p,
    };
    detectEgressBackend(deps);
    expect(cleaned).toBe(true);
  });
});

// ── spawn orchestration prep ───────────────────────────────────────────────────

describe("egressRunnerPath", () => {
  test("resolves to an absolute scripts/egress-runner.sh that exists", () => {
    const p = egressRunnerPath();
    expect(p.startsWith("/")).toBe(true);
    expect(p.endsWith("/scripts/egress-runner.sh")).toBe(true);
    expect(existsSync(p)).toBe(true);
  });
});

describe("egressTmpDir", () => {
  test("deterministic per-session path under the user runtime dir, off world-writable /tmp", () => {
    const savedXdg = process.env.XDG_RUNTIME_DIR;
    // Pin the base independently (not via shepherdRuntimeDir — that would be tautological)
    // so the assertion actually proves the path left /tmp.
    process.env.XDG_RUNTIME_DIR = "/run/user/9999";
    try {
      const d = egressTmpDir("sess-123");
      expect(d).toBe(join("/run/user/9999", "shepherd", "egress", "sess-123"));
      // The old world-writable location is gone.
      expect(d).not.toBe(join(tmpdir(), "shepherd-egress", "sess-123"));
      expect(egressTmpDir("sess-123")).toBe(d); // stable
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = savedXdg;
    }
  });
});

describe("wrapEgress", () => {
  test("prefixes runner --tmp <dir> -- before the bwrap argv", () => {
    const out = wrapEgress(
      ["bwrap", "--ro-bind", "/usr", "/usr", "--", "claude"],
      "/tmp/x",
      "/run.sh",
    );
    expect(out).toEqual([
      "/run.sh",
      "--tmp",
      "/tmp/x",
      "--",
      "bwrap",
      "--ro-bind",
      "/usr",
      "/usr",
      "--",
      "claude",
    ]);
  });

  test("defaults runnerPath to egressRunnerPath()", () => {
    const out = wrapEgress(["bwrap"], "/tmp/x");
    expect(out[0]).toBe(egressRunnerPath());
  });
});

describe("writeEgressConfigFiles", () => {
  test("creates the dir and writes all four artefacts", () => {
    const dir = mkdtempSync(join(tmpdir(), "egress-write-test-"));
    const target = join(dir, "nested", "sess");
    try {
      const cfg = buildEgressConfig(["api.anthropic.com"], { tmpDir: target });
      writeEgressConfigFiles(target, cfg);
      expect(readFileSync(join(target, "egress.nft"), "utf8")).toBe(cfg.nftRuleset);
      expect(readFileSync(join(target, "dnsmasq.argv"), "utf8")).toBe(cfg.dnsmasqArgv.join("\n"));
      expect(readFileSync(join(target, "resolv.conf"), "utf8")).toBe(cfg.resolvConf);
      expect(readFileSync(join(target, "nsswitch.conf"), "utf8")).toBe(cfg.nsswitchConf);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("removeEgressTmp / sweepEgressTmp", () => {
  test("removeEgressTmp deletes one session dir; missing is a no-op", () => {
    const id = `rm-test-${process.pid}-${Date.now()}`;
    const dir = egressTmpDir(id);
    mkdirSync(dir, { recursive: true });
    expect(existsSync(dir)).toBe(true);
    removeEgressTmp(id);
    expect(existsSync(dir)).toBe(false);
    expect(() => removeEgressTmp(id)).not.toThrow(); // idempotent
  });

  test("sweepEgressTmp removes orphans, preserves live ids", () => {
    const live = `sweep-live-${process.pid}-${Date.now()}`;
    const dead = `sweep-dead-${process.pid}-${Date.now()}`;
    const liveDir = egressTmpDir(live);
    const deadDir = egressTmpDir(dead);
    mkdirSync(liveDir, { recursive: true });
    mkdirSync(deadDir, { recursive: true });
    try {
      sweepEgressTmp([live]);
      expect(existsSync(liveDir)).toBe(true); // live id preserved
      expect(existsSync(deadDir)).toBe(false); // orphan swept
    } finally {
      rmSync(liveDir, { recursive: true, force: true });
      rmSync(deadDir, { recursive: true, force: true });
    }
  });

  test("sweepEgressTmp is a no-op when the root dir is absent", () => {
    // Best-effort: even if the root doesn't exist, no throw.
    expect(() => sweepEgressTmp(["whatever"])).not.toThrow();
  });
});
