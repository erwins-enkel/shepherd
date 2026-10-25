import { readFile } from "node:fs/promises";
import { isLoopbackPeer } from "./operator-auth";

const TCP_ESTABLISHED = "01";

/** One little-endian `/proc/net/tcp` word → dotted IPv4 (`0100007F` → `127.0.0.1`). */
function hexWordToIpv4(word: string): string {
  return [6, 4, 2, 0].map((i) => parseInt(word.slice(i, i + 2), 16)).join(".");
}

/** `/proc/net/tcp[6]` hex address → the loopback address it encodes, normalized like
 *  {@link normalizeAddress} (IPv4 dotted, also for `::ffff:` mapped; `::1`), else null. IPv4 is one
 *  little-endian word; IPv6 is four (`::1` = `…01000000`, mapped = `…FFFF0000` + the IPv4 word). */
function loopbackFromHex(hex: string): string | null {
  let addr: string | null = null;
  if (hex.length === 8) addr = hexWordToIpv4(hex);
  else if (hex.length === 32 && hex.startsWith("0000000000000000")) {
    const [w2, w3] = [hex.slice(16, 24), hex.slice(24)];
    if (w2 === "00000000" && w3 === "01000000") addr = "::1";
    else if (w2 === "FFFF0000") addr = hexWordToIpv4(w3);
  }
  return addr !== null && isLoopbackPeer(addr) ? addr : null;
}

/** A peer address as Bun reports it → the form {@link loopbackFromHex} yields. */
function normalizeAddress(address: string): string {
  return address.toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "");
}

type Endpoint = { address: string; port: number };

/** One table row → its uid when it is the client end of `peer` → our loopback `serverPort`: the
 *  row's local address+port must be exactly the peer's, its remote a loopback address on our port
 *  (#3368 — a socket on 127.0.0.2:P must never stand in for tailscaled's 127.0.0.1:P). */
function clientRowUid(line: string, peer: Endpoint, serverPort: number): number | null {
  const f = line.trim().split(/\s+/);
  if (f.length < 8 || f[3] !== TCP_ESTABLISHED) return null;
  const [localHex = "", localPort = ""] = f[1]!.split(":");
  const [remoteHex = "", remotePort = ""] = f[2]!.split(":");
  if (parseInt(localPort, 16) !== peer.port || parseInt(remotePort, 16) !== serverPort) return null;
  if (loopbackFromHex(localHex) !== peer.address || !loopbackFromHex(remoteHex)) return null;
  const uid = Number(f[7]);
  return Number.isInteger(uid) ? uid : null;
}

/** Owner UID of the client socket of the loopback connection `peerAddress:peerPort` → our
 *  `serverPort`, from `/proc/net/tcp[6]` text. null ⇒ no such row, "ambiguous" ⇒ several rows
 *  that disagree on the UID. */
export function parseProcNetTcpUid(
  text: string,
  peerAddress: string,
  peerPort: number,
  serverPort: number,
): number | null | "ambiguous" {
  const peer = { address: normalizeAddress(peerAddress), port: peerPort };
  let uid: number | null = null;
  for (const line of text.split("\n").slice(1)) {
    const rowUid = clientRowUid(line, peer, serverPort);
    if (rowUid === null) continue;
    if (uid !== null && uid !== rowUid) return "ambiguous";
    uid = rowUid;
  }
  return uid;
}

/** Kernel owner UID of a loopback client socket (#3368) — something a local client cannot forge,
 *  unlike proxy headers. "unavailable" ⇒ this platform has no lookup (non-Linux) or neither table
 *  is readable; null ⇒ no single matching connection (fail closed at the caller). */
export async function loopbackPeerUid(
  peerAddress: string,
  peerPort: number,
  serverPort: number,
  platform: NodeJS.Platform = process.platform,
): Promise<number | null | "unavailable"> {
  if (platform !== "linux") return "unavailable";
  const tables = await Promise.all(
    ["/proc/net/tcp", "/proc/net/tcp6"].map((file) => readFile(file, "utf8").catch(() => null)),
  );
  if (tables.every((t) => t === null)) return "unavailable";
  let uid: number | null = null;
  for (const text of tables) {
    const found =
      text === null ? null : parseProcNetTcpUid(text, peerAddress, peerPort, serverPort);
    if (found === "ambiguous" || (found !== null && uid !== null && found !== uid)) return null;
    uid = found ?? uid;
  }
  return uid;
}
