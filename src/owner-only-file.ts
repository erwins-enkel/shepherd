/**
 * Read a secret file that must be a regular file accessible by its owner only (0600-style).
 *
 * The checks run on the SAME open handle the content is read from (`fstat` + read via the fd),
 * never `stat(path)` followed by `readFile(path)`: a path-based check-then-read can be raced —
 * the file swapped for another (e.g. a world-readable copy or a different target) between the
 * two calls — so the check would not cover what is actually read (CodeQL js/file-system-race).
 * Symlinks are still followed at open time; the checks then apply to the file actually opened.
 */
import { open } from "node:fs/promises";

export type OwnerOnlyFileProblem = "not-regular" | "group-other-access";

/** The file opened fine but failed a check; I/O errors (ENOENT, EACCES, …) propagate as-is. */
export class OwnerOnlyFileError extends Error {
  readonly problem: OwnerOnlyFileProblem;
  constructor(problem: OwnerOnlyFileProblem) {
    super(problem === "not-regular" ? "not a regular file" : "accessible by group/other");
    this.name = "OwnerOnlyFileError";
    this.problem = problem;
  }
}

export async function readOwnerOnlyFile(path: string): Promise<string> {
  const fh = await open(path, "r");
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new OwnerOnlyFileError("not-regular");
    if (st.mode & 0o077) throw new OwnerOnlyFileError("group-other-access");
    return await fh.readFile("utf8");
  } finally {
    await fh.close();
  }
}
