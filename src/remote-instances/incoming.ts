/**
 * Who mirrors this Shepherd (#3056): the other Shepherds whose `/events?host=local` socket is open
 * here right now — the other half of "each side connects the other on its own". Settings → Machines
 * lists them under "They see your sessions", next to the machines this one mirrors.
 *
 * A peer names itself in two headers (`identity.ts`). What it claims is unverified and for display
 * only: it is length-bounded, stripped of control characters, never logged, and never decides
 * anything. A link counts as running in both directions only when the claimed ID is a machine
 * connected HERE whose latest probe confirmed exactly that ID — this Shepherd's own check, not the
 * peer's word. An entry lives exactly as long as its socket.
 */
import { UUID_RE } from "./client";
import { INSTANCE_NAME_MAX, MIRROR_ID_HEADER, MIRROR_NAME_HEADER } from "./identity";

/** What a peer claims about itself: unverified, for display only. */
export interface MirrorClaim {
  instanceId: string | null;
  name: string | null;
}

/** `both`: confirmed by this Shepherd's own probe. `unknown`: the peer sends no ID (an older
 *  release), so it cannot be told. `one`: anything else. */
export type MirrorDirection = "both" | "one" | "unknown";

/** What `GET /api/remote-instances` lists under `incoming`. */
export interface IncomingMirrorSummary {
  /** Claimed by the peer; null when it sent none or a malformed one. */
  instanceId: string | null;
  /** Claimed by the peer; null when it sent none. */
  name: string | null;
  /** The access token its socket authenticated with; null for `SHEPHERD_TOKEN` or a cookie. */
  tokenName: string | null;
  /** When its socket opened. */
  since: number;
  direction: MirrorDirection;
}

interface Entry extends MirrorClaim {
  tokenId: string | null;
  since: number;
}

/** A percent-encoded code point takes at most 12 characters (4 UTF-8 bytes). */
const RAW_NAME_MAX = INSTANCE_NAME_MAX * 12;

function claimedName(raw: string | null): string | null {
  if (raw === null || raw.length > RAW_NAME_MAX) return null;
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    return null;
  }
  // Control and format characters (bidi overrides, zero-width) never reach a label.
  name = name.replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  return name ? [...name].slice(0, INSTANCE_NAME_MAX).join("") : null;
}

/** A peer's claim from its request headers. Anything malformed reads as absent. */
export function parseMirrorClaim(headers: Headers): MirrorClaim {
  const id = headers.get(MIRROR_ID_HEADER);
  return {
    instanceId: id !== null && UUID_RE.test(id) ? id : null,
    name: claimedName(headers.get(MIRROR_NAME_HEADER)),
  };
}

export class IncomingMirrors {
  private readonly entries = new Map<object, Entry>();

  /** A peer's `?host=local` socket opened; `key` is that socket. */
  open(key: object, entry: Entry): void {
    this.entries.set(key, { ...entry });
  }

  close(key: object): void {
    this.entries.delete(key);
  }

  /** A snapshot request carried the peer's claim: its open sockets under the same token and ID
   *  take the name it sends now, so a rename shows without waiting for a reconnect. */
  refresh(tokenId: string | null, claim: MirrorClaim): void {
    if (claim.instanceId === null || claim.name === null) return;
    for (const entry of this.entries.values()) {
      if (entry.tokenId === tokenId && entry.instanceId === claim.instanceId)
        entry.name = claim.name;
    }
  }

  /**
   * Every open mirror, oldest first. Sockets of the same peer overlap for a moment while it
   * reconnects; those (same token, same claimed ID) are listed once, as the oldest.
   * `confirmed(id)`: whether a machine connected here has that ID, confirmed by its latest probe.
   */
  list(deps: {
    confirmed: (instanceId: string) => boolean;
    tokenName: (tokenId: string) => string | null;
  }): IncomingMirrorSummary[] {
    const byPeer = new Map<string, Entry>();
    for (const entry of this.entries.values()) {
      const peer = `${entry.tokenId ?? ""}|${entry.instanceId ?? ""}`;
      const seen = byPeer.get(peer);
      if (!seen || entry.since < seen.since) byPeer.set(peer, entry);
    }
    return [...byPeer.values()]
      .sort((a, b) => a.since - b.since)
      .map((entry) => ({
        instanceId: entry.instanceId,
        name: entry.name,
        tokenName: entry.tokenId === null ? null : deps.tokenName(entry.tokenId),
        since: entry.since,
        direction:
          entry.instanceId === null ? "unknown" : deps.confirmed(entry.instanceId) ? "both" : "one",
      }));
  }
}
