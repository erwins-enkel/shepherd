import { readFile } from "node:fs/promises";

const TCP_ESTABLISHED = "01";

/** `/proc/net/tcp[6]` hex address → loopback? IPv4 is one little-endian word (`0100007F`); IPv6
 *  is four (`::1` ends `01000000`, `::ffff:127.x` is `…FFFF0000` + a word ending `7F`). */
function isLoopbackHex(hex: string): boolean {
  if (hex.length === 8) return hex.endsWith("7F");
  if (hex.length !== 32 || !hex.startsWith("0000000000000000")) return false;
  const [w2, w3] = [hex.slice(16, 24), hex.slice(24)];
  return (w2 === "00000000" && w3 === "01000000") || (w2 === "FFFF0000" && w3.endsWith("7F"));
}

/** One table row → its uid when it is the client end of loopback `peerPort` → `serverPort`. */
function clientRowUid(line: string, peerPort: number, serverPort: number): number | null {
  const f = line.trim().split(/\s+/);
  if (f.length < 8 || f[3] !== TCP_ESTABLISHED) return null;
  const [localHex = "", localPort = ""] = f[1]!.split(":");
  const remotePort = f[2]!.split(":")[1] ?? "";
  if (parseInt(localPort, 16) !== peerPort || parseInt(remotePort, 16) !== serverPort) return null;
  const uid = Number(f[7]);
  return isLoopbackHex(localHex) && Number.isInteger(uid) ? uid : null;
}

/** Owner UID of the client socket of the loopback connection `peerPort` → `serverPort`, from
 *  `/proc/net/tcp[6]` text: its row has local = peer, remote = our listener. null ⇒ no such row,
 *  "ambiguous" ⇒ several rows that disagree on the UID. */
export function parseProcNetTcpUid(
  text: string,
  peerPort: number,
  serverPort: number,
): number | null | "ambiguous" {
  let uid: number | null = null;
  for (const line of text.split("\n").slice(1)) {
    const rowUid = clientRowUid(line, peerPort, serverPort);
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
    const found = text === null ? null : parseProcNetTcpUid(text, peerPort, serverPort);
    if (found === "ambiguous" || (found !== null && uid !== null && found !== uid)) return null;
    uid = found ?? uid;
  }
  return uid;
}
