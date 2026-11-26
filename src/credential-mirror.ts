/**
 * Shepherd-owned mirror of a Claude config dir's OAuth credential, bound into the membrane in place
 * of the host file (#4260).
 *
 * A single-file bwrap bind pins the host file's inode at sandbox start, but host Claude writes
 * `.credentials.json` via tmp + rename, so each unsandboxed refresh makes a new inode. The sandbox
 * kept the old file with the old refresh token, which rotation revokes: "OAuth token revoked".
 * The mirror is a stable inode only Shepherd replaces in place, so every live sandbox sees what
 * this module writes into it. Inside the membrane Claude's rename onto the bind fails and it
 * writes in place too, so a sandbox refresh lands in the mirror; it is copied back to the host.
 *
 * One mirror per claudeDir (shared by all its sandboxes, as the host file was), under the runtime
 * dir with a `source` sidecar so a restarted server keeps syncing mirrors live sandboxes still
 * bind. All I/O is async: this runs on the server's single loop.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config";
import { rewriteInPlace } from "./membrane-state";
import { credentialMirrorPath, credentialMirrorRoot } from "./credential-mirror-path";

const CREDENTIAL_FILE = ".credentials.json";
const SOURCE_FILE = "source";
/** How often registered mirrors are reconciled. Claude's own 401 wait polls for a new token. */
const CREDENTIAL_MIRROR_INTERVAL_MS = 2_000;
/** A real credential file is a few KiB; anything larger is not one. */
const MAX_CREDENTIAL_BYTES = 64 * 1024;

export interface CredentialMirrorDeps {
  /** Mirror root; default {@link credentialMirrorRoot}. */
  root?: () => string;
  /** api-key auth mode masks the credential — no mirror is created. Default reads config. */
  masked?: () => boolean;
  /** Run `fn` every `ms`, returning its canceller; default an unref'd `setInterval`. */
  every?: (fn: () => void, ms: number) => () => void;
  intervalMs?: number;
  log?: (msg: string) => void;
}

interface Entry {
  claudeDir: string;
  mirror: string;
  /** Content last seen equal on both sides (trimmed); null until the first sync. */
  lastSynced: string | null;
  /** stat signatures recorded when both sides were last equal — unchanged ⇒ skip the read. */
  hostSig: string | null;
  mirrorSig: string | null;
  inflight: Promise<void> | null;
  lastError: string | null;
}

interface Cred {
  raw: string;
  expiresAt: number;
}

function everyUnref(fn: () => void, ms: number): () => void {
  const timer = setInterval(fn, ms);
  timer.unref?.();
  return () => clearInterval(timer);
}

async function sig(path: string): Promise<string | null> {
  try {
    const s = await stat(path);
    return `${s.ino}:${s.mtimeMs}:${s.size}`;
  } catch {
    return null;
  }
}

/** The file as a credential, or null when absent, oversized or not (yet) a complete one — an
 *  in-place write caught mid-way reads as invalid and is retried on the next tick. */
async function readCred(path: string): Promise<Cred | null> {
  let raw: string;
  try {
    const buf = await readFile(path);
    if (buf.length > MAX_CREDENTIAL_BYTES) return null;
    raw = buf.toString("utf8").trimEnd();
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as {
      claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown };
    };
    const oauth = parsed?.claudeAiOauth;
    if (!oauth || typeof oauth !== "object" || typeof oauth.accessToken !== "string") return null;
    return { raw, expiresAt: typeof oauth.expiresAt === "number" ? oauth.expiresAt : 0 };
  } catch {
    return null;
  }
}

/** Replace the host file the way Claude does: 0600 tmp in the same dir + rename. */
async function writeHost(path: string, content: string): Promise<void> {
  const tmp = `${path}.shepherd-${randomUUID()}.tmp`;
  await writeFile(tmp, `${content}\n`, { mode: 0o600, flag: "wx" });
  await rename(tmp, path);
}

/** Which side's content both should carry. Only one side changed since the last sync → that one;
 *  both (or no sync yet) → the later `claudeAiOauth.expiresAt`, a tie to the host. */
function pickWinner(host: Cred, mirror: Cred, lastSynced: string | null): "host" | "mirror" {
  const hostChanged = host.raw !== lastSynced;
  const mirrorChanged = mirror.raw !== lastSynced;
  if (hostChanged && !mirrorChanged) return "host";
  if (mirrorChanged && !hostChanged) return "mirror";
  return mirror.expiresAt > host.expiresAt ? "mirror" : "host";
}

export class CredentialMirror {
  private readonly entries = new Map<string, Entry>();
  private cancel: (() => void) | null = null;

  constructor(private readonly deps: CredentialMirrorDeps = {}) {}

  private root(): string {
    return (this.deps.root ?? credentialMirrorRoot)();
  }

  /** Create (if missing), register and sync `claudeDir`'s mirror. No-op in api-key mode or when
   *  the host has no credential. Never throws. */
  async ensure(claudeDir: string): Promise<void> {
    if ((this.deps.masked ?? (() => config.authMode === "api-key"))()) return;
    const host = await readCred(join(claudeDir, CREDENTIAL_FILE));
    if (!host) return;
    const mirror = credentialMirrorPath(claudeDir, this.root());
    const dir = join(mirror, "..");
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(join(dir, SOURCE_FILE), claudeDir, { mode: 0o600 });
      await writeFile(mirror, `${host.raw}\n`, { mode: 0o600, flag: "wx" }).catch((err) => {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      });
    } catch (err) {
      this.log(`[cred-mirror] could not create the mirror for ${claudeDir}: ${String(err)}`);
      return;
    }
    this.register(claudeDir, mirror);
    await this.reconcile(claudeDir);
  }

  /** Boot: register every mirror a live sandbox may still bind, sync them, start the loop. */
  async start(): Promise<void> {
    const root = this.root();
    let ids: string[] = [];
    try {
      ids = await readdir(root);
    } catch {
      // best-effort: no mirror root yet ⇒ nothing to resume syncing
    }
    for (const id of ids) {
      const source = await readFile(join(root, id, SOURCE_FILE), "utf8").catch(
        () => null, // best-effort: a dir without a readable sidecar is not a mirror
      );
      if (source === null) continue;
      const mirror = credentialMirrorPath(source, root);
      if (mirror !== join(root, id, CREDENTIAL_FILE)) continue; // sidecar doesn't match its dir
      this.register(source, mirror);
    }
    await this.reconcileAll();
    this.cancel ??= (this.deps.every ?? everyUnref)(
      () => void this.reconcileAll(),
      this.deps.intervalMs ?? CREDENTIAL_MIRROR_INTERVAL_MS,
    );
  }

  stopAll(): void {
    this.cancel?.();
    this.cancel = null;
  }

  async reconcileAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((d) => this.reconcile(d)));
  }

  /** Sync one registered mirror now (serialized per claudeDir). Never throws. */
  reconcile(claudeDir: string): Promise<void> {
    const e = this.entries.get(claudeDir);
    if (!e) return Promise.resolve();
    const run = (e.inflight ?? Promise.resolve()).then(() => this.reconcileOnce(e));
    e.inflight = run;
    void run.finally(() => {
      if (e.inflight === run) e.inflight = null;
    });
    return run;
  }

  private register(claudeDir: string, mirror: string): void {
    if (this.entries.has(claudeDir)) return;
    this.entries.set(claudeDir, {
      claudeDir,
      mirror,
      lastSynced: null,
      hostSig: null,
      mirrorSig: null,
      inflight: null,
      lastError: null,
    });
  }

  private async reconcileOnce(e: Entry): Promise<void> {
    const hostPath = join(e.claudeDir, CREDENTIAL_FILE);
    try {
      const [hSig, mSig] = await Promise.all([sig(hostPath), sig(e.mirror)]);
      // Host logged out: never resurrect its credential from the mirror. Mirror gone: nothing binds it.
      if (hSig === null || mSig === null) return;
      if (hSig === e.hostSig && mSig === e.mirrorSig) return;
      const [host, mirror] = await Promise.all([readCred(hostPath), readCred(e.mirror)]);
      if (!host || !mirror) return; // partial write — retry next tick
      if (host.raw !== mirror.raw) {
        if (pickWinner(host, mirror, e.lastSynced) === "host") {
          await rewriteInPlace(e.mirror, `${host.raw}\n`);
          e.lastSynced = host.raw;
        } else {
          await writeHost(hostPath, mirror.raw);
          e.lastSynced = mirror.raw;
        }
      } else {
        e.lastSynced = host.raw;
      }
      [e.hostSig, e.mirrorSig] = await Promise.all([sig(hostPath), sig(e.mirror)]);
      e.lastError = null;
    } catch (err) {
      const msg = String(err);
      if (msg !== e.lastError) this.log(`[cred-mirror] sync failed for ${e.claudeDir}: ${msg}`);
      e.lastError = msg;
    }
  }

  private log(msg: string): void {
    (this.deps.log ?? console.warn)(msg);
  }
}
