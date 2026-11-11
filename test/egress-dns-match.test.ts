/**
 * Real-dnsmasq check of the egress allowlist's name matching (#3923).
 *
 * dnsmasq has no "this name only" match: `--server=/d/` covers `d` and every subdomain.
 * buildEgressConfig makes an entry exact by adding a local-only `--server=/*.d/` blocker, which
 * relies on dnsmasq preferring the more specific `/*.d/` over `/d/` — observed behaviour that its
 * man page words differently. This suite pins it: it loads the GENERATED nft ruleset and dnsmasq
 * argv into a throwaway rootless user+net namespace (no slirp, no uplink), answers upstream
 * queries with a fake resolver on the resolver IP, and checks what resolves and what lands in
 * which nft set.
 *
 * GATED: needs unshare/ip/nft/dnsmasq and rootless user+net namespaces; skipped under CI. It never
 * touches slirp4netns, so the rootless-docker concern of egress-runner.test.ts doesn't apply.
 */

import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildEgressAllowlist, buildEgressConfig } from "../src/egress";

function hostCapable(): boolean {
  for (const t of ["unshare", "ip", "nft", "dnsmasq"]) {
    if (spawnSync("command", ["-v", t], { shell: true }).status !== 0) return false;
  }
  return spawnSync("unshare", ["--user", "--map-root-user", "--net", "true"]).status === 0;
}

const SKIP = !!process.env.CI || !hostCapable();

/** Fake upstream: answers every A query with 1.2.3.<n>, n derived from the name (see ipFor). */
const FAKE_UPSTREAM = `
import dgram from "node:dgram";
const s = dgram.createSocket("udp4");
s.on("message", (msg, rinfo) => {
  let i = 12; const labels = [];
  while (msg[i]) { labels.push(msg.subarray(i + 1, i + 1 + msg[i]).toString()); i += msg[i] + 1; }
  let n = 0; for (const c of labels.join(".")) n = (n * 31 + c.charCodeAt(0)) % 250;
  const hdr = Buffer.from(msg.subarray(0, 12)); hdr[2] = 0x81; hdr[3] = 0x80;
  hdr.writeUInt16BE(1, 6); hdr.writeUInt16BE(0, 8); hdr.writeUInt16BE(0, 10);
  const ans = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 1, 2, 3, n + 1]);
  s.send(Buffer.concat([hdr, msg.subarray(12, i + 5), ans]), rinfo.port, rinfo.address);
});
s.bind(53, "10.0.2.3");
`;

/** Query client: prints one JSON line {name, rcode} per name argument. */
const QUERY = `
import dgram from "node:dgram";
for (const name of process.argv.slice(2)) {
  const q = Buffer.concat([
    Buffer.from([0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
    ...name.split(".").map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])),
    Buffer.from([0, 0, 1, 0, 1]),
  ]);
  const rcode = await new Promise((resolve) => {
    const s = dgram.createSocket("udp4");
    const t = setTimeout(() => { s.close(); resolve(-1); }, 2000);
    s.on("message", (m) => { clearTimeout(t); s.close(); resolve(m[3] & 0xf); });
    s.send(q, 53, "127.0.0.1");
  });
  console.log(JSON.stringify({ name, rcode }));
}
`;

const RUN = `set -u
ip link set lo up
ip link add d0 type dummy && ip addr add 10.0.2.3/32 dev d0 && ip link set d0 up
nft -f "$TMP/egress.nft" || exit 10
"$BUN" "$TMP/fake.ts" & FAKE=$!
dnsmasq $(cat "$TMP/dnsmasq.args") >/dev/null 2>&1 & DNS=$!
sleep 0.7
"$BUN" "$TMP/query.ts" $NAMES
for s in $(nft -j list sets | grep -o '"name": *"allowed[a-z0-9_]*"' | grep -o 'allowed[a-z0-9_]*'); do
  echo "{\\"set\\":\\"$s\\",\\"ips\\":\\"$(nft list set inet egress "$s" | tr -d '\\n\\t ' | grep -o 'elements={[^}]*}' | sed 's/elements={//;s/}//')\\"}"
done
kill $DNS $FAKE
`;

function ipFor(name: string): string {
  let n = 0;
  for (const c of name) n = (n * 31 + c.charCodeAt(0)) % 250;
  return `1.2.3.${n + 1}`;
}

const NOERROR = 0;
const NXDOMAIN = 3;
const REFUSED = 5;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Load the generated config for `allowlist` into a fresh netns, query `names`, and report each
 *  name's rcode plus the IPs pinned into every `allowed*` set. */
function runInNetns(allowlist: string[], names: string[]) {
  const tmp = mkdtempSync(join(tmpdir(), "egress-dns-match-"));
  dirs.push(tmp);
  const cfg = buildEgressConfig(allowlist, { tmpDir: tmp });
  writeFileSync(join(tmp, "egress.nft"), cfg.nftRuleset);
  // No entry contains whitespace (normalizeEgressEntry), so word-splitting in RUN is safe.
  writeFileSync(join(tmp, "dnsmasq.args"), cfg.dnsmasqArgv.join("\n"));
  writeFileSync(join(tmp, "fake.ts"), FAKE_UPSTREAM);
  writeFileSync(join(tmp, "query.ts"), QUERY);
  const r = spawnSync("unshare", ["--user", "--map-root-user", "--net", "bash", "-c", RUN], {
    env: { ...process.env, TMP: tmp, BUN: process.execPath, NAMES: names.join(" ") },
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(r.status).toBe(0);
  const lines = r.stdout
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as { name?: string; rcode?: number; set?: string; ips?: string });
  const rcode = Object.fromEntries(lines.filter((l) => l.name).map((l) => [l.name, l.rcode]));
  const sets = Object.fromEntries(
    lines.filter((l) => l.set).map((l) => [l.set!, (l.ips ? l.ips.split(",") : []).sort()]),
  );
  return { rcode, sets };
}

const ips = (...names: string[]) => names.map(ipFor).sort();

test.skipIf(SKIP)("generated config resolves exact entries only and pins per port", () => {
  const allowlist = buildEgressAllowlist({
    forges: {},
    extraHosts: ["github.io", "*.foo.io", "ssh.example.com:22"],
  });
  const names = [
    "github.com",
    "api.github.com",
    "gist.github.com",
    "a.b.github.com",
    "github.io",
    "evil.github.io",
    "x.foo.io",
    "a.b.foo.io",
    "foo.io",
    "ssh.example.com",
    "example.org",
  ];
  const { rcode, sets } = runInNetns(allowlist, names);

  expect(rcode).toEqual({
    "github.com": NOERROR,
    "api.github.com": NOERROR, // a more specific exact entry beats github.com's *.github.com blocker
    "gist.github.com": NXDOMAIN,
    "a.b.github.com": NXDOMAIN,
    "github.io": NOERROR,
    "evil.github.io": NXDOMAIN,
    "x.foo.io": NOERROR,
    "a.b.foo.io": NOERROR,
    "foo.io": REFUSED, // *.foo.io covers subdomains only
    "ssh.example.com": NOERROR,
    "example.org": REFUSED,
  });

  // Every allowed IP is in exactly the set of its entry's port; blocked names pin nothing.
  expect(sets).toEqual({
    allowed: ips("github.com", "api.github.com", "github.io", "x.foo.io", "a.b.foo.io"),
    allowed_p22: ips("ssh.example.com"),
  });
});

test.skipIf(SKIP)("nested wildcard and exact entries keep every covering entry's reach", () => {
  const allowlist = [
    "*.corp.test",
    "git.corp.test:2222",
    "*.svc.corp.test:22",
    "app.test",
    "*.x.app.test",
  ];
  const names = [
    "corp.test",
    "a.corp.test",
    "git.corp.test",
    "y.git.corp.test",
    "svc.corp.test",
    "z.svc.corp.test",
    "app.test",
    "y.app.test",
    "x.app.test",
    "w.x.app.test",
  ];
  const { rcode, sets } = runInNetns(allowlist, names);

  expect(rcode).toEqual({
    "corp.test": REFUSED,
    "a.corp.test": NOERROR,
    "git.corp.test": NOERROR,
    "y.git.corp.test": NOERROR, // *.corp.test covers it: no *.git.corp.test blocker
    "svc.corp.test": NOERROR,
    "z.svc.corp.test": NOERROR,
    "app.test": NOERROR,
    "y.app.test": NXDOMAIN,
    "x.app.test": NXDOMAIN, // *.x.app.test covers subdomains only
    "w.x.app.test": NOERROR, // the longer wildcard beats app.test's *.app.test blocker
  });

  // An exact or nested-wildcard pin keeps the outer wildcard's 443.
  expect(sets).toEqual({
    allowed: ips(
      "a.corp.test",
      "git.corp.test",
      "y.git.corp.test",
      "svc.corp.test",
      "z.svc.corp.test",
      "app.test",
      "w.x.app.test",
    ),
    allowed_p22: ips("svc.corp.test", "z.svc.corp.test"),
    allowed_p2222: ips("git.corp.test", "y.git.corp.test"),
  });
});
