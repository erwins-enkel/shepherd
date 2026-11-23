import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OwnerOnlyFileError, readOwnerOnlyFile } from "../src/owner-only-file";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "owner-only-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const file = (name: string, content: string, mode: number) => {
  const p = join(root, name);
  writeFileSync(p, content);
  chmodSync(p, mode);
  return p;
};

describe("readOwnerOnlyFile", () => {
  test("0600 regular file -> its content", async () => {
    expect(await readOwnerOnlyFile(file("k", "secret\n", 0o600))).toBe("secret\n");
  });

  test("group/other access -> OwnerOnlyFileError(group-other-access)", async () => {
    for (const mode of [0o640, 0o604, 0o644]) {
      const err = await readOwnerOnlyFile(file(`k${mode}`, "x", mode)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OwnerOnlyFileError);
      expect((err as OwnerOnlyFileError).problem).toBe("group-other-access");
    }
  });

  test("directory -> OwnerOnlyFileError(not-regular)", async () => {
    const dir = join(root, "d");
    mkdirSync(dir, { mode: 0o700 });
    const err = await readOwnerOnlyFile(dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OwnerOnlyFileError);
    expect((err as OwnerOnlyFileError).problem).toBe("not-regular");
  });

  test("missing -> the I/O error propagates (not an OwnerOnlyFileError)", async () => {
    const err = await readOwnerOnlyFile(join(root, "nope")).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(OwnerOnlyFileError);
    expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
  });

  test("symlink to a 0600 file -> followed; checks apply to the opened target", async () => {
    const target = file("real", "tok", 0o600);
    const link = join(root, "link");
    symlinkSync(target, link);
    expect(await readOwnerOnlyFile(link)).toBe("tok");
    chmodSync(target, 0o644);
    await expect(readOwnerOnlyFile(link)).rejects.toBeInstanceOf(OwnerOnlyFileError);
  });
});
