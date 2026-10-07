import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { link, readFile, unlink, writeFile } from "node:fs/promises";

/** Length in bytes of the persisted Browser Attach signing key. */
const KEY_BYTES = 32;

async function readKey(path: string): Promise<Buffer> {
  const key = await readFile(path);
  if (key.length !== KEY_BYTES)
    throw new Error(`Browser broker key ${path} must be ${KEY_BYTES} bytes, got ${key.length}`);
  return key;
}

function isCode(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === code;
}

/**
 * Reads the Browser Attach signing key, creating it (owner-only) on first use.
 * Race and crash safe: the key is written in full to a private temp file, then hard-linked into
 * place — `link` publishes complete content atomically and fails EEXIST for a concurrent loser,
 * which re-reads the winner's key. Never observable empty or half-written.
 * A key file of the wrong length is an error, never silently regenerated —
 * regenerating would revoke every live agent's baked-in attach URL.
 */
export async function loadOrCreateBrowserBrokerKey(path: string): Promise<Buffer> {
  try {
    return await readKey(path);
  } catch (err) {
    if (!isCode(err, "ENOENT")) throw err;
  }
  const key = randomBytes(KEY_BYTES);
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, key, { mode: 0o600, flag: "wx" });
  try {
    await link(tmp, path);
    return key;
  } catch (err) {
    if (!isCode(err, "EEXIST")) throw err;
    return readKey(path);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

/** Signs and verifies per-session Browser Attach tokens: hex HMAC-SHA256(key, sessionId). */
export class BrowserTokenSigner {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    this.#key = key;
  }

  sign(sessionId: string): string {
    return createHmac("sha256", this.#key).update(sessionId).digest("hex");
  }

  verify(sessionId: string, token: string | null | undefined): boolean {
    if (typeof token !== "string") return false;
    const expected = Buffer.from(this.sign(sessionId), "utf8");
    const given = Buffer.from(token, "utf8");
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
}
