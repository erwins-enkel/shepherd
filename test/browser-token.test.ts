import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BrowserTokenSigner, loadOrCreateBrowserBrokerKey } from "../src/browser-token";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "browser-token-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("browser token: key file is created owner-only and reused", async () => {
  const path = join(tempDir(), "browser-broker.key");
  const first = await loadOrCreateBrowserBrokerKey(path);
  expect(first.length).toBe(32);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const second = await loadOrCreateBrowserBrokerKey(path);
  expect(second.equals(first)).toBe(true);
});

test("browser token: concurrent creators agree on one key", async () => {
  const path = join(tempDir(), "browser-broker.key");
  const keys = await Promise.all(
    Array.from({ length: 8 }, () => loadOrCreateBrowserBrokerKey(path)),
  );
  for (const key of keys) expect(key.equals(keys[0]!)).toBe(true);
  expect(readdirSync(dirname(path))).toEqual(["browser-broker.key"]);
});

test("browser token: wrong-length key file is rejected, not regenerated", async () => {
  const path = join(tempDir(), "browser-broker.key");
  writeFileSync(path, "short");
  await expect(loadOrCreateBrowserBrokerKey(path)).rejects.toThrow(/32 bytes/);
});

test("browser token: sign is deterministic and verify accepts it", () => {
  const signer = new BrowserTokenSigner(Buffer.alloc(32, 7));
  const token = signer.sign("s-1");
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  expect(signer.sign("s-1")).toBe(token);
  expect(signer.verify("s-1", token)).toBe(true);
});

test("browser token: verify rejects other sessions, bad tokens and other keys", () => {
  const signer = new BrowserTokenSigner(Buffer.alloc(32, 7));
  const token = signer.sign("s-1");
  expect(signer.verify("s-2", token)).toBe(false);
  expect(signer.verify("s-1", "")).toBe(false);
  expect(signer.verify("s-1", null)).toBe(false);
  expect(signer.verify("s-1", undefined)).toBe(false);
  expect(signer.verify("s-1", "zz")).toBe(false);
  expect(signer.verify("s-1", token.slice(0, -1))).toBe(false);
  expect(signer.verify("s-1", `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`)).toBe(
    false,
  );
  expect(signer.verify("s-1", "ä".repeat(32))).toBe(false);
  const other = new BrowserTokenSigner(Buffer.alloc(32, 8));
  expect(other.verify("s-1", token)).toBe(false);
});
