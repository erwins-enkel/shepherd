// Resolve Sentry stack frames to files in a mapped repo (#2464). A frame path is whatever the
// SDK reported (`app:///src/x.ts`, `webpack://pkg/./src/x.ts`, `/home/ci/work/app/src/x.ts`, …),
// so we try its path suffixes, most specific first, against the repo checkout.

import { stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { SentryFrame } from "./api";

/** Deepest suffix tried — deeper build prefixes than this are not worth a stat each. */
const MAX_SEGMENTS = 8;
/** In-app frames examined per event (innermost first). */
const MAX_FRAMES = 10;

/** Repo-relative candidate paths for a raw frame path, longest (most specific) first.
 *  `[]` for vendored code or a path that climbs mid-way (`src/../..`). */
export function candidatePaths(raw: string): string[] {
  const path = raw
    .replace(/[?#].*$/, "")
    .replace(/^[a-z][a-z0-9+.-]*:\/\/\/?/i, "")
    .replace(/\\/g, "/");
  const segs = path.split("/").filter((s) => s !== "" && s !== "." && s !== "~");
  // Leading `..` is bundler-relative (`app:///../src/x.ts`), not a climb: drop it.
  while (segs[0] === "..") segs.shift();
  if (segs.includes("..") || segs.includes("node_modules")) return [];
  const tail = segs.slice(-MAX_SEGMENTS);
  return tail.map((_, i) => tail.slice(i).join("/"));
}

/** True when `rel` is an existing regular file inside `repo` (never escapes it). */
export async function isRepoFile(repo: string, rel: string): Promise<boolean> {
  const root = resolve(repo);
  const abs = resolve(join(root, rel));
  if (!abs.startsWith(root + sep)) return false;
  try {
    return (await stat(abs)).isFile();
  } catch {
    return false;
  }
}

export type IsFile = (repo: string, rel: string) => Promise<boolean>;

export interface ResolvedFrame {
  /** Repo-relative path of an existing file. */
  path: string;
  lineNo: number | null;
  fn: string | null;
}

/** The first matching repo path for one frame, or null. */
async function resolveOne(repo: string, f: SentryFrame, isFile: IsFile): Promise<string | null> {
  for (const raw of [f.filename, f.absPath]) {
    if (!raw) continue;
    for (const rel of candidatePaths(raw)) {
      if (await isFile(repo, rel)) return rel;
    }
  }
  return null;
}

/** In-app frames (innermost first, ≤ {@link MAX_FRAMES}) that resolve to repo files. */
export async function resolveInAppFrames(
  repo: string,
  frames: SentryFrame[],
  isFile: IsFile = isRepoFile,
): Promise<ResolvedFrame[]> {
  const inApp = frames
    .filter((f) => f.inApp)
    .reverse()
    .slice(0, MAX_FRAMES);
  const out: ResolvedFrame[] = [];
  for (const f of inApp) {
    const path = await resolveOne(repo, f, isFile);
    if (path) out.push({ path, lineNo: f.lineNo, fn: f.function });
  }
  return out;
}
