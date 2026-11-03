import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loopbackPeerSessionId, loopbackPeerUid, parseProcNetTcpUid } from "../src/peer-uid";

const HEADER =
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
const row = (local: string, rem: string, st: string, uid: number) =>
  `   0: ${local} ${rem} ${st} 00000000:00000000 00:00000000 00000000  ${uid}        0 123 1 0 20 4 30 10 -1`;
const table = (...rows: string[]) => [HEADER, ...rows].join("\n");
// 0x1CA2 = 7330 (server), 0xD431 = 54321 (peer)
const V4_LO = "0100007F"; // 127.0.0.1
const V4_LO2 = "0200007F"; // 127.0.0.2
const V6_LO = "00000000000000000000000001000000";
const V6_MAPPED_LO = "0000000000000000FFFF00000100007F";
const uidOf = (text: string, address = "127.0.0.1") =>
  parseProcNetTcpUid(text, address, 54321, 7330);

test("parseProcNetTcpUid: v4 loopback client row → its uid (the server-side row is skipped)", () => {
  const text = table(
    row(`${V4_LO}:1CA2`, `${V4_LO}:D431`, "01", 1000), // server's own end
    row(`${V4_LO}:D431`, `${V4_LO}:1CA2`, "01", 0), // client end
  );
  expect(uidOf(text)).toBe(0);
  // Bun reports a v4 client of a dual-stack listener as `::ffff:127.0.0.1`.
  expect(uidOf(text, "::ffff:127.0.0.1")).toBe(0);
});

test("parseProcNetTcpUid: v6 ::1 and v4-mapped loopback rows match", () => {
  expect(uidOf(table(row(`${V6_LO}:D431`, `${V6_LO}:1CA2`, "01", 7)), "::1")).toBe(7);
  expect(
    uidOf(table(row(`${V6_MAPPED_LO}:D431`, `${V6_MAPPED_LO}:1CA2`, "01", 8)), "::ffff:127.0.0.1"),
  ).toBe(8);
});

test("parseProcNetTcpUid: a squatter on 127.0.0.2:P never stands in for tailscaled's 127.0.0.1:P", () => {
  const text = table(
    row(`${V4_LO}:D431`, `${V4_LO}:1CA2`, "01", 0), // tailscaled
    row(`${V4_LO2}:D431`, `${V4_LO}:1CA2`, "01", 1000), // attacker, same port
  );
  expect(uidOf(text, "127.0.0.1")).toBe(0);
  expect(uidOf(text, "127.0.0.2")).toBe(1000);
  // Attacker's row gone (RST / half-close) → its peer address matches nothing, never uid 0.
  expect(uidOf(table(row(`${V4_LO}:D431`, `${V4_LO}:1CA2`, "01", 0)), "127.0.0.2")).toBe(null);
});

test("parseProcNetTcpUid: non-loopback, non-established, wrong ports and malformed → null", () => {
  expect(uidOf(table(row("0500A8C0:D431", `${V4_LO}:1CA2`, "01", 0)), "192.168.0.5")).toBe(null);
  expect(uidOf(table(row(`${V4_LO}:D431`, "0500A8C0:1CA2", "01", 0)))).toBe(null);
  expect(uidOf(table(row(`${V4_LO}:D431`, `${V4_LO}:1CA2`, "06", 0)))).toBe(null);
  expect(uidOf(table(row(`${V4_LO}:D431`, `${V4_LO}:1CA3`, "01", 0)))).toBe(null);
  expect(uidOf(table("garbage", "   1: x y 01"))).toBe(null);
  expect(uidOf("")).toBe(null);
});

test("parseProcNetTcpUid: rows for the same endpoint that disagree on the uid → ambiguous", () => {
  const text = table(
    row(`${V4_LO}:D431`, `${V4_LO}:1CA2`, "01", 0),
    row(`${V4_LO}:D431`, `${V4_LO2}:1CA2`, "01", 1000),
  );
  expect(uidOf(text)).toBe("ambiguous");
});

test("loopbackPeerUid: no lookup off Linux → unavailable", async () => {
  expect(await loopbackPeerUid("127.0.0.1", 54321, 7330, "darwin")).toBe("unavailable");
});

test.if(process.platform === "linux")(
  "loopbackPeerUid: a live loopback connection resolves to this process's uid",
  async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req, srv) {
        const ip = srv.requestIP(req)!;
        return Response.json({ uid: await loopbackPeerUid(ip.address, ip.port, srv.port!) });
      },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(await res.json()).toEqual({ uid: process.getuid!() });
    } finally {
      server.stop(true);
    }
  },
);

// ── loopbackPeerSessionId (#3623) ───────────────────────────────────────────

/** A `/proc` tree: net/tcp with one client row (inode 123) and the given processes. */
function procFixture(procs: { pid: number; fds: string[]; environ?: string }[]) {
  const root = mkdtempSync(join(tmpdir(), "peer-session-"));
  mkdirSync(join(root, "net"));
  writeFileSync(join(root, "net/tcp"), table(row(`${V4_LO}:D431`, `${V4_LO}:1CA2`, "01", 1000)));
  writeFileSync(join(root, "net/tcp6"), table());
  for (const { pid, fds, environ } of procs) {
    mkdirSync(join(root, String(pid), "fd"), { recursive: true });
    fds.forEach((target, i) => symlinkSync(target, join(root, String(pid), "fd", String(i))));
    if (environ !== undefined) writeFileSync(join(root, String(pid), "environ"), environ);
  }
  return root;
}
const sessionOf = (procRoot: string, deadlineMs?: number) =>
  loopbackPeerSessionId("127.0.0.1", 54321, 7330, { platform: "linux", procRoot, deadlineMs });

test("loopbackPeerSessionId: the socket's holder's marker names the session", async () => {
  const root = procFixture([
    { pid: 10, fds: ["socket:[999]"], environ: "SHEPHERD_SESSION_ID=other\0" },
    { pid: 11, fds: ["/dev/null", "socket:[123]"], environ: "A=1\0SHEPHERD_SESSION_ID=abc\0B=2\0" },
  ]);
  expect(await sessionOf(root)).toBe("abc");
  rmSync(root, { recursive: true });
});

test("loopbackPeerSessionId: a holder without a marker gives way to a forked one with it", async () => {
  const root = procFixture([
    { pid: 10, fds: ["socket:[123]"], environ: "A=1\0" },
    { pid: 11, fds: ["socket:[123]"], environ: "SHEPHERD_SESSION_ID=abc\0" },
  ]);
  expect(await sessionOf(root)).toBe("abc");
  rmSync(root, { recursive: true });
});

test("loopbackPeerSessionId: no marker, no holder, no row or an unreadable environ → null", async () => {
  const unmarked = procFixture([{ pid: 10, fds: ["socket:[123]"], environ: "A=1\0" }]);
  const unreadable = procFixture([{ pid: 10, fds: ["socket:[123]"] }]);
  const noHolder = procFixture([{ pid: 10, fds: ["/dev/null"], environ: "SHEPHERD_SESSION_ID=x" }]);
  expect(await sessionOf(unmarked)).toBeNull();
  expect(await sessionOf(unreadable)).toBeNull();
  expect(await sessionOf(noHolder)).toBeNull();
  expect(
    await loopbackPeerSessionId("127.0.0.1", 1, 7330, { platform: "linux", procRoot: unmarked }),
  ).toBeNull();
  for (const root of [unmarked, unreadable, noHolder]) rmSync(root, { recursive: true });
});

test("loopbackPeerSessionId: non-Linux and non-loopback peers never touch /proc", async () => {
  const root = procFixture([
    { pid: 10, fds: ["socket:[123]"], environ: "SHEPHERD_SESSION_ID=abc" },
  ]);
  expect(
    await loopbackPeerSessionId("127.0.0.1", 54321, 7330, { platform: "darwin", procRoot: root }),
  ).toBeNull();
  expect(
    await loopbackPeerSessionId("100.64.0.1", 54321, 7330, { platform: "linux", procRoot: root }),
  ).toBeNull();
  rmSync(root, { recursive: true });
});

test("loopbackPeerSessionId: past the deadline it answers null instead of walking on", async () => {
  const root = procFixture([
    { pid: 10, fds: ["socket:[123]"], environ: "SHEPHERD_SESSION_ID=abc" },
  ]);
  expect(await sessionOf(root, -1)).toBeNull();
  rmSync(root, { recursive: true });
});
